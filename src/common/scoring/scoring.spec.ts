import fc from 'fast-check';
import {
  DEFAULT_SCORING_CONFIG as CFG,
  applyTrustEvent,
  reliabilityScore,
  fatigueScore,
  capabilityScore,
  reachFit,
  categoryFit,
  matchScore,
  passesHardFilter,
  isProven,
  newbieGateActive,
  overOfferCount,
  CAPABILITY_WEIGHTS,
  PromoterRole,
} from './scoring';

describe('applyTrustEvent', () => {
  it('applies the asymmetric deltas', () => {
    expect(applyTrustEvent(50, 'ON_TIME_DELIVERY')).toBe(52);
    expect(applyTrustEvent(50, 'LATE_DELIVERY')).toBe(50.5);
    expect(applyTrustEvent(50, 'REJECTED')).toBe(44);
    expect(applyTrustEvent(50, 'NO_SHOW')).toBe(40);
  });

  it('clamps to [0,100]', () => {
    expect(applyTrustEvent(99, 'ON_TIME_DELIVERY')).toBe(100);
    expect(applyTrustEvent(3, 'NO_SHOW')).toBe(0);
    expect(applyTrustEvent(0, 'REJECTED')).toBe(0);
    expect(applyTrustEvent(100, 'ON_TIME_DELIVERY')).toBe(100);
  });

  it('is asymmetric — one rejection outweighs three on-time deliveries', () => {
    let t = 50;
    t = applyTrustEvent(t, 'ON_TIME_DELIVERY');
    t = applyTrustEvent(t, 'ON_TIME_DELIVERY');
    t = applyTrustEvent(t, 'ON_TIME_DELIVERY'); // +6 → 56
    expect(t).toBe(56);
    expect(applyTrustEvent(t, 'REJECTED')).toBe(50); // −6 wipes the gain
  });

  it('property: result always stays within [0,100]', () => {
    const events = ['ON_TIME_DELIVERY', 'LATE_DELIVERY', 'REJECTED', 'NO_SHOW'] as const;
    fc.assert(
      fc.property(fc.double({ min: 0, max: 100, noNaN: true }), fc.constantFrom(...events), (start, ev) => {
        const out = applyTrustEvent(start, ev);
        return out >= 0 && out <= 100;
      }),
    );
  });
});

describe('reliabilityScore', () => {
  it('returns the neutral default with no history', () => {
    expect(reliabilityScore(null, null)).toBe(0.5);
  });

  it('blends 0.6 rolling + 0.4 lifetime', () => {
    expect(reliabilityScore(1, 0.5)).toBeCloseTo(0.6 * 1 + 0.4 * 0.5, 6); // 0.8
    expect(reliabilityScore(0.5, 1)).toBeCloseTo(0.6 * 0.5 + 0.4 * 1, 6); // 0.7
  });

  it('substitutes the missing window with the present one', () => {
    expect(reliabilityScore(0.8, null)).toBeCloseTo(0.8, 6);
    expect(reliabilityScore(null, 0.3)).toBeCloseTo(0.3, 6);
  });

  it('property: always within [0,1] for any rate inputs', () => {
    fc.assert(
      fc.property(
        fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
        fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
        (r, l) => {
          const out = reliabilityScore(r, l);
          return out >= 0 && out <= 1;
        },
      ),
    );
  });
});

describe('fatigueScore', () => {
  it('is the ratio of active to cap, capped at 1', () => {
    expect(fatigueScore(0, 3)).toBe(0);
    expect(fatigueScore(1, 4)).toBeCloseTo(0.25, 6);
    expect(fatigueScore(3, 3)).toBe(1);
    expect(fatigueScore(9, 3)).toBe(1); // over cap saturates
  });

  it('treats zero/negative capacity as fully fatigued', () => {
    expect(fatigueScore(0, 0)).toBe(1);
    expect(fatigueScore(2, -1)).toBe(1);
  });
});

describe('capabilityScore', () => {
  it('weights sum to 1.0 for every role', () => {
    (Object.keys(CAPABILITY_WEIGHTS) as PromoterRole[]).forEach((role) => {
      const total = Object.values(CAPABILITY_WEIGHTS[role]).reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(1, 6);
    });
  });

  it('all factors maxed → 100, none → 0', () => {
    const full = { verifiedReach: 1, postingFrequency: 1, recentPostProof: 1 };
    expect(capabilityScore('DISTRIBUTOR', full)).toBe(100);
    expect(capabilityScore('DISTRIBUTOR', {})).toBe(0);
  });

  it('verified inputs dominate — reach carries half the distributor score', () => {
    expect(capabilityScore('DISTRIBUTOR', { verifiedReach: 1 })).toBe(50);
    expect(capabilityScore('DISTRIBUTOR', { postingFrequency: 1, recentPostProof: 1 })).toBe(50);
  });

  it('clamps stray factor values into range', () => {
    expect(capabilityScore('CREATOR', { ratedSamples: 5, contentBreadth: -3 })).toBe(50);
  });

  it('throws on an unknown role', () => {
    expect(() => capabilityScore('GHOST' as PromoterRole, {})).toThrow();
  });

  it('property: always within [0,100]', () => {
    const roles = Object.keys(CAPABILITY_WEIGHTS) as PromoterRole[];
    fc.assert(
      fc.property(
        fc.constantFrom(...roles),
        fc.dictionary(fc.string(), fc.double({ min: -5, max: 5, noNaN: true })),
        (role, factors) => {
          const out = capabilityScore(role, factors);
          return out >= 0 && out <= 100 && Number.isInteger(out);
        },
      ),
    );
  });
});

describe('reachFit', () => {
  it('peaks at an exact match and decays both directions', () => {
    expect(reachFit(1000, 1000)).toBe(1);
    expect(reachFit(500, 1000)).toBeCloseTo(0.5, 6); // under
    expect(reachFit(2000, 1000)).toBeCloseTo(0.5, 6); // over — same penalty
  });

  it('penalises a huge account for a tiny slot', () => {
    expect(reachFit(50_000, 2000)).toBeCloseTo(0.04, 6);
  });

  it('zero reach or zero need → 0', () => {
    expect(reachFit(0, 1000)).toBe(0);
    expect(reachFit(1000, 0)).toBe(0);
  });

  it('property: symmetric under swap and within [0,1]', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 1, max: 1_000_000 }), (a, b) => {
        const out = reachFit(a, b);
        return out >= 0 && out <= 1 && Math.abs(out - reachFit(b, a)) < 1e-9;
      }),
    );
  });
});

describe('categoryFit', () => {
  it('untargeted campaign fits everyone', () => {
    expect(categoryFit([], [])).toBe(1);
    expect(categoryFit(['fashion'], [])).toBe(1);
  });

  it('fraction of campaign categories the promoter covers', () => {
    expect(categoryFit(['fashion', 'beauty'], ['fashion', 'tech'])).toBeCloseTo(0.5, 6);
    expect(categoryFit(['fashion', 'tech'], ['fashion', 'tech'])).toBe(1);
    expect(categoryFit(['sports'], ['fashion', 'tech'])).toBe(0);
  });

  it('is case/whitespace-insensitive', () => {
    expect(categoryFit([' Fashion '], ['fashion'])).toBe(1);
  });

  it('targeted campaign, promoter has no categories → 0', () => {
    expect(categoryFit([], ['fashion'])).toBe(0);
  });
});

describe('matchScore', () => {
  it('perfect signals, zero fatigue → 1.0', () => {
    expect(
      matchScore({ capability: 100, trust: 100, reliability: 1, reachFit: 1, categoryFit: 1, fatigue: 0 }),
    ).toBeCloseTo(1, 6);
  });

  it('all-zero inputs → 0', () => {
    expect(
      matchScore({ capability: 0, trust: 0, reliability: 0, reachFit: 0, categoryFit: 0, fatigue: 0 }),
    ).toBe(0);
  });

  it('fatigue drags an otherwise-perfect promoter down', () => {
    const base = { capability: 100, trust: 100, reliability: 1, reachFit: 1, categoryFit: 1, fatigue: 0 };
    expect(matchScore({ ...base, fatigue: 1 })).toBeCloseTo(1 - CFG.rank.fatigue, 6); // 0.85
  });

  it('right-sized fit beats a bigger-but-mismatched account, all else equal', () => {
    const common = { capability: 70, trust: 70, reliability: 0.7, categoryFit: 1, fatigue: 0.2 };
    const rightSized = matchScore({ ...common, reachFit: reachFit(2000, 2000) });
    const oversized = matchScore({ ...common, reachFit: reachFit(50_000, 2000) });
    expect(rightSized).toBeGreaterThan(oversized);
  });

  it('property: always within [0,1] for arbitrary inputs', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (capability, trust, reliability, rf, cf, fatigue) => {
          const out = matchScore({ capability, trust, reliability, reachFit: rf, categoryFit: cf, fatigue });
          return out >= 0 && out <= 1;
        },
      ),
    );
  });
});

describe('passesHardFilter', () => {
  const ok = { roleEligible: true, platformMatch: true, status: 'ACTIVE', trust: 50, capability: 50 };

  it('passes a fully-qualified active candidate', () => {
    expect(passesHardFilter(ok)).toBe(true);
  });

  it('rejects on each individual gate', () => {
    expect(passesHardFilter({ ...ok, roleEligible: false })).toBe(false);
    expect(passesHardFilter({ ...ok, platformMatch: false })).toBe(false);
    expect(passesHardFilter({ ...ok, status: 'SUSPENDED' })).toBe(false);
    expect(passesHardFilter({ ...ok, trust: 29 })).toBe(false);
    expect(passesHardFilter({ ...ok, capability: 39 })).toBe(false);
  });

  it('boundary: exactly at the floors passes', () => {
    expect(passesHardFilter({ ...ok, trust: 30, capability: 40 })).toBe(true);
  });
});

describe('isProven', () => {
  it('proven by completed deliveries', () => {
    expect(isProven(1, 0)).toBe(true);
    expect(isProven(0, 0)).toBe(false);
  });
  it('proven by high trust even with no completions', () => {
    expect(isProven(0, 55)).toBe(true);
    expect(isProven(0, 54)).toBe(false);
  });
});

describe('newbieGateActive', () => {
  it('gates when supply is abundant (≥ 3× slots)', () => {
    expect(newbieGateActive(30, 10)).toBe(true); // ratio 3.0
    expect(newbieGateActive(31, 10)).toBe(true);
  });
  it('opens access when supply is tight', () => {
    expect(newbieGateActive(29, 10)).toBe(false); // ratio 2.9
    expect(newbieGateActive(5, 10)).toBe(false);
  });
  it('gates hard when no slots remain', () => {
    expect(newbieGateActive(100, 0)).toBe(true);
  });
});

describe('overOfferCount', () => {
  it('extends ~1.5× the remaining slots, rounded up', () => {
    expect(overOfferCount(10)).toBe(15);
    expect(overOfferCount(1)).toBe(2); // ceil(1.5)
    expect(overOfferCount(3)).toBe(5); // ceil(4.5)
  });
  it('nothing to fill → no offers', () => {
    expect(overOfferCount(0)).toBe(0);
    expect(overOfferCount(-3)).toBe(0);
  });
  it('property: always ≥ slots (never under-offers)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), (n) => overOfferCount(n) >= n),
    );
  });
});

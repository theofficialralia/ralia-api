import { formatNaira, toMoney } from './money';

describe('money', () => {
  describe('formatNaira', () => {
    it.each([
      [0n, '₦0.00'],
      [1n, '₦0.01'],
      [99n, '₦0.99'],
      [100n, '₦1.00'],
      [105n, '₦1.05'],
      [210000n, '₦2,100.00'],
      [100000000n, '₦1,000,000.00'],
      [500000n, '₦5,000.00'],
      [-250050n, '-₦2,500.50'],
    ])('formats %s as %s', (minor, expected) => {
      expect(formatNaira(minor)).toBe(expected);
    });

    it('pads kobo rather than truncating it', () => {
      // ₦1.05 must never render as ₦1.5.
      expect(formatNaira(105n)).toBe('₦1.05');
      expect(formatNaira(150n)).toBe('₦1.50');
    });
  });

  describe('toMoney', () => {
    it('carries the integer and the display string', () => {
      expect(toMoney(210000n)).toEqual({ amount_minor: 210000, amount_display: '₦2,100.00' });
    });

    it('throws rather than silently losing precision beyond safe integers', () => {
      const tooBig = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
      expect(() => toMoney(tooBig)).toThrow(/exceeds safe integer range/);
    });
  });
});

import sharp from 'sharp';
import { hammingDistance, isDuplicate, perceptualHash } from './phash';

/**
 * The point of a *perceptual* hash is that it survives the things a recycled
 * screenshot goes through — re-compression, resizing, a screenshot of a
 * screenshot — while still separating genuinely different images. These tests
 * exercise exactly that, on real encoded images, not on synthetic hash strings.
 */

/** A deterministic, structured test image (gradient + blocks), as PNG. */
async function makeImage(seed: number, width = 400, height = 400): Promise<Buffer> {
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      // Structure that varies with the seed, so different seeds are genuinely
      // different pictures rather than noise.
      const block = Math.floor(x / 50) + Math.floor(y / 50) * seed;
      raw[i] = (x * 2 + seed * 40) % 256;
      raw[i + 1] = (y * 2 + block * 30) % 256;
      raw[i + 2] = (block * 60 + seed * 17) % 256;
    }
  }
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
}

describe('perceptual hash', () => {
  it('produces a 16-character hex hash', async () => {
    const hash = await perceptualHash(await makeImage(1));
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable — the same bytes hash identically', async () => {
    const image = await makeImage(1);
    expect(await perceptualHash(image)).toBe(await perceptualHash(image));
  });

  // ── Survives what a recycled screenshot goes through ─────

  it('survives JPEG re-compression', async () => {
    const original = await makeImage(1);
    const recompressed = await sharp(original).jpeg({ quality: 60 }).toBuffer();

    const distance = hammingDistance(await perceptualHash(original), await perceptualHash(recompressed));
    expect(distance).toBeLessThanOrEqual(5);
    expect(isDuplicate(await perceptualHash(original), await perceptualHash(recompressed))).toBe(true);
  });

  it('survives being resized', async () => {
    const original = await makeImage(1);
    const resized = await sharp(original).resize(200, 200).png().toBuffer();

    expect(isDuplicate(await perceptualHash(original), await perceptualHash(resized))).toBe(true);
  });

  it('survives a format change', async () => {
    const original = await makeImage(2);
    const asWebp = await sharp(original).webp().toBuffer();

    expect(isDuplicate(await perceptualHash(original), await perceptualHash(asWebp))).toBe(true);
  });

  it('survives mild quality loss plus a resize together', async () => {
    // The realistic recycling case: screenshot, sent over WhatsApp, re-saved.
    const original = await makeImage(3);
    const mangled = await sharp(original).resize(320, 320).jpeg({ quality: 70 }).toBuffer();

    expect(isDuplicate(await perceptualHash(original), await perceptualHash(mangled))).toBe(true);
  });

  // ── Still separates different images ─────────────────────

  it('does not collide across genuinely different images', async () => {
    const hashes = await Promise.all([1, 2, 3, 4, 5].map(async (s) => perceptualHash(await makeImage(s))));

    for (let i = 0; i < hashes.length; i++) {
      for (let j = i + 1; j < hashes.length; j++) {
        const distance = hammingDistance(hashes[i]!, hashes[j]!);
        // Comfortably outside the duplicate threshold: if this ever fails, the
        // hash is not discriminating and every promoter would be flagged.
        expect(distance).toBeGreaterThan(5);
        expect(isDuplicate(hashes[i]!, hashes[j]!)).toBe(false);
      }
    }
  });

  it('a cryptographic hash would fail this — the perceptual one must not', async () => {
    // One-pixel change: sha256 would differ completely; the pHash must not.
    const original = await makeImage(1);
    const { data, info } = await sharp(original).raw().toBuffer({ resolveWithObject: true });
    data[0] = data[0]! ^ 0xff;
    const tweaked = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
      .png()
      .toBuffer();

    expect(await perceptualHash(original)).toBe(await perceptualHash(tweaked));
  });

  // ── Hamming distance ─────────────────────────────────────

  describe('hammingDistance', () => {
    it('counts differing bits', () => {
      expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0);
      expect(hammingDistance('0000000000000000', '0000000000000001')).toBe(1);
      expect(hammingDistance('0000000000000000', '000000000000000f')).toBe(4);
      expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    });

    it('refuses to compare hashes of different lengths', () => {
      expect(() => hammingDistance('abc', 'abcd')).toThrow(/different lengths/);
    });
  });
});

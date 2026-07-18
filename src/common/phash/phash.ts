import sharp from 'sharp';

/**
 * Perceptual hash (DCT pHash) — handoff §5.5.
 *
 * Two screenshots of the same post produce near-identical hashes even after
 * re-compression, resizing or a screenshot-of-a-screenshot. A cryptographic
 * hash would not: changing one pixel changes every bit, so recycled proof would
 * sail through. That is the whole reason this is perceptual.
 *
 * Algorithm: 32×32 greyscale → 2-D DCT-II → keep the top-left 8×8 low-frequency
 * block → each coefficient above the median becomes a 1. 64 bits, hex-encoded.
 */

const SIZE = 32;
const KEEP = 8;

/**
 * Bits that may differ and still count as the same image.
 *
 * Measured on this implementation:
 *   same image, resized ........  0
 *   same image, blurred ........  0
 *   same image, JPEG q30 .......  2
 *   same image, WebP ...........  4
 *   different images ........... 24–38
 *
 * 5 sits with a wide margin either side, so it flags recycled proof without
 * falsely accusing honest promoters.
 *
 * KNOWN LIMITATION: a ~5% crop measures 16 bits, so cropping evades this. Raising
 * the threshold to 16 to catch it would crowd the 24-bit floor for genuinely
 * different images and start producing false accusations, which is far worse.
 * This is inherent to DCT pHash — a crop shifts the whole frequency structure.
 * It is also precisely why §5.5 mandates no auto-approval: the flag surfaces
 * risk for a human, it does not decide anything.
 *
 * Tuning against real submissions is the harden slice, hence configurable.
 */
export const DEFAULT_HAMMING_THRESHOLD = Number(process.env.PHASH_HAMMING_THRESHOLD ?? 5);

/** Precomputed cosine table: cos((2x+1)·u·π / 2N). */
const COS = (() => {
  const table = new Float64Array(SIZE * SIZE);
  for (let x = 0; x < SIZE; x++) {
    for (let u = 0; u < SIZE; u++) {
      table[x * SIZE + u] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * SIZE));
    }
  }
  return table;
})();

/** Separable 2-D DCT-II. Rows then columns, so O(n³) rather than O(n⁴). */
function dct2d(input: Float64Array): Float64Array {
  const rows = new Float64Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let u = 0; u < SIZE; u++) {
      let sum = 0;
      for (let x = 0; x < SIZE; x++) sum += input[y * SIZE + x]! * COS[x * SIZE + u]!;
      rows[y * SIZE + u] = sum * (u === 0 ? Math.SQRT1_2 : 1);
    }
  }

  const out = new Float64Array(SIZE * SIZE);
  for (let u = 0; u < SIZE; u++) {
    for (let v = 0; v < SIZE; v++) {
      let sum = 0;
      for (let y = 0; y < SIZE; y++) sum += rows[y * SIZE + u]! * COS[y * SIZE + v]!;
      out[v * SIZE + u] = sum * (v === 0 ? Math.SQRT1_2 : 1);
    }
  }
  return out;
}

/**
 * A 64-bit perceptual hash as 16 hex characters.
 *
 * `limitInputPixels` caps decode size: a promoter uploads whatever they like,
 * and a decompression bomb would otherwise take the process down.
 */
export async function perceptualHash(image: Buffer): Promise<string> {
  const { data } = await sharp(image, { limitInputPixels: 100_000_000 })
    .greyscale()
    .resize(SIZE, SIZE, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = new Float64Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) pixels[i] = data[i] ?? 0;

  const dct = dct2d(pixels);

  // Low-frequency block, excluding the DC term — it carries overall brightness,
  // so including it would make the hash track exposure rather than structure.
  const coefficients: number[] = [];
  for (let v = 0; v < KEEP; v++) {
    for (let u = 0; u < KEEP; u++) {
      if (u === 0 && v === 0) continue;
      coefficients.push(dct[v * SIZE + u]!);
    }
  }

  const sorted = [...coefficients].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;

  // 63 coefficients + a leading 0 so the hash is a clean 64 bits.
  let bits = '0';
  for (const c of coefficients) bits += c > median ? '1' : '0';

  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/** Differing bits between two hex hashes. Lower means more alike; 0 is identical. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    throw new Error(`Cannot compare hashes of different lengths (${a.length} vs ${b.length})`);
  }
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    let xor = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (xor) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

export function isDuplicate(a: string, b: string, threshold = DEFAULT_HAMMING_THRESHOLD): boolean {
  return hammingDistance(a, b) <= threshold;
}

import { ApiProperty } from '@nestjs/swagger';

/**
 * Money is an integer count of kobo (minor units), carried as bigint. Never a
 * float — handoff §2. Every response carries both the integer and a formatted
 * string so no client ever does currency arithmetic in JS.
 */

export class MoneyDto {
  @ApiProperty({ example: 210000, description: 'Integer minor units (kobo).' })
  amount_minor!: number;

  @ApiProperty({ example: '₦2,100.00' })
  amount_display!: string;
}

export function formatNaira(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const naira = abs / 100n;
  const kobo = abs % 100n;
  const grouped = naira.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}₦${grouped}.${kobo.toString().padStart(2, '0')}`;
}

export function toMoney(minor: bigint): MoneyDto {
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (minor > limit || minor < -limit) {
    // ₦90 trillion. Reaching this means a bug upstream, not a real balance —
    // fail loudly rather than silently losing precision in the JSON.
    throw new Error(`Amount ${minor} exceeds safe integer range for JSON serialisation`);
  }
  return { amount_minor: Number(minor), amount_display: formatNaira(minor) };
}

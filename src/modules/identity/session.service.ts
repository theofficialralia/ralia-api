import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TokenPairDto } from './dto/auth.dto';

export type AccessTokenPayload = {
  sub: string;
  roles: Role[];
};

/** Refresh tokens are opaque and stored only as a hash — a leaked DB gives nobody a session. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function ttlToSeconds(ttl: string, fallback: number): number {
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) return fallback;
  const value = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
  return value * multiplier;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  private get accessTtl(): number {
    return ttlToSeconds(process.env.JWT_ACCESS_TTL ?? '15m', 900);
  }

  private get refreshTtl(): number {
    return ttlToSeconds(process.env.JWT_REFRESH_TTL ?? '30d', 2_592_000);
  }

  async issue(userId: string, roles: Role[], userAgent?: string): Promise<TokenPairDto> {
    const accessToken = await this.jwt.signAsync(
      { sub: userId, roles } satisfies AccessTokenPayload,
      { secret: this.accessSecret(), expiresIn: this.accessTtl },
    );

    const refreshToken = randomBytes(48).toString('base64url');
    await this.prisma.session.create({
      data: {
        userId,
        refreshTokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + this.refreshTtl * 1000),
        userAgent: userAgent ?? null,
      },
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: this.accessTtl,
      token_type: 'Bearer',
    };
  }

  /**
   * Rotates the pair. The presented token is revoked as part of the exchange.
   *
   * Presenting an already-revoked token means it leaked and is being replayed —
   * the legitimate holder rotated past it. Every session for that user is killed
   * rather than just refusing this one request.
   */
  async rotate(refreshToken: string, userAgent?: string): Promise<TokenPairDto> {
    const hash = hashToken(refreshToken);
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hash },
      include: { user: { include: { roles: true } } },
    });

    if (!session) throw new UnauthorizedException('Invalid refresh token');

    if (session.revokedAt) {
      this.logger.warn(
        `Revoked refresh token replayed for user ${session.userId}; revoking all their sessions`,
      );
      await this.revokeAllForUser(session.userId);
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (session.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token has expired');
    }

    if (session.user.status === 'SUSPENDED' || session.user.status === 'BANNED') {
      throw new UnauthorizedException('Account is not active');
    }

    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });

    return this.issue(
      session.userId,
      session.user.roles.map((r) => r.role),
      userAgent,
    );
  }

  async revoke(refreshToken: string): Promise<void> {
    const hash = hashToken(refreshToken);
    // updateMany: logging out with an unknown or already-revoked token is a
    // no-op, not an error. The caller wanted to be logged out; they are.
    await this.prisma.session.updateMany({
      where: { refreshTokenHash: hash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private accessSecret(): string {
    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret) throw new Error('JWT_ACCESS_SECRET is not set');
    return secret;
  }
}

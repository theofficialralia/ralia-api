import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { RolesGuard } from './common/auth/roles.guard';
import { CryptoModule } from './common/crypto/crypto.module';
import { IdempotencyGuard } from './common/idempotency/idempotency.guard';
import { PrismaModule } from './common/prisma/prisma.module';
import { RateConfigModule } from './common/rate-config/rate-config.module';
import { StorageModule } from './common/storage/storage.module';
import { HealthController } from './health/health.controller';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { IdentityModule } from './modules/identity/identity.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { MatchingModule } from './modules/matching/matching.module';
import { ProfilesModule } from './modules/profiles/profiles.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    // Structured JSON logs with a request id. Never log bank details, OTPs or
    // tokens — handoff §2; redaction paths are declared here as they appear.
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        genReqId: (req, res) => {
          const existing = req.headers['x-request-id'];
          const id = typeof existing === 'string' && existing.length > 0 ? existing : randomUUID();
          res.setHeader('x-request-id', id);
          return id;
        },
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.body.password',
            'req.body.code',
            'req.body.refresh_token',
            'req.body.accountNumber',
            'req.body.account_number',
            'res.headers["set-cookie"]',
          ],
          censor: '[redacted]',
        },
        transport:
          process.env.NODE_ENV === 'development'
            ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss' } }
            : undefined,
      },
    }),

    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    JwtModule.register({}),

    PrismaModule,
    CryptoModule,
    RateConfigModule,
    StorageModule,
    IdentityModule,
    ProfilesModule,
    CampaignsModule,
    MatchingModule,
    LedgerModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Authenticated by default. A route is only reachable unauthenticated if it
    // says @Public() out loud — forgetting a guard then fails closed.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: IdempotencyGuard },
  ],
})
export class AppModule {}

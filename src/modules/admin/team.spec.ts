import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { AdminCapability, PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { RolesGuard } from '../../common/auth/roles.guard';
import { CryptoModule } from '../../common/crypto/crypto.module';
import { MAILER, MailMessage } from '../../common/mailer/mailer';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateConfigModule } from '../../common/rate-config/rate-config.module';
import { AdminModule } from './admin.module';
import { testPrisma } from '../../../test/test-db';

class CapturingMailer {
  sent: MailMessage[] = [];
  send(message: MailMessage) {
    this.sent.push(message);
    return Promise.resolve();
  }
  lastToken(): string {
    const text = this.sent.at(-1)?.text ?? '';
    return /token=([^\s]+)/.exec(text)?.[1] ?? '';
  }
}

describe('admin — team management (§7 RBAC)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let jwt: JwtService;
  const mailer = new CapturingMailer();
  let seq = 1;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test_access_secret';
    prisma = testPrisma();

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), JwtModule.register({}), PrismaModule, CryptoModule, RateConfigModule, AdminModule],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(MAILER)
      .useValue(mailer)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    mailer.sent.length = 0;
    await prisma.$executeRawUnsafe('TRUNCATE users, user_roles, admin_invites, sessions, audit_log RESTART IDENTITY CASCADE');
  });

  const http = () => request(app.getHttpServer());
  const bearer = (id: string) => ({ Authorization: `Bearer ${jwt.sign({ sub: id, roles: [Role.ADMIN] }, { secret: process.env.JWT_ACCESS_SECRET })}` });

  async function makeAdmin(capabilities: AdminCapability[]): Promise<string> {
    const n = seq++;
    const admin = await prisma.user.create({
      data: { email: `admin${n}@ralia.test`, passwordHash: 'x', status: 'ACTIVE', roles: { create: { role: Role.ADMIN, capabilities } } },
    });
    return admin.id;
  }

  it('invites, emails a link, and the invitee accepts to become an admin', async () => {
    const managerId = await makeAdmin(['MANAGE_TEAM']);

    const inv = await http().post('/admin/team/invites').set(bearer(managerId))
      .send({ email: 'new@ralia.co', capabilities: ['REVIEW_EVIDENCE'] }).expect(201);
    expect(inv.body.email).toBe('new@ralia.co');
    expect(mailer.sent).toHaveLength(1);
    const token = mailer.lastToken();
    expect(token).toBeTruthy();

    const accepted = await http().post('/admin/team/accept').send({ token, password: 'a long enough passphrase' }).expect(200);
    expect(accepted.body.access_token).toBeTruthy();

    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'new@ralia.co' }, include: { roles: true } });
    expect(user.status).toBe('ACTIVE');
    const adminRole = user.roles.find((r) => r.role === Role.ADMIN);
    expect(adminRole?.capabilities).toEqual(['REVIEW_EVIDENCE']);

    // The invite is now consumed.
    const team = await http().get('/admin/team').set(bearer(managerId)).expect(200);
    expect(team.body.pending_invites).toHaveLength(0);
    expect(team.body.admins).toHaveLength(2);
  });

  it('refuses team management without the MANAGE_TEAM capability', async () => {
    const reviewerId = await makeAdmin(['REVIEW_EVIDENCE']);
    await http().post('/admin/team/invites').set(bearer(reviewerId))
      .send({ email: 'x@ralia.co', capabilities: ['REVIEW_EVIDENCE'] }).expect(403);
  });

  it('rejects an expired or unknown accept token', async () => {
    await http().post('/admin/team/accept').send({ token: 'nope', password: 'a long enough passphrase' }).expect(400);
  });

  it('suspends and reactivates a teammate, but never lets you suspend yourself', async () => {
    const managerId = await makeAdmin(['MANAGE_TEAM']);
    const otherId = await makeAdmin(['REVIEW_EVIDENCE']);

    await http().post(`/admin/team/${otherId}/suspend`).set(bearer(managerId)).expect(204);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: otherId } })).status).toBe('SUSPENDED');
    await http().post(`/admin/team/${otherId}/reactivate`).set(bearer(managerId)).expect(204);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: otherId } })).status).toBe('ACTIVE');

    // You cannot lock yourself out.
    await http().post(`/admin/team/${managerId}/suspend`).set(bearer(managerId)).expect(400);
  });

  it('will not strip MANAGE_TEAM from the last person who has it', async () => {
    const soleManagerId = await makeAdmin(['MANAGE_TEAM', 'REVIEW_EVIDENCE']);
    await http().patch(`/admin/team/${soleManagerId}/capabilities`).set(bearer(soleManagerId))
      .send({ capabilities: ['REVIEW_EVIDENCE'] }).expect(403);
  });
});

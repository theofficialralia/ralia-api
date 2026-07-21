import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { CampaignObjective, CampaignStatus, PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { RolesGuard } from '../../common/auth/roles.guard';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ClientsModule } from './clients.module';
import { testPrisma } from '../../../test/test-db';

describe('clients — business profile', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let jwt: JwtService;
  let seq = 0;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test_access_secret';
    prisma = testPrisma();
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), JwtModule.register({}), PrismaModule, ClientsModule],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
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
    await prisma.$executeRawUnsafe(
      'TRUNCATE users, user_roles, client_orgs, campaigns, sessions, accounts, ledger_transactions, ledger_entries, audit_log RESTART IDENTITY CASCADE',
    );
  });

  async function orgId(userId: string): Promise<string> {
    return (await prisma.clientOrg.findFirstOrThrow({ where: { ownerUserId: userId } })).id;
  }
  async function campaign(userId: string, status: CampaignStatus): Promise<string> {
    const c = await prisma.campaign.create({
      data: { clientOrgId: await orgId(userId), name: 'C', objective: CampaignObjective.AWARENESS, destinationUrl: 'https://x.example', status, budgetMinor: 0n, slotsTotal: 1 },
    });
    return c.id;
  }

  const http = () => request(app.getHttpServer());
  const bearer = (id: string, roles: Role[]) => ({ Authorization: `Bearer ${jwt.sign({ sub: id, roles }, { secret: process.env.JWT_ACCESS_SECRET })}` });

  async function makeClient(): Promise<string> {
    const n = seq++;
    const user = await prisma.user.create({ data: { email: `c${n}@x.com`, phoneE164: `+23480${String(n).padStart(9, '0')}`, passwordHash: 'x', status: 'ACTIVE', roles: { create: { role: Role.CLIENT } } } });
    await prisma.clientOrg.create({ data: { ownerUserId: user.id, name: `Org${n}`, industry: 'Tech', phoneWhatsapp: '+2348010000000' } });
    return user.id;
  }

  it('returns the business profile with the account email', async () => {
    const id = await makeClient();
    const res = await http().get('/clients/me').set(bearer(id, [Role.CLIENT])).expect(200);
    expect(res.body.name).toMatch(/^Org/);
    expect(res.body.email).toMatch(/@x\.com$/);
    expect(res.body.industry).toBe('Tech');
    expect(res.body.website).toBeNull();
  });

  it('updates only the fields sent', async () => {
    const id = await makeClient();
    const res = await http().patch('/clients/me').set(bearer(id, [Role.CLIENT]))
      .send({ website: 'instagram.com/skinsmith', cac_number: 'RC 1234567', description: 'We make serum.' }).expect(200);
    expect(res.body.website).toBe('instagram.com/skinsmith');
    expect(res.body.cac_number).toBe('RC 1234567');
    expect(res.body.description).toBe('We make serum.');
    // Untouched fields survive.
    expect(res.body.industry).toBe('Tech');

    const after = await http().get('/clients/me').set(bearer(id, [Role.CLIENT])).expect(200);
    expect(after.body.website).toBe('instagram.com/skinsmith');
  });

  it('rejects unknown fields and a bad phone', async () => {
    const id = await makeClient();
    await http().patch('/clients/me').set(bearer(id, [Role.CLIENT])).send({ status: 'ACTIVE' }).expect(400);
    await http().patch('/clients/me').set(bearer(id, [Role.CLIENT])).send({ phone_whatsapp: 'not-a-phone!!' }).expect(400);
  });

  it('is client-only and requires auth', async () => {
    await makeClient();
    await http().get('/clients/me').expect(401);
    // A genuine promoter (the guard reads the DB role, not the token claim).
    const promoter = await prisma.user.create({ data: { email: `pr${seq++}@x.com`, phoneE164: `+23488${String(seq).padStart(9, '0')}`, passwordHash: 'x', status: 'ACTIVE', roles: { create: { role: Role.PROMOTER } } } });
    await http().get('/clients/me').set(bearer(promoter.id, [Role.PROMOTER])).expect(403);
  });

  // ── Delete account (erasure) ─────────────────────────────

  it('anonymises the account, cancels drafts, and locks out the token', async () => {
    const id = await makeClient();
    const draft = await campaign(id, CampaignStatus.DRAFT);
    await prisma.session.create({ data: { userId: id, refreshTokenHash: `h${id}`, expiresAt: new Date(Date.now() + 1e7) } });

    await http().delete('/clients/me').set(bearer(id, [Role.CLIENT])).expect(204);

    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(user.deletedAt).not.toBeNull();
    expect(user.email).toMatch(/@deleted\.local$/);
    expect(user.email).not.toMatch(/@x\.com$/);

    const org = await prisma.clientOrg.findFirstOrThrow({ where: { id: await orgId(id) } });
    expect(org.name).toBe('Deleted business');

    // The draft is cancelled; the row survives (ledger references stay intact).
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: draft } })).status).toBe(CampaignStatus.CANCELLED);
    // Sessions revoked.
    expect(await prisma.session.count({ where: { userId: id, revokedAt: null } })).toBe(0);
    // Audit row written.
    expect(await prisma.auditLog.count({ where: { action: 'client.account.delete' } })).toBe(1);

    // The same token no longer authenticates (the guard rejects deletedAt).
    await http().get('/clients/me').set(bearer(id, [Role.CLIENT])).expect(401);
  });

  it('refuses to delete while a campaign is still live', async () => {
    const id = await makeClient();
    await campaign(id, CampaignStatus.LIVE);
    await http().delete('/clients/me').set(bearer(id, [Role.CLIENT])).expect(409);
    // Nothing was anonymised.
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).deletedAt).toBeNull();
  });
});

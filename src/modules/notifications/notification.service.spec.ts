import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { NotificationEmailStatus, PrismaClient, Role } from '@prisma/client';
import { MAILER, Mailer, MailMessage } from '../../common/mailer/mailer';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationService } from './notification.service';
import { testPrisma } from '../../../test/test-db';

/** Controllable stub: records sends, optionally fails a set number of times first. */
class FakeMailer implements Mailer {
  readonly name = 'fake';
  sent: MailMessage[] = [];
  failuresLeft = 0;
  async send(message: MailMessage): Promise<void> {
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error('smtp unavailable');
    }
    this.sent.push(message);
  }
}

describe('NotificationService (N-1)', () => {
  let prisma: PrismaClient;
  let service: NotificationService;
  let mailer: FakeMailer;
  let seq = 0;

  beforeAll(async () => {
    prisma = testPrisma();
    mailer = new FakeMailer();
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
      providers: [NotificationService, { provide: MAILER, useValue: mailer }],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    service = moduleRef.get(NotificationService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE notifications, users RESTART IDENTITY CASCADE');
    mailer.sent = [];
    mailer.failuresLeft = 0;
  });

  async function makeUser(): Promise<string> {
    const u = await prisma.user.create({
      data: { email: `n${seq++}@a.co`, phoneE164: `+23493${String(seq).padStart(8, '0')}`, passwordHash: 'x', status: 'ACTIVE', roles: { create: { role: Role.PROMOTER } } },
    });
    return u.id;
  }

  it('persists a notification, PENDING by default', async () => {
    const userId = await makeUser();
    await service.create({ userId, type: 'offer.created', title: 'New offer', body: 'You have an offer.' });

    const n = await prisma.notification.findFirstOrThrow({ where: { userId } });
    expect(n.type).toBe('offer.created');
    expect(n.emailStatus).toBe(NotificationEmailStatus.PENDING);
    expect(n.readAt).toBeNull();
  });

  it('is idempotent on dedupeKey — a second create is silently ignored', async () => {
    const userId = await makeUser();
    const key = `offer.created:${userId}:abc`;
    await service.create({ userId, type: 'offer.created', title: 'A', body: 'A', dedupeKey: key });
    await service.create({ userId, type: 'offer.created', title: 'A', body: 'A', dedupeKey: key });

    expect(await prisma.notification.count({ where: { userId } })).toBe(1);
  });

  it('email:false is stored SKIPPED and never dispatched', async () => {
    const userId = await makeUser();
    await service.create({ userId, type: 'info', title: 'x', body: 'y', email: false });

    const result = await service.dispatchPending(new Date());
    expect(result.sent).toBe(0);
    expect(mailer.sent).toHaveLength(0);
    expect((await prisma.notification.findFirstOrThrow({ where: { userId } })).emailStatus).toBe(NotificationEmailStatus.SKIPPED);
  });

  it('dispatchPending emails the backlog and marks it SENT', async () => {
    const userId = await makeUser();
    await service.create({ userId, type: 'offer.created', title: 'New offer', body: 'Body.' });

    const result = await service.dispatchPending(new Date());
    expect(result.sent).toBe(1);
    expect(mailer.sent[0]?.subject).toBe('New offer');

    const n = await prisma.notification.findFirstOrThrow({ where: { userId } });
    expect(n.emailStatus).toBe(NotificationEmailStatus.SENT);
    expect(n.emailedAt).not.toBeNull();
    expect(n.emailAttempts).toBe(1);
  });

  it('renders multi-paragraph bodies as separate blocks and adds the type’s CTA', async () => {
    const userId = await makeUser();
    await service.create({ userId, type: 'welcome.client', title: 'Welcome to Ralia!', body: 'First para.\n\nSecond para.' });

    await service.dispatchPending(new Date());
    const sent = mailer.sent[0]!;
    expect(sent.subject).toBe('Welcome to Ralia!');
    // Both paragraphs made it into the HTML as distinct blocks.
    expect(sent.html).toContain('First para.');
    expect(sent.html).toContain('Second para.');
    // The welcome.client CTA points at the client app's new-campaign screen.
    expect(sent.text).toContain('Create your first campaign');
    expect(sent.text).toMatch(/\/campaigns\/new/);
  });

  it('retries on failure and gives up as FAILED after the attempt cap', async () => {
    const userId = await makeUser();
    await service.create({ userId, type: 'offer.created', title: 'New offer', body: 'Body.' });

    mailer.failuresLeft = 99; // always fail

    await service.dispatchPending(new Date());
    let n = await prisma.notification.findFirstOrThrow({ where: { userId } });
    expect(n.emailStatus).toBe(NotificationEmailStatus.PENDING); // stays retryable
    expect(n.emailAttempts).toBe(1);
    expect(n.emailError).toContain('smtp');

    await service.dispatchPending(new Date());
    await service.dispatchPending(new Date());
    n = await prisma.notification.findFirstOrThrow({ where: { userId } });
    expect(n.emailStatus).toBe(NotificationEmailStatus.FAILED); // 3 attempts exhausted
    expect(n.emailAttempts).toBe(3);
  });

  it('a recovered transport sends a previously-failed notification', async () => {
    const userId = await makeUser();
    await service.create({ userId, type: 'offer.created', title: 'New offer', body: 'Body.' });

    mailer.failuresLeft = 1; // fail once, then succeed
    await service.dispatchPending(new Date()); // fails → PENDING, attempts 1
    const after = await service.dispatchPending(new Date()); // succeeds

    expect(after.sent).toBe(1);
    expect((await prisma.notification.findFirstOrThrow({ where: { userId } })).emailStatus).toBe(NotificationEmailStatus.SENT);
  });

  describe('read model', () => {
    it('lists newest-first with the unread count', async () => {
      const userId = await makeUser();
      await service.create({ userId, type: 'a', title: 'First', body: '1' });
      await service.create({ userId, type: 'b', title: 'Second', body: '2' });

      const { items, unread } = await service.list(userId);
      expect(items.map((i) => i.title)).toEqual(['Second', 'First']); // desc by createdAt
      expect(unread).toBe(2);
      expect(items[0]?.read).toBe(false);
    });

    it('markRead clears one and is scoped to the owner', async () => {
      const a = await makeUser();
      const b = await makeUser();
      await service.create({ userId: a, type: 'x', title: 'A-note', body: '.' });
      await service.create({ userId: b, type: 'x', title: 'B-note', body: '.' });
      const aNote = await prisma.notification.findFirstOrThrow({ where: { userId: a } });
      const bNote = await prisma.notification.findFirstOrThrow({ where: { userId: b } });

      // A tries to mark B's notification — the userId scope means nothing changes.
      await service.markRead(a, bNote.id, new Date());
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: bNote.id } })).readAt).toBeNull();

      await service.markRead(a, aNote.id, new Date());
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: aNote.id } })).readAt).not.toBeNull();
      expect(await service.unreadCount(a)).toBe(0);
      expect(await service.unreadCount(b)).toBe(1);
    });

    it('markAllRead clears every unread one and reports the count', async () => {
      const userId = await makeUser();
      await service.create({ userId, type: 'a', title: '1', body: '.' });
      await service.create({ userId, type: 'b', title: '2', body: '.' });

      expect(await service.markAllRead(userId, new Date())).toBe(2);
      expect(await service.unreadCount(userId)).toBe(0);
      expect(await service.markAllRead(userId, new Date())).toBe(0); // idempotent
    });
  });
});

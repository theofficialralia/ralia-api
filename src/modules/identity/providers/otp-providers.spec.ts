import { OtpPurpose } from '@prisma/client';
import { Mailer, MailMessage } from '../../../common/mailer/mailer';
import { EmailOtpProvider } from './email-otp.provider';
import { MultiOtpProvider } from './multi-otp.provider';
import { OtpProvider, OtpRecipient } from './otp-provider';

class FakeMailer implements Mailer {
  readonly name = 'fake';
  sent: MailMessage[] = [];
  async send(m: MailMessage): Promise<void> {
    this.sent.push(m);
  }
}

const recipient = (over: Partial<OtpRecipient> = {}): OtpRecipient => ({ phone: '+2348012345678', email: 'p@x.com', ...over });

describe('EmailOtpProvider', () => {
  it('emails the code to the recipient with the code in the subject', async () => {
    const mailer = new FakeMailer();
    await new EmailOtpProvider(mailer).send(recipient(), '123456', OtpPurpose.PHONE_VERIFY);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe('p@x.com');
    expect(mailer.sent[0]!.subject).toContain('123456');
    expect(mailer.sent[0]!.text).toContain('123456');
  });

  it('skips (no throw) when the recipient has no email', async () => {
    const mailer = new FakeMailer();
    await new EmailOtpProvider(mailer).send(recipient({ email: null }), '123456', OtpPurpose.LOGIN);
    expect(mailer.sent).toHaveLength(0);
  });
});

describe('MultiOtpProvider', () => {
  const stub = (name: string, fail = false): OtpProvider => ({
    name,
    send: fail ? async () => { throw new Error(`${name} down`); } : async () => {},
  });

  it('fans out to every channel', async () => {
    const calls: string[] = [];
    const track = (name: string): OtpProvider => ({ name, send: async () => { calls.push(name); } });
    await new MultiOtpProvider([track('email'), track('whatsapp')]).send(recipient(), '1', OtpPurpose.LOGIN);
    expect(calls.sort()).toEqual(['email', 'whatsapp']);
  });

  it('succeeds if at least one channel delivers', async () => {
    await expect(new MultiOtpProvider([stub('email'), stub('whatsapp', true)]).send(recipient(), '1', OtpPurpose.LOGIN)).resolves.toBeUndefined();
  });

  it('throws only when every channel fails', async () => {
    await expect(new MultiOtpProvider([stub('email', true), stub('whatsapp', true)]).send(recipient(), '1', OtpPurpose.LOGIN)).rejects.toThrow();
  });
});

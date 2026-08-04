import { ResendMailer } from './resend.mailer';

describe('ResendMailer', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('POSTs to the Resend API with auth header and message body', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    global.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '' } as Response;
    }) as typeof fetch;

    const mailer = new ResendMailer('re_test_key', 'Ralia <no-reply@ralia.app>');
    await mailer.send({ to: 'p@x.com', subject: 'New offer', text: 'You have an offer.' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer re_test_key');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toMatchObject({ from: 'Ralia <no-reply@ralia.app>', to: 'p@x.com', subject: 'New offer', text: 'You have an offer.' });
    expect(body.html).toBeUndefined(); // omitted when not provided
  });

  it('throws on a non-2xx response so the dispatch sweep retries', async () => {
    global.fetch = (async () => ({ ok: false, status: 422, text: async () => 'invalid from' }) as Response) as typeof fetch;

    const mailer = new ResendMailer('re_test_key', 'Ralia <no-reply@ralia.app>');
    await expect(mailer.send({ to: 'p@x.com', subject: 's', text: 't' })).rejects.toThrow(/422/);
  });
});

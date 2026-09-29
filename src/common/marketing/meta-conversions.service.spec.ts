import { createHash } from 'node:crypto';
import { MetaConversionsService } from './meta-conversions.service';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

describe('MetaConversionsService', () => {
  const OLD_ENV = process.env;

  afterEach(() => {
    process.env = OLD_ENV;
    jest.restoreAllMocks();
  });

  function withEnv(env: Record<string, string | undefined>): MetaConversionsService {
    process.env = { ...OLD_ENV, ...env };
    return new MetaConversionsService();
  }

  it('is a no-op and never calls fetch when unconfigured', async () => {
    const svc = withEnv({ META_DATASET_ID: undefined, META_CAPI_ACCESS_TOKEN: undefined });
    const fetchMock = jest.spyOn(global, 'fetch' as never).mockResolvedValue({ ok: true, text: async () => '' } as never);
    expect(svc.configured).toBe(false);
    await svc.send({ eventName: 'Purchase', eventId: 'e1', user: { email: 'a@b.com' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hashes PII, leaves ip/ua/fbp/fbc in the clear, and posts to the dataset endpoint', async () => {
    const svc = withEnv({ META_DATASET_ID: '1831543587845464', META_CAPI_ACCESS_TOKEN: 'secret-token', META_GRAPH_VERSION: 'v17.0' });
    let captured: { url: string; body: any } = { url: '', body: null };
    jest.spyOn(global, 'fetch' as never).mockImplementation((async (url: string, init: any) => {
      captured = { url, body: JSON.parse(init.body) };
      return { ok: true, text: async () => 'ok' } as never;
    }) as never);

    await svc.send({
      eventName: 'Purchase',
      eventId: 'evt-123',
      eventSourceUrl: 'https://app.ralia.co/pay',
      user: {
        email: '  Test@Ralia.CO ',
        phone: '+234 (0) 803-111-2222',
        externalId: 'user-9',
        clientIpAddress: '102.89.1.2',
        clientUserAgent: 'Mozilla/5.0',
        fbp: 'fb.1.123.456',
        fbc: 'fb.1.123.click',
      },
      customData: { currency: 'NGN', value: 5000 },
    });

    // Token rides in the query string, never in the body.
    expect(captured.url).toBe('https://graph.facebook.com/v17.0/1831543587845464/events?access_token=secret-token');
    const ev = captured.body.data[0];
    expect(ev.event_name).toBe('Purchase');
    expect(ev.event_id).toBe('evt-123');
    expect(ev.action_source).toBe('website');
    expect(ev.event_source_url).toBe('https://app.ralia.co/pay');
    // Email lower-cased + trimmed before hashing; phone reduced to digits.
    expect(ev.user_data.em).toEqual([sha256('test@ralia.co')]);
    expect(ev.user_data.ph).toEqual([sha256('23408031112222')]);
    expect(ev.user_data.external_id).toEqual([sha256('user-9')]);
    // Not hashed:
    expect(ev.user_data.client_ip_address).toBe('102.89.1.2');
    expect(ev.user_data.client_user_agent).toBe('Mozilla/5.0');
    expect(ev.user_data.fbp).toBe('fb.1.123.456');
    expect(ev.user_data.fbc).toBe('fb.1.123.click');
    expect(ev.custom_data).toEqual({ currency: 'NGN', value: 5000 });
    // Raw email must not appear anywhere in the payload.
    expect(JSON.stringify(captured.body)).not.toContain('test@ralia.co');
  });

  it('includes a test_event_code when set', async () => {
    const svc = withEnv({ META_DATASET_ID: 'ds', META_CAPI_ACCESS_TOKEN: 'tok', META_TEST_EVENT_CODE: 'TEST123' });
    let body: any = null;
    jest.spyOn(global, 'fetch' as never).mockImplementation((async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      return { ok: true, text: async () => 'ok' } as never;
    }) as never);
    await svc.send({ eventName: 'Purchase', eventId: 'e', user: {} });
    expect(body.test_event_code).toBe('TEST123');
  });

  it('never throws when the API returns an error', async () => {
    const svc = withEnv({ META_DATASET_ID: 'ds', META_CAPI_ACCESS_TOKEN: 'tok' });
    jest.spyOn(global, 'fetch' as never).mockResolvedValue({ ok: false, status: 400, text: async () => 'bad' } as never);
    await expect(svc.send({ eventName: 'Purchase', eventId: 'e', user: {} })).resolves.toBeUndefined();
  });

  it('never throws when fetch rejects', async () => {
    const svc = withEnv({ META_DATASET_ID: 'ds', META_CAPI_ACCESS_TOKEN: 'tok' });
    jest.spyOn(global, 'fetch' as never).mockRejectedValue(new Error('network down') as never);
    await expect(svc.send({ eventName: 'Purchase', eventId: 'e', user: {} })).resolves.toBeUndefined();
  });
});

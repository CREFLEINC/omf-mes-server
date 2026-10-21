import { ZaloStub, startZaloStub } from '../../../test/support/zalo-stub';
import { ZaloClient } from './zalo-client';

const ACCESS = 'access-token-SECRET-1';
const SECRET = 'app-secret-SECRET-2';
const REFRESH = 'refresh-token-SECRET-3';
const MESSAGE = { phone: '84912345678', templateId: 'TPL-1', templateData: { wo_no: 'WO-1' }, trackingId: 'zd-7' };

describe('ZaloClient (대역)', () => {
  let stub: ZaloStub;
  let client: ZaloClient;

  beforeAll(async () => {
    stub = await startZaloStub();
    client = new ZaloClient({ apiBaseUrl: stub.url, oauthBaseUrl: stub.url, timeoutMs: 300 });
  });
  afterEach(() => stub.reset());
  afterAll(() => stub.close());

  it('SC-009 발송은 POST {base}/message/template · 헤더 access_token · JSON phone·template_id·template_data·tracking_id', async () => {
    const result = await client.sendTemplate(ACCESS, MESSAGE);

    expect(result).toEqual({ ok: true, msgId: expect.stringMatching(/^stub-msg-/) });
    const [sent] = stub.requests;
    expect(sent).toMatchObject({ method: 'POST', path: '/message/template' });
    expect(sent.headers.access_token).toBe(ACCESS);
    expect(sent.headers['content-type']).toBe('application/json');
    expect(JSON.parse(sent.body)).toEqual({ phone: '84912345678', template_id: 'TPL-1', template_data: { wo_no: 'WO-1' }, tracking_id: 'zd-7' });
  });

  it('SC-009 갱신은 POST {oauth}/v4/oa/access_token · form refresh_token·app_id·grant_type · 헤더 secret_key', async () => {
    const result = await client.refresh('APP-1', SECRET, REFRESH);

    expect(result).toMatchObject({ ok: true, accessToken: expect.any(String), refreshToken: expect.any(String), expiresInSec: 90000 });
    const [sent] = stub.requests;
    expect(sent).toMatchObject({ method: 'POST', path: '/v4/oa/access_token' });
    expect(sent.headers.secret_key).toBe(SECRET);
    expect(sent.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(sent.body))).toEqual({ refresh_token: REFRESH, app_id: 'APP-1', grant_type: 'refresh_token' });
  });

  it('Zalo 오류는 error·message 만 돌려주고 5xx·네트워크·시간 초과는 내부 코드다', async () => {
    stub.queue({ send: ['phone-invalid', 'http500'] });
    expect(await client.sendTemplate(ACCESS, MESSAGE)).toEqual({ ok: false, code: '-108', message: 'Phone number is invalid' });
    expect(await client.sendTemplate(ACCESS, MESSAGE)).toEqual({ ok: false, code: 'HTTP_500', message: 'HTTP 500' });

    stub.queue({ delayMs: 1000 });
    expect(await client.sendTemplate(ACCESS, MESSAGE)).toEqual({ ok: false, code: 'NETWORK', message: '응답 시간 초과' });
    stub.queue({ delayMs: 0 });

    const closed = new ZaloClient({ apiBaseUrl: 'http://127.0.0.1:9', oauthBaseUrl: 'http://127.0.0.1:9', timeoutMs: 300 });
    expect(await closed.sendTemplate(ACCESS, MESSAGE)).toMatchObject({ ok: false, code: 'NETWORK' });
  });

  it('갱신 실패는 transient 로 «토큰 무효»와 «일시 장애»를 가른다', async () => {
    stub.queue({ refresh: ['refresh-fail', 'http500'] });
    expect(await client.refresh('APP-1', SECRET, REFRESH)).toEqual({ ok: false, code: '-14014', message: 'Invalid refresh token', transient: false });
    expect(await client.refresh('APP-1', SECRET, REFRESH)).toMatchObject({ ok: false, code: 'HTTP_500', transient: true });
  });

  it('SC-008 오류 결과에 토큰·비밀 키 문자열이 없다', async () => {
    stub.queue({ send: ['token-invalid', 'http500'], refresh: ['refresh-fail'] });
    const results = [
      await client.sendTemplate(ACCESS, MESSAGE),
      await client.sendTemplate(ACCESS, MESSAGE),
      await client.refresh('APP-1', SECRET, REFRESH),
    ];
    expect(JSON.stringify(results)).not.toMatch(/SECRET/);
  });

  it('기본 타임아웃은 10초다', () => {
    const calls: RequestInit[] = [];
    const spy = new ZaloClient({ apiBaseUrl: 'http://x', oauthBaseUrl: 'http://x' }, (async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response(JSON.stringify({ error: 0, data: { msg_id: '1' } }));
    }) as typeof fetch);
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    return spy.sendTemplate(ACCESS, MESSAGE).then(() => {
      expect(timeout).toHaveBeenCalledWith(10_000);
      timeout.mockRestore();
    });
  });
});

/**
 * Zalo 테스트 대역 — 실제 Zalo 로 보내지 않고 발송·토큰 갱신을 흉내 낸다(research R-16).
 *
 * - `POST /message/template` · `POST /v4/oa/access_token` — 받은 요청을 기록하고 시나리오대로 답한다.
 * - `GET /_requests` 기록 · `POST /_reset` 기록·시나리오 비움 · `POST /_scenario` 다음 응답 줄 세우기.
 *   `{ "send": ["token-invalid", "ok"], "refresh": ["refresh-fail"], "delayMs": 0 }` — 줄이 비면 `ok`.
 * - 실제 앱 확인: `pnpm zalo:stub`(포트 3990) 뒤 서버 env `ZALO_API_BASE_URL`·`ZALO_OAUTH_BASE_URL` 을 대역으로.
 */
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { AddressInfo } from 'node:net';

export type SendScenario = 'ok' | 'token-invalid' | 'phone-invalid' | 'night' | 'quota' | 'http500' | 'config' | 'unknown-negative';
export type RefreshScenario = 'ok' | 'refresh-fail' | 'http500';

export interface StubRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface ZaloStub {
  url: string;
  requests: StubRequest[];
  queue(scenario: { send?: SendScenario[]; refresh?: RefreshScenario[]; delayMs?: number }): void;
  reset(): void;
  close(): Promise<void>;
}

const SEND_ERRORS: Record<Exclude<SendScenario, 'ok' | 'http500'>, [number, string]> = {
  'token-invalid': [-124, 'Access token is invalid'],
  'phone-invalid': [-108, 'Phone number is invalid'],
  night: [-133, 'Sending is not allowed at night'],
  quota: [-144, 'Daily quota exceeded'],
  config: [-109, 'Template is invalid'],
  'unknown-negative': [-999, 'Unknown error'],
};

export async function startZaloStub(port = 0): Promise<ZaloStub> {
  const requests: StubRequest[] = [];
  let sends: SendScenario[] = [];
  let refreshes: RefreshScenario[] = [];
  let delayMs = 0;
  let sequence = 0;

  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const path = (req.url ?? '').split('?')[0];
      handle(req.method ?? '', path, req.headers, body, res).catch((error: unknown) =>
        reply(res, 400, { message: error instanceof Error ? error.message : String(error) }),
      );
    });
  });

  async function handle(method: string, path: string, headers: StubRequest['headers'], body: string, res: ServerResponse) {
    if (path === '/_requests') return reply(res, 200, requests);
    if (path === '/_reset') {
      stub.reset();
      return reply(res, 200, {});
    }
    if (path === '/_scenario') {
      stub.queue(JSON.parse(body || '{}'));
      return reply(res, 200, {});
    }
    requests.push({ method, path, headers, body });
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    sequence += 1;
    if (method === 'POST' && path === '/message/template') {
      const scenario = sends.shift() ?? 'ok';
      if (scenario === 'http500') return reply(res, 500, { message: 'internal' });
      if (scenario === 'ok') {
        return reply(res, 200, {
          error: 0,
          message: 'Success',
          data: { msg_id: `stub-msg-${sequence}`, sent_time: String(Date.now()), quota: { dailyQuota: '500', remainingQuota: '499' } },
        });
      }
      const [error, message] = SEND_ERRORS[scenario];
      return reply(res, 200, { error, message });
    }
    if (method === 'POST' && path === '/v4/oa/access_token') {
      const scenario = refreshes.shift() ?? 'ok';
      if (scenario === 'http500') return reply(res, 500, { message: 'internal' });
      if (scenario === 'refresh-fail') {
        return reply(res, 200, { error: -14014, error_name: 'invalid_grant', error_description: 'Invalid refresh token' });
      }
      return reply(res, 200, { access_token: `stub-access-${sequence}`, refresh_token: `stub-refresh-${sequence}`, expires_in: '90000' });
    }
    return reply(res, 404, { message: 'not found' });
  }

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const stub: ZaloStub = {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    queue(scenario) {
      sends = [...sends, ...(scenario.send ?? [])];
      refreshes = [...refreshes, ...(scenario.refresh ?? [])];
      if (scenario.delayMs !== undefined) delayMs = scenario.delayMs;
    },
    reset() {
      requests.length = 0;
      sends = [];
      refreshes = [];
      delayMs = 0;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
  return stub;
}

if (require.main === module) {
  const port = Number(process.env.ZALO_STUB_PORT) || 3990;
  void startZaloStub(port).then((stub) => {
    process.stdout.write(`Zalo 테스트 대역: ${stub.url} — GET /_requests · POST /_reset · POST /_scenario\n`);
  });
}

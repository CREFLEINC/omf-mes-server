/** 발송 결과. ⛔ 오류에는 Zalo 의 `error`·`message` 만 싣는다 — 본문·헤더(토큰)를 남기지 않는다(SC-008). */
export type ZaloSendResult = { ok: true; msgId: string } | { ok: false; code: string; message: string };

export type ZaloRefreshResult =
  | { ok: true; accessToken: string; refreshToken: string; expiresInSec: number }
  | { ok: false; code: string; message: string; transient: boolean };

export interface ZaloTemplateMessage {
  phone: string;
  templateId: string;
  templateData: Record<string, string>;
  trackingId: string;
}

export interface ZaloClientOptions {
  apiBaseUrl: string;
  oauthBaseUrl: string;
  timeoutMs?: number;
}

const TIMEOUT_MS = 10_000;
const MESSAGE_MAX = 500;

/**
 * ZBS Template Message(전화번호) 발송과 OA 토큰 갱신(research R-1·R-2). 새 의존성 없이 전역 `fetch` 를 쓴다.
 * 예외를 던지지 않는다 — 네트워크·HTTP 오류도 결과로 돌려 러너가 분류한다.
 */
export class ZaloClient {
  constructor(
    private readonly options: ZaloClientOptions,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async sendTemplate(accessToken: string, message: ZaloTemplateMessage): Promise<ZaloSendResult> {
    const response = await this.call(`${this.options.apiBaseUrl}/message/template`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', access_token: accessToken },
      body: JSON.stringify({
        phone: message.phone,
        template_id: message.templateId,
        template_data: message.templateData,
        tracking_id: message.trackingId,
      }),
    });
    if (!response.ok) return response;
    const body = response.body as { error?: number; message?: string; data?: { msg_id?: string } };
    if (body.error === 0 && body.data?.msg_id) return { ok: true, msgId: String(body.data.msg_id) };
    return { ok: false, code: String(body.error ?? 'UNKNOWN'), message: clip(body.message) };
  }

  async refresh(appId: string, secretKey: string, refreshToken: string): Promise<ZaloRefreshResult> {
    const response = await this.call(`${this.options.oauthBaseUrl}/v4/oa/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', secret_key: secretKey },
      body: new URLSearchParams({ refresh_token: refreshToken, app_id: appId, grant_type: 'refresh_token' }).toString(),
    });
    if (!response.ok) return { ...response, transient: true };
    const body = response.body as {
      access_token?: string; refresh_token?: string; expires_in?: string | number;
      error?: number; message?: string; error_description?: string;
    };
    if (body.access_token && body.refresh_token) {
      return { ok: true, accessToken: body.access_token, refreshToken: body.refresh_token, expiresInSec: Number(body.expires_in) || 90_000 };
    }
    return { ok: false, code: String(body.error ?? 'UNKNOWN'), message: clip(body.error_description ?? body.message), transient: false };
  }

  /** 네트워크 실패는 `NETWORK`, 5xx 는 `HTTP_5xx`(상태 코드). 4xx 도 본문을 읽어 Zalo 코드를 본다. */
  private async call(
    url: string,
    init: RequestInit,
  ): Promise<{ ok: true; body: unknown } | { ok: false; code: string; message: string }> {
    let response: Response;
    try {
      response = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(this.options.timeoutMs ?? TIMEOUT_MS) });
    } catch (error) {
      // `DOMException` 은 realm 에 따라 `instanceof Error` 가 아니다 — 이름만 본다.
      const name = (error as { name?: unknown } | null)?.name;
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      return { ok: false, code: 'NETWORK', message: timedOut ? '응답 시간 초과' : '연결 실패' };
    }
    if (response.status >= 500) {
      // 본문을 버린다 — 읽지 않은 본문은 소켓을 붙잡는다.
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, code: `HTTP_${response.status}`, message: `HTTP ${response.status}` };
    }
    try {
      return { ok: true, body: await response.json() };
    } catch {
      // JSON 이 아닌 4xx(잘못된 주소 등)는 설정 오류다 — 다시 보내도 같다.
      return { ok: false, code: `HTTP_${response.status}`, message: '응답 본문을 읽지 못했다' };
    }
  }
}

function clip(message: string | undefined): string {
  return (message ?? '').slice(0, MESSAGE_MAX);
}

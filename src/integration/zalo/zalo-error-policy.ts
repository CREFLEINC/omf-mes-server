import { SITE_OFFSET_MS } from '../../core/notification';

/**
 * Zalo 오류 분류(research R-3 · 공식 「Bảng mã lỗi」). 같은 요청을 다시 보내도 결과가 같은 오류는
 * 재시도하지 않는다(FR-025). 표에 없는 음수 코드는 일시 오류로 본다.
 */
export type ZaloErrorClass = 'RETRY' | 'TOKEN' | 'DEFER_0700' | 'FAIL_RECIPIENT' | 'FAIL_CONFIG';

const TOKEN = new Set(['-124']);
/** 22:00~07:00 발송 금지 유형(-133) · 일일 한도(-144·-147) — 시간이 지나면 풀린다. */
const DEFER = new Set(['-133', '-144', '-147']);
/** 번호 무효·Zalo 계정 없음·수신 거부·자격 없음 — 그 수신자만 실패. */
const RECIPIENT = new Set(['-108', '-118', '-139', '-140', '-141']);
/** 앱·템플릿·파라미터·ZBS 잔액·연결·권한 — 연결 화면에 마지막 설정 오류로 보인다. */
const CONFIG = new Set([
  '-101', '-103', '-104',
  '-109', '-117', '-131',
  '-111', '-1121', '-1122', '-1124', '-132',
  '-115', '-136', '-137',
  '-120', '-135', '-138',
]);

/** `code` 는 Zalo `error` 값(문자열) 또는 내부 코드 `NETWORK`·`HTTP_5xx`. */
export function classifyZaloError(code: string): ZaloErrorClass {
  if (TOKEN.has(code)) return 'TOKEN';
  if (DEFER.has(code)) return 'DEFER_0700';
  if (RECIPIENT.has(code)) return 'FAIL_RECIPIENT';
  if (CONFIG.has(code)) return 'FAIL_CONFIG';
  // 4xx 에 Zalo 본문이 없다 — 주소·경로가 틀렸다. 다시 보내도 같다.
  if (/^HTTP_4\d\d$/.test(code)) return 'FAIL_CONFIG';
  // 네트워크·HTTP 5xx·-100(일시)·표에 없는 음수 — 백오프 재시도.
  return 'RETRY';
}

/** 다음 07:00(UTC+7). 지금이 07:00 이전이면 오늘, 아니면 내일 — 현장 시각 기준이다(-133 의 금지 구간). */
export function nextSiteMorning(now: Date): Date {
  const local = new Date(now.getTime() + SITE_OFFSET_MS);
  const morning = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 7, 0, 0);
  const next = local.getTime() < morning ? morning : morning + 24 * 60 * 60 * 1000;
  return new Date(next - SITE_OFFSET_MS);
}

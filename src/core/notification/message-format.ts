/**
 * 알림 값 조립 — 알림센터 `message` 와 Zalo `template_data` 를 «같은 값»에서 만든다(research R-12).
 *
 * ⭐ Zalo 파라미터 이름은 고정이다(data-model §6 · research R-4) — 고객사가 이 이름으로 템플릿을 등록한다.
 * 서버에 다국어 장치가 없어 문장은 값 위주로 잇고, 라벨은 사유·수량에만 붙인다(한국어 · 사용자 확인 2026-10-21).
 */

/** 이벤트별 고유 파라미터. 공통 `event_time`·`actor` 는 아래 `COMMON_PARAMS`. */
export const EVENT_PARAMS: Readonly<Record<string, readonly string[]>> = {
  WORK_SESSION_STARTED: ['wo_no', 'item', 'process', 'line'],
  WORK_SESSION_STOPPED: ['wo_no', 'item', 'process', 'line', 'reason'],
  WORK_SESSION_ENDED: ['wo_no', 'item', 'process', 'line', 'plan_qty', 'good_qty'],
  WORK_ORDER_CLOSED: ['wo_no', 'item', 'process', 'line', 'plan_qty', 'good_qty'],
  EQUIPMENT_BREAKDOWN_OCCURRED: ['equipment', 'location', 'line', 'symptom'],
  APPROVAL_ACTION_REQUIRED: ['approval_type', 'request_no', 'requester', 'reason', 'step'],
};

export const COMMON_PARAMS = ['event_time', 'actor'] as const;

/** 문장에서 값 앞에 붙는 라벨. 없는 키는 값만 쓴다. */
const LABELS: Readonly<Record<string, string>> = {
  reason: '사유: ',
  plan_qty: '계획 ',
  good_qty: '양품 ',
};

/** 중단 사유만 「중단 사유」다 — 결재 사유와 같은 키를 쓰므로 이벤트로 가른다. */
const EVENT_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  WORK_SESSION_STOPPED: { reason: '중단 사유: ' },
};

/** 값이 비면 Zalo 에 빈 문자열 대신 이 값을 싣는다 — 템플릿 파라미터가 비면 Zalo 가 거절할 수 있다. */
export const EMPTY_PARAM = '-';

/**
 * ⚠ 현장 시각(UTC+7, 베트남 하노이 · 일광절약 없음)으로 고정한다 — 설계가 메시지 시각을 UTC+7 로 정했다
 * (data-model §6). 공장마다 `plant.timezone_code` 를 푸는 일은 알림 범위 밖이다.
 */
const SITE_OFFSET_MS = 7 * 60 * 60 * 1000;

export type NotificationValues = Record<string, string | number | null | undefined>;

function siteParts(at: Date): { yyyy: string; MM: string; dd: string; HH: string; mm: string } {
  const local = new Date(at.getTime() + SITE_OFFSET_MS);
  const two = (n: number) => String(n).padStart(2, '0');
  return {
    yyyy: String(local.getUTCFullYear()),
    MM: two(local.getUTCMonth() + 1),
    dd: two(local.getUTCDate()),
    HH: two(local.getUTCHours()),
    mm: two(local.getUTCMinutes()),
  };
}

/** Zalo `event_time` — `dd/MM/yyyy HH:mm`(UTC+7). */
export function formatEventTime(at: Date): string {
  const p = siteParts(at);
  return `${p.dd}/${p.MM}/${p.yyyy} ${p.HH}:${p.mm}`;
}

/** 알림센터 문장 끝의 짧은 시각 — `MM-dd HH:mm`(UTC+7). 날짜 전체는 화면이 `occurredAt` 으로 보인다. */
function shortTime(at: Date): string {
  const p = siteParts(at);
  return `${p.MM}-${p.dd} ${p.HH}:${p.mm}`;
}

function text(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function paramsOf(eventCode: string): readonly string[] {
  const params = EVENT_PARAMS[eventCode];
  if (params === undefined) throw new Error(`알림 파라미터 정의가 없는 이벤트입니다: ${eventCode}`);
  return params;
}

/**
 * Zalo `template_data` — 정해진 키만, 모두 문자열, `maxLength` 로 자른다. 빈 값은 `-`.
 * `event_time` 은 발생 시각에서 만든다(보낸 값이 있어도 덮는다).
 */
export function templateData(
  eventCode: string,
  values: NotificationValues,
  occurredAt: Date,
  maxLength: number,
): Record<string, string> {
  const all: NotificationValues = { ...values, event_time: formatEventTime(occurredAt) };
  const data: Record<string, string> = {};
  for (const key of [...paramsOf(eventCode), ...COMMON_PARAMS]) {
    const value = text(all[key]);
    data[key] = value === '' ? EMPTY_PARAM : value.slice(0, maxLength);
  }
  return data;
}

/**
 * 알림센터 `message` — 이벤트 파라미터를 순서대로 ` · ` 로 잇고, 끝에 실행한 사람과 시각을 붙인다.
 * 빈 값은 건너뛴다. 결재는 `actor` 가 `requester` 와 같아 한 번만 쓴다.
 */
export function notificationMessage(eventCode: string, values: NotificationValues, occurredAt: Date): string {
  const labels = { ...LABELS, ...EVENT_LABELS[eventCode] };
  const parts = paramsOf(eventCode)
    .map((key) => [key, text(values[key])] as const)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${labels[key] ?? ''}${value}`);
  const actor = text(values.actor);
  if (actor !== '' && eventCode !== 'APPROVAL_ACTION_REQUIRED') parts.push(actor);
  parts.push(shortTime(occurredAt));
  return parts.join(' · ');
}

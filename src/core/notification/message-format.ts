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

/**
 * 인계 작업 10종의 Zalo 파라미터 — 템플릿마다 «전부»를 적는다(omf-all-around#190 · specs/002 zalo-templates.md).
 * 6종과 달리 `event_time`·`actor` 를 덧붙이지 않는다 — 템플릿에 없는 파라미터를 실으면 키 집합이 표와 달라진다(SC-006).
 * `EVENT_PARAMS`(6종) 키 집합은 그대로다.
 */
export const HANDOVER_PARAMS: Readonly<Record<string, readonly string[]>> = {
  PUTAWAY_REQUESTED: ['receipt_no', 'warehouse', 'task_count', 'event_time', 'actor'],
  MATERIAL_PICKING_REQUESTED: ['picking_no', 'wo_no', 'item_count', 'warehouse', 'required_at', 'event_time'],
  STOCK_TRANSFER_ARRIVAL_PENDING: ['transfer_no', 'from_warehouse', 'to_warehouse', 'item_count', 'event_time', 'actor'],
  SHIPMENT_PICKING_REQUESTED: ['request_no', 'customer', 'item_count', 'ship_date', 'event_time'],
  SHIPMENT_PACKING_REQUESTED: ['shipment_no', 'warehouse', 'ship_date', 'event_time', 'actor'],
  WORK_ORDER_RELEASED: ['wo_no', 'item', 'plan_qty', 'process', 'equipment', 'event_time'],
  EMERGENCY_WORK_ORDER_RELEASED: ['wo_no', 'item', 'plan_qty', 'process', 'equipment', 'event_time'],
  OQC_INSPECTION_REQUESTED: ['request_no', 'request_count', 'ship_date', 'event_time'],
  REWORK_WORK_ORDER_CREATED: ['wo_no', 'item', 'qty', 'ncr_no', 'process', 'event_time', 'actor'],
  IQC_INSPECTION_REQUESTED: ['receipt_no', 'lot_count', 'supplier', 'event_time'],
};

/** 인계 알림센터 문장의 라벨 — 6종 키와 겹치지 않는 키만 둔다(6종 문장 불변). */
const HANDOVER_LABELS: Readonly<Record<string, string>> = {
  task_count: '적치 ',
  item_count: '품목 ',
  lot_count: 'LOT ',
  request_count: '의뢰 ',
  required_at: '필요 ',
  ship_date: '출하일 ',
  from_warehouse: '출발 ',
  to_warehouse: '도착 ',
  qty: '수량 ',
  ncr_no: '부적합 ',
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
export const SITE_OFFSET_MS = 7 * 60 * 60 * 1000;

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

/** 문장에 이을 고유 파라미터(공통 둘 제외). */
function paramsOf(eventCode: string): readonly string[] {
  const handover = HANDOVER_PARAMS[eventCode];
  if (handover !== undefined) return handover.filter((key) => !(COMMON_PARAMS as readonly string[]).includes(key));
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
  for (const key of HANDOVER_PARAMS[eventCode] ?? [...paramsOf(eventCode), ...COMMON_PARAMS]) {
    const value = text(all[key]);
    // 코드 포인트로 자른다 — UTF-16 단위로 자르면 이모지 한가운데가 잘려 홀로 남은 서로게이트가 실린다.
    data[key] = value === '' ? EMPTY_PARAM : Array.from(value).slice(0, maxLength).join('');
  }
  return data;
}

/**
 * 알림센터 `message` — 이벤트 파라미터를 순서대로 ` · ` 로 잇고, 끝에 실행한 사람과 시각을 붙인다.
 * 빈 값은 건너뛴다. 결재는 `actor` 가 `requester` 와 같아 한 번만 쓴다.
 */
export function notificationMessage(eventCode: string, values: NotificationValues, occurredAt: Date): string {
  const labels = HANDOVER_PARAMS[eventCode] === undefined ? { ...LABELS, ...EVENT_LABELS[eventCode] } : { ...LABELS, ...HANDOVER_LABELS };
  const parts = paramsOf(eventCode)
    .map((key) => [key, text(values[key])] as const)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${labels[key] ?? ''}${value}`);
  const actor = text(values.actor);
  if (actor !== '' && eventCode !== 'APPROVAL_ACTION_REQUIRED') parts.push(actor);
  parts.push(shortTime(occurredAt));
  return parts.join(' · ');
}

/** 달력 날짜(`@db.Date`, UTC 자정) — `dd/MM/yyyy`. 시간대를 옮기지 않는다. */
export function formatCalendarDate(date: Date | null | undefined): string | null {
  if (date === null || date === undefined) return null;
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(date.getUTCDate())}/${two(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
}

/** 수량 + 단위 — 천 단위 쉼표, 소수 끝 0 은 뺀다(예: `1,200 EA`). */
export function formatQty(qty: { toString(): string } | null | undefined, uomCode: string | null | undefined): string | null {
  if (qty === null || qty === undefined) return null;
  const [whole, fraction = ''] = qty.toString().split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const trimmed = fraction.replace(/0+$/, '');
  const number = trimmed === '' ? grouped : `${grouped}.${trimmed}`;
  return uomCode ? `${number} ${uomCode}` : number;
}

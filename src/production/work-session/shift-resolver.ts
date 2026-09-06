import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/** 교대 창 하나. `mdm.shift` 에서 판정에 필요한 네 칸만 뽑는다. */
export interface ShiftWindow {
  readonly shift_id: bigint;
  readonly start_time: Date;
  readonly end_time: Date;
  readonly crosses_midnight: boolean;
}

/**
 * 공장 로컬 시각을 `HH:MM:SS` 로 낸다(`plant.timezone_code` · `mold-derivation.ts:96` 결).
 *
 * ⛔ SQL 로 타임존 캐스팅하지 않는다(CLAUDE.md) · ⛔ `getHours()` 는 서버 로컬이라 어긋난다.
 */
export function localTimeOf(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(at);
}

/** `@db.Time(6)` 은 Prisma 가 1970-01-01 **UTC** 의 `Date` 로 준다(`reference.service.ts:193`). */
export function timeOf(column: Date): string {
  return column.toISOString().slice(11, 19);
}

/**
 * 로컬 시각이 드는 교대. 경계는 **반열림**(시작 이상 · 끝 미만 · 공유계약 L-3).
 * 겹치면 `start_time` 이 앞선 것 — 결정론을 위해 정렬한다. 어느 교대에도 안 들면 `null`.
 */
export function pickShift(shifts: ShiftWindow[], localTime: string): bigint | null {
  // 둘 다 `HH:MM:SS` 라 사전순 = 시각순이다.
  const ordered = [...shifts].sort((a, b) => timeOf(a.start_time).localeCompare(timeOf(b.start_time)));

  for (const shift of ordered) {
    const start = timeOf(shift.start_time);
    const end = timeOf(shift.end_time);
    const inside = shift.crosses_midnight
      ? localTime >= start || localTime < end
      : localTime >= start && localTime < end;
    if (inside) return shift.shift_id;
  }
  return null;
}

/**
 * 「시작 시각 + **단말의 공장**」 축으로 교대를 푼다(계약 문자 · I-11 §3-3).
 *
 * ⛔ `work_order.planned_shift_id` 도 W/O→plan→order 의 `plant_id` 사슬도 쓰지 않는다 —
 *    계약이 축을 못박았고 계획 교대는 다른 축이다(조용한 도출 금지).
 * 공장이 없거나 그 공장에 활성 교대가 0행이면 `null` — 세션을 막지 않는다(계약 명문).
 */
export async function resolveShiftId(
  tx: Tx,
  plantId: bigint,
  startedAt: Date,
): Promise<bigint | null> {
  const plant = await tx.plant.findUnique({
    where: { plant_id: plantId },
    select: { timezone_code: true },
  });
  if (!plant) return null;

  const shifts = await tx.shift.findMany({
    where: { plant_id: plantId, is_active: true },
    select: { shift_id: true, start_time: true, end_time: true, crosses_midnight: true },
  });

  return pickShift(shifts, localTimeOf(startedAt, plant.timezone_code));
}

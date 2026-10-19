import type { EquipmentStatusCode } from './dashboard-sections';

export const MOLD_CHANGE = 'MOLD_CHANGE';

/** 판단 시각에 설비에 걸려 있는 기록들. 없으면 null. */
export interface EquipmentSignals {
  /** 끝나지 않은 고장 — 발생 상태와 무관하다(STOPPED·ABNORMAL·옛 데이터 null 모두 정지 · 사용자 결정 2026-10-19). */
  readonly breakdown: { readonly since: Date; readonly description: string } | null;
  readonly downtime: {
    readonly since: Date;
    readonly reasonCode: string | null;
    readonly reasonName: string | null;
  } | null;
  /** 진행 중 작업세션. `since` 는 마지막 STOP·RESUME(없으면 시작) 시각이다. */
  readonly session: {
    readonly stopped: boolean;
    readonly since: Date;
    readonly reasonCode: string | null;
    readonly reasonName: string | null;
  } | null;
  /**
   * 계획 정지·근무달력 비근무 구간이면 그 시작(모르면 null), 아니면 undefined.
   * 사유는 계획 정지일 때만 — 코드 = 정지 유형, 이름 = 정지 사유 문구. 비근무는 둘 다 null.
   */
  readonly idle:
    | { readonly since: Date | null; readonly reasonCode: string | null; readonly reasonName: string | null }
    | undefined;
  readonly lastSessionEndedAt: Date | null;
}

export interface EquipmentStatus {
  readonly statusCode: EquipmentStatusCode;
  readonly statusSince: string | null;
  readonly statusReasonCode: string | null;
  readonly statusReasonName: string | null;
}

const BREAKDOWN_TEXT_LIMIT = 100;

/**
 * 설비에 열린 비가동 기록이 여럿이면 하나라도 MOLD_CHANGE 가 아니면 정지, 모두 MOLD_CHANGE 일 때만 교체다.
 * 그래서 MOLD_CHANGE 아닌 기록 중 가장 늦게 시작한 것을, 없으면 가장 늦게 시작한 MOLD_CHANGE 를 고른다.
 * `rows` 는 시작 시각 오름차순이다.
 */
export function pickDowntime<T extends { readonly reasonCode: string | null }>(rows: readonly T[]): T | null {
  const stopping = rows.filter((row) => row.reasonCode !== MOLD_CHANGE);
  return stopping.at(-1) ?? rows.at(-1) ?? null;
}

function status(
  statusCode: EquipmentStatusCode,
  since: Date | null,
  reasonCode: string | null = null,
  reasonName: string | null = null,
): EquipmentStatus {
  return { statusCode, statusSince: since?.toISOString() ?? null, statusReasonCode: reasonCode, statusReasonName: reasonName };
}

/**
 * 위에서부터 먼저 맞는 것(#118 2차 규격).
 * 교체는 세션의 «MOLD_CHANGE 이벤트»가 아니라 사유가 MOLD_CHANGE 인 STOP 이다 — 그런 이벤트 유형이 없다.
 * 고장 사유는 코드가 없어(증상은 자유 문구) 이름 자리에 설명 앞부분을 싣는다.
 */
export function equipmentStatus(signals: EquipmentSignals): EquipmentStatus {
  const { breakdown, downtime, session } = signals;
  if (breakdown !== null) {
    return status('STOPPED', breakdown.since, null, breakdown.description.slice(0, BREAKDOWN_TEXT_LIMIT));
  }
  if (downtime !== null && downtime.reasonCode !== MOLD_CHANGE) {
    return status('STOPPED', downtime.since, downtime.reasonCode, downtime.reasonName);
  }
  if (downtime !== null) return status('CHANGEOVER', downtime.since, downtime.reasonCode, downtime.reasonName);
  if (session?.stopped === true) {
    return status(
      session.reasonCode === MOLD_CHANGE ? 'CHANGEOVER' : 'STOPPED',
      session.since,
      session.reasonCode,
      session.reasonName,
    );
  }
  const { idle } = signals;
  if (idle !== undefined) return status('IDLE', idle.since, idle.reasonCode, idle.reasonName);
  if (session !== null) return status('RUNNING', session.since);
  return status('WAITING', signals.lastSessionEndedAt);
}

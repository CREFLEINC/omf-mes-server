import type { OqcLotStatus } from '../../quality/inspection/oqc-lot-result';

/**
 * 출하 완료를 막는 이유(피처 010 FR-016 · data-model 「출하 완료 가능」). 비면 완료 대기다.
 * ⭐ 확인 화면(`:lookup`)·목록 요약·`:complete` 관문이 이 함수 하나를 쓴다 — 갈리면 「완료 대기」로 보인 지시서가 409 가 된다.
 * `SALES_ORDER_LINE_CANCELLED` 는 「담당자에게 문의」 안내만 붙이고 푸는 경로는 두지 않는다(범위 밖 · FR-028b).
 */
export type CompletionBlockerCode =
  | 'PICKING_SHORT'
  | 'NOT_INSPECTED'
  | 'REJECTED'
  | 'HELD'
  | 'SALES_ORDER_LINE_CANCELLED'
  | 'ALREADY_COMPLETED';

export interface CompletionBlocker {
  code: CompletionBlockerCode;
  lineNo?: number;
  lotNo?: string;
}

export interface CompletionLineFacts {
  lineNo: number;
  allocatedQty: number;
  pickedQty: number;
  salesOrderLineCancelled: boolean;
}

export interface CompletionLotFacts {
  lotNo: string;
  oqcLotStatus: OqcLotStatus | null;
}

const LOT_BLOCKERS: Partial<Record<OqcLotStatus, CompletionBlockerCode>> = {
  NOT_INSPECTED: 'NOT_INSPECTED',
  REJECTED: 'REJECTED',
  HELD: 'HELD',
};

/** `lots` 는 살아 있는(PICKED) 피킹 LOT 이다 — 교체된 LOT 은 막지 않는다. */
export function completionBlockers(input: {
  completed: boolean;
  lines: readonly CompletionLineFacts[];
  lots: readonly CompletionLotFacts[];
}): CompletionBlocker[] {
  if (input.completed) return [{ code: 'ALREADY_COMPLETED' }];
  const blockers: CompletionBlocker[] = [];
  for (const line of input.lines) {
    if (line.allocatedQty > 0 && line.pickedQty < line.allocatedQty) blockers.push({ code: 'PICKING_SHORT', lineNo: line.lineNo });
  }
  // 배정이 없는 지시서라도 낼 LOT 이 하나도 없으면 완료할 것이 없다.
  if (input.lots.length === 0 && blockers.length === 0) blockers.push({ code: 'PICKING_SHORT' });
  for (const lot of input.lots) {
    const code = lot.oqcLotStatus === null ? undefined : LOT_BLOCKERS[lot.oqcLotStatus];
    if (code !== undefined) blockers.push({ code, lotNo: lot.lotNo });
  }
  for (const line of input.lines) {
    if (line.salesOrderLineCancelled) blockers.push({ code: 'SALES_ORDER_LINE_CANCELLED', lineNo: line.lineNo });
  }
  return blockers;
}

/** 목록 행의 「막힘 n」 — 이유 코드별 수. */
export function blockerSummary(blockers: readonly CompletionBlocker[]): Partial<Record<CompletionBlockerCode, number>> {
  const summary: Partial<Record<CompletionBlockerCode, number>> = {};
  for (const blocker of blockers) summary[blocker.code] = (summary[blocker.code] ?? 0) + 1;
  return summary;
}

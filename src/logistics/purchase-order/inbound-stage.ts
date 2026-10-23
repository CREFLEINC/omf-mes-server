import { Prisma } from '@prisma/client';

/**
 * 입고 관리 허브(W-01-09)의 LOT 한 줄이 «지금 어느 단계이고 다음에 무엇을 하는가».
 * 화면이 규칙을 베끼지 않게 서버가 정한다(C-17 · 장부 P-110).
 */
export type InboundStageCode =
  | 'INSPECTION_REQUIRED'
  | 'INSPECTION_REQUESTED'
  | 'INSPECTION_IN_PROGRESS'
  | 'INSPECTION_HELD'
  | 'RECEIPT_READY'
  | 'PUTAWAY_PENDING'
  | 'PUTAWAY_TEMPORARY'
  | 'COMPLETED'
  | 'CANCELLED';

/** ⚠ `REQUEST_IQC` 는 아직 주지 않는다 — 의뢰 생성 경로를 미뤘다(사용자 결정 2026-10-23). */
export type InboundNextActionCode = 'POST_RECEIPT' | 'PUTAWAY' | null;

export interface BlockedReason {
  code: string;
  name: string;
}

/** 판정에 드는 사실 — LOT 하나의 것만. 모으는 쪽이 `inbound-progress.service.ts` 다. */
export interface LotStageFacts {
  /** 입하 전표가 취소됐거나 취소 요청 중이다. */
  receiptCancelled: boolean;
  lotStatusCode: string;
  /** 입하 라인의 검사 대상 표식 — 선별 자식은 조상 입하 라인의 것. 입고 검사도 이 값을 본다. */
  inspectionRequired: boolean;
  /** 가장 최근 IQC 의뢰의 상태. 없으면 null. */
  inspectionStatusCode: string | null;
  /** 열린 보류(`released_at IS NULL`)의 사유. */
  openHolds: readonly BlockedReason[];
  /** 입고 가능 수량(P-56) — 입고 검사의 상한과 같은 계산. */
  receivableQty: Prisma.Decimal;
  /** 살아 있는 입고(POSTED 전표)의 적치 작업 상태. 취소된 작업은 뺀다. */
  putawayStatusCodes: readonly string[];
}

export interface LotStage {
  stageCode: InboundStageCode;
  nextActionCode: InboundNextActionCode;
  blockedReasons: BlockedReason[];
}

/** 목록·칩의 네 묶음. 완료·취소는 어느 묶음에도 들지 않는다. */
export type InboundStageGroup = 'INSPECTION' | 'HELD' | 'RECEIPT' | 'PUTAWAY';

export const INBOUND_STAGE_GROUPS: readonly InboundStageGroup[] = ['INSPECTION', 'HELD', 'RECEIPT', 'PUTAWAY'];

const GROUP_OF: Readonly<Partial<Record<InboundStageCode, InboundStageGroup>>> = {
  INSPECTION_REQUIRED: 'INSPECTION',
  INSPECTION_REQUESTED: 'INSPECTION',
  INSPECTION_IN_PROGRESS: 'INSPECTION',
  INSPECTION_HELD: 'HELD',
  RECEIPT_READY: 'RECEIPT',
  PUTAWAY_PENDING: 'PUTAWAY',
  PUTAWAY_TEMPORARY: 'PUTAWAY',
};

export function stageGroupOf(stageCode: InboundStageCode): InboundStageGroup | null {
  return GROUP_OF[stageCode] ?? null;
}

const INSPECTION_PENDING = 'INSPECTION_PENDING';
const SCRAPPED = 'SCRAPPED';

/**
 * 위에서부터 보고 처음 맞는 줄이 답이다. 입고할 수량이 남으면 적치가 진행 중이어도 입고 단계로 본다 —
 * 한 줄은 가장 뒤처진 단계 하나만 말한다(C-17).
 */
export function lotStage(facts: LotStageFacts): LotStage {
  if (facts.receiptCancelled) return stage('CANCELLED', null);
  if (facts.receivableQty.greaterThan(0)) return beforeReceipt(facts);
  if (facts.putawayStatusCodes.includes('PENDING')) return stage('PUTAWAY_PENDING', 'PUTAWAY');
  if (facts.putawayStatusCodes.includes('COMPLETED_TEMPORARY')) return stage('PUTAWAY_TEMPORARY', 'PUTAWAY');
  return stage('COMPLETED', null);
}

function beforeReceipt(facts: LotStageFacts): LotStage {
  // 폐기된 LOT 은 남은 수량이 있어도 더 받을 일이 없다.
  if (facts.lotStatusCode === SCRAPPED) return stage('CANCELLED', null);
  // 불량(IQC 불합격·클레임 재Hold)은 불량창고로 입고해 처분을 기다린다 — 입고 검사가 창고를 가른다.
  if (facts.lotStatusCode !== INSPECTION_PENDING) return stage('RECEIPT_READY', 'POST_RECEIPT');
  if (facts.inspectionRequired) {
    if (facts.inspectionStatusCode === 'REQUESTED') return stage('INSPECTION_REQUESTED', null);
    if (facts.inspectionStatusCode === 'IN_PROGRESS') return stage('INSPECTION_IN_PROGRESS', null);
    if (facts.inspectionStatusCode === null || facts.inspectionStatusCode === 'CANCELLED') {
      return stage('INSPECTION_REQUIRED', null);
    }
  }
  // 판정 보류, 합격 뒤에도 남은 다른 보류, 무검사 품목에 건 보류 — 결과가 나올 때까지 멈춘다.
  return { ...stage('INSPECTION_HELD', null), blockedReasons: [...facts.openHolds] };
}

function stage(stageCode: InboundStageCode, nextActionCode: InboundNextActionCode): LotStage {
  return { stageCode, nextActionCode, blockedReasons: [] };
}

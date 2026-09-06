import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { CompletionJudgment } from './completion';

/** 계약 `WorkOrderClose` — **required 0** 이고 네 칸이 다 선택이다. */
export interface WorkOrderClose {
  /** 계약 enum 2값(`CARRY_OVER`·`WRITE_OFF`) — 값 검증은 계약 검증 가드가 이미 한다. */
  remainderDispositionCode?: string;
  reasonCode?: string;
  erpSendItems?: string[];
  remarks?: string;
}

const DISPOSITION = 'remainderDispositionCode';
const REASON = 'reasonCode';

/**
 * 본문 4+1 규칙 — 계약이 ⌜평면적인 required 로는 「미달일 때만」을 적을 수 없어 목록에서
 * 뺐고 **서버가 판정과 대조해 검증한다**⌝ 라 적은 자리다(§5-4). 다섯째(정상인데 사유가
 * 있다)는 ⌜정상은 두 칸을 다 비운다⌝ 의 뒷 절반 — 조용히 버리면 화면이 사유를 적었다고
 * 믿는다(R-10).
 */
export function assertCloseBody(judgment: CompletionJudgment, body: WorkOrderClose): void {
  const hasDisposition = body.remainderDispositionCode !== undefined;
  const hasReason = body.reasonCode !== undefined;

  if (judgment === 'UNDER' && !hasDisposition) {
    throw one(field(DISPOSITION, ERROR_CODE.REMAINDER_DISPOSITION_REQUIRED, '미달 마감은 잔량 처분을 함께 정해야 합니다.'));
  }
  if (judgment !== 'UNDER' && hasDisposition) {
    // ⌜넘길 잔량도 없앨 잔량도 없다⌝ — 계약이 정상·초과용 세 번째 값을 두지 않은 이유다.
    throw one(field(DISPOSITION, ERROR_CODE.REMAINDER_DISPOSITION_NOT_ALLOWED, '정상·초과 마감에는 잔량 처분을 담지 않습니다.'));
  }
  if (judgment !== 'NORMAL' && !hasReason) {
    throw one(field(REASON, ERROR_CODE.REQUIRED, '미달·초과 마감은 사유가 필요합니다.'));
  }
  if (judgment === 'NORMAL' && hasReason) {
    throw one(field(REASON, ERROR_CODE.INVALID, '정상 마감에는 사유를 담지 않습니다.'));
  }
}

export interface ClosePayloadInput {
  workOrderId: number;
  workOrderNo: string;
  itemId: number;
  orderQty: number;
  goodQty: number;
  completionJudgmentCode: CompletionJudgment;
  closedAt: Date;
  erpSendItems: string[];
}

/**
 * ERP 송신 payload. ⛔ `sendItems` 를 해석하지 않는다 — 계약이 ⌜넷의 코드 표기는 아직
 * 정하지 않았다⌝ 라 적어 대조할 목록이 없다. 개발품 제외 분기도 없다(칸이 물리에 없어
 * 계약이 「전건 적재」로 물러났다 · §5-6).
 */
export function closePayload(input: ClosePayloadInput): Prisma.InputJsonObject {
  const { erpSendItems, closedAt, ...header } = input;
  return { header: { ...header, closedAt: closedAt.toISOString() }, sendItems: erpSendItems };
}

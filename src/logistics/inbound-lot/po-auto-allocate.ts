import { Prisma } from '@prisma/client';

/** 자동 배정 후보 P/O 라인 — 같은 공장·공급사·품목·단위의 살아 있는 라인(R-22 의 1). */
export interface AllocationCandidate {
  purchaseOrderLineId: bigint;
  /** `YYYY-MM-DD` — 문자열 비교가 날짜 순서다. */
  orderDate: string;
  purchaseOrderNo: string;
  lineNo: number;
  orderedQty: Prisma.Decimal;
  toleranceOverQty: Prisma.Decimal;
  receivedQty: Prisma.Decimal;
}

export interface AutoAllocation {
  purchaseOrderLineId: bigint;
  qty: Prisma.Decimal;
}

export interface AutoAllocationResult {
  /** 라인당 한 행, 발주일 순. 배정 0 인 라인은 없다. */
  allocations: AutoAllocation[];
  /** 「P/O 없음」 — 저장하지 않는다(줄 수량 − 배정 합). */
  unallocatedQty: Prisma.Decimal;
}

const ZERO = new Prisma.Decimal(0);

/**
 * 입하 마감의 P/O 자동 배정(R-22). 발주일·P/O 번호·라인 번호 순으로 1차는 잔량(발주 − 받은 양)만, 1차를 다 돈 뒤에도
 * 남으면 2차로 초과 허용치까지 채운다 — 라인마다 잔량+허용치를 한 번에 채우면 오래된 라인이 허용치까지 먹고 새 라인
 * 잔량이 남는다(사용자 결정). 이미 넘친 라인은 0 이다.
 */
export function allocateByOrderAge(qty: Prisma.Decimal, candidates: readonly AllocationCandidate[]): AutoAllocationResult {
  const ordered = [...candidates].sort(byOrderAge);
  const shares = new Map<bigint, Prisma.Decimal>();
  let rest = qty;
  for (const pass of ['remaining', 'tolerance'] as const) {
    for (const line of ordered) {
      if (rest.lessThanOrEqualTo(0)) break;
      const taken = shares.get(line.purchaseOrderLineId) ?? ZERO;
      const ceiling = pass === 'remaining' ? line.orderedQty : line.orderedQty.plus(line.toleranceOverQty);
      const room = Prisma.Decimal.max(ZERO, ceiling.minus(line.receivedQty).minus(taken));
      const share = Prisma.Decimal.min(rest, room);
      if (share.lessThanOrEqualTo(0)) continue;
      shares.set(line.purchaseOrderLineId, taken.plus(share));
      rest = rest.minus(share);
    }
  }
  return {
    allocations: ordered.flatMap((line) => {
      const share = shares.get(line.purchaseOrderLineId);
      return share === undefined ? [] : [{ purchaseOrderLineId: line.purchaseOrderLineId, qty: share }];
    }),
    unallocatedQty: rest,
  };
}

function byOrderAge(left: AllocationCandidate, right: AllocationCandidate): number {
  if (left.orderDate !== right.orderDate) return left.orderDate < right.orderDate ? -1 : 1;
  if (left.purchaseOrderNo !== right.purchaseOrderNo) return left.purchaseOrderNo < right.purchaseOrderNo ? -1 : 1;
  return left.lineNo - right.lineNo;
}

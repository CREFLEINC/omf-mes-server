import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';

/** 상자 구성 한 줄 — 고치기 전(저장된 값)과 고친 뒤(본문)가 같은 모양이다. */
export interface RepackContent {
  itemId: bigint;
  lotId: bigint;
  uomId: bigint;
  qty: Prisma.Decimal;
}

/** 출하의 배분 한 줄. `handlingUnitId` 가 고치는 상자면 이 정정이 수량을 바꿀 수 있다. */
export interface RepackAllocation {
  allocationId: bigint;
  shipmentLineId: bigint;
  lineNo: number;
  itemId: bigint;
  lotId: bigint;
  lotNo: string;
  uomId: bigint;
  qty: Prisma.Decimal;
  handlingUnitId: bigint | null;
  deliveryLabelNo: string | null;
}

export interface AllocationChange {
  allocation: RepackAllocation;
  after: Prisma.Decimal;
}

const ACTION = '출하를 취소하고 다시 등록하세요.';
const key = (itemId: bigint, lotId: bigint, uomId: bigint): string => `${itemId}:${lotId}:${uomId}`;

/**
 * 상자 구성의 증감을 그 상자에 이어진 배분에 옮긴다(장부 P-125 · 사용자 결정 2026-10-27).
 * (품목·LOT·단위)마다 이어진 배분이 «하나»이고 상자 수량이 그 배분과 같았을 때만 옮긴다 — 배분이 둘이거나 상자에
 * 배분되지 않은 수량이 섞여 있으면 어느 배분을 고칠지 정할 수 없다. 출하에 배분되지 않은 LOT 을 새로 넣는 것은
 * OQC 대상 LOT 과 어긋나므로 받지 않는다. 출하 줄의 배분이 모두 0 이 되면 줄이 빈다 — 그것은 취소로 한다.
 */
export function planAllocationChanges(
  handlingUnitId: bigint,
  before: readonly RepackContent[],
  after: readonly RepackContent[],
  allocations: readonly RepackAllocation[],
  lotNoOf: (lotId: bigint) => string,
): AllocationChange[] {
  const beforeQty = new Map(before.map((row) => [key(row.itemId, row.lotId, row.uomId), row.qty]));
  const afterIndex = new Map(after.map((row, index) => [key(row.itemId, row.lotId, row.uomId), index]));
  const keys = [...new Set([...beforeQty.keys(), ...afterIndex.keys()])];
  const linked = allocations.filter((row) => row.handlingUnitId === handlingUnitId);
  const errors: ErrorItem[] = [];
  const changes: AllocationChange[] = [];

  for (const id of keys) {
    const index = afterIndex.get(id);
    const was = beforeQty.get(id) ?? new Prisma.Decimal(0);
    const now = index === undefined ? new Prisma.Decimal(0) : after[index].qty;
    if (was.equals(now)) continue;
    const path = index === undefined ? 'items' : `items[${index}].qty`;
    const [itemId, lotId, uomId] = id.split(':').map(BigInt);
    const mine = linked.filter((row) => row.itemId === itemId && row.lotId === lotId && row.uomId === uomId);
    const lotNo = lotNoOf(lotId);
    if (mine.length === 0) {
      errors.push(field(path, ERROR_CODE.INVALID,
        `LOT ${lotNo}: 이 상자에는 출하에 배분된 LOT 만 고칠 수 있습니다 — 다른 LOT 을 넣으려면 ${ACTION}`));
      continue;
    }
    if (mine.length > 1 || !mine[0].qty.equals(was)) {
      errors.push(field(path, ERROR_CODE.INVALID,
        `LOT ${lotNo}: 이 상자에 이어진 배분이 여럿이거나 배분되지 않은 수량이 섞여 있어 고칠 배분을 정할 수 없습니다 — ${ACTION}`));
      continue;
    }
    if (now.isZero() && mine[0].deliveryLabelNo !== null) {
      errors.push(field(path, ERROR_CODE.INVALID,
        `LOT ${lotNo}: 납품 라벨(${mine[0].deliveryLabelNo})이 발행된 배분이라 상자에서 뺄 수 없습니다 — 수량만 고치거나 ${ACTION}`));
      continue;
    }
    changes.push({ allocation: mine[0], after: now });
  }
  if (errors.length === 0) assertLinesKeepQty(allocations, changes, errors);
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  return changes;
}

function assertLinesKeepQty(allocations: readonly RepackAllocation[], changes: readonly AllocationChange[], errors: ErrorItem[]): void {
  const after = new Map(changes.map((change) => [change.allocation.allocationId, change.after]));
  const lines = new Map<bigint, { lineNo: number; qty: Prisma.Decimal }>();
  for (const row of allocations) {
    const line = lines.get(row.shipmentLineId) ?? { lineNo: row.lineNo, qty: new Prisma.Decimal(0) };
    line.qty = line.qty.plus(after.get(row.allocationId) ?? row.qty);
    lines.set(row.shipmentLineId, line);
  }
  for (const line of lines.values()) {
    if (!line.qty.isZero()) continue;
    errors.push(field('items', ERROR_CODE.INVALID,
      `출하 ${line.lineNo}번 줄의 배분이 모두 0 이 됩니다 — 줄을 비우려면 ${ACTION}`));
  }
}

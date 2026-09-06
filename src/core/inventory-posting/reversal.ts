import { HttpStatus } from '@nestjs/common';
import { Prisma, inventory_transaction_line } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { LockedBalanceRow } from './balance-lock';
import { PostingLine } from './posting.types';

/** `{원 번호}-R`. 채번 코어를 부르지 않는다 — 카운터를 안 써서 롤백이 결번을 안 만든다(§3-5). */
export const REVERSAL_NO_SUFFIX = '-R';
/** 같은 영업일이라 `uq_inventory_idempotency` 가 이중 역처리를 DB 차원에서 막는다(§3-6 ②). */
export const REVERSAL_KEY_PREFIX = 'REVERSAL:';

/** 11칸 차원 키. 조직 3축은 창고가 결정하므로 나머지 8칸이 `uq_inventory_balance_dim` 과 동치다. */
const dimensionKey = (...parts: (string | number | bigint)[]): string => parts.join(':');

const endpointOf = (w: bigint | null, l: bigint | null, q: string | null, i: string | null) =>
  w === null || l === null || q === null || i === null
    ? undefined
    : { warehouseId: Number(w), locationId: Number(l), qualityStatusCode: q, inventoryStatusCode: i };

/** 역 라인은 원 라인의 두 끝을 맞바꾼 것이다 — item·lot·uom·소유 칸은 그대로 복사한다. */
export function reversedLine(row: inventory_transaction_line): PostingLine {
  const wasFrom = endpointOf(row.from_warehouse_id, row.from_location_id,
    row.from_quality_status_code, row.from_inventory_status_code);
  const wasTo = endpointOf(row.to_warehouse_id, row.to_location_id,
    row.to_quality_status_code, row.to_inventory_status_code);
  return {
    itemId: Number(row.item_id),
    ...(row.lot_id === null ? {} : { lotId: Number(row.lot_id) }),
    qty: row.qty.toNumber(),
    uomId: Number(row.uom_id),
    ...(wasTo === undefined ? {} : { from: wasTo }),
    ...(wasFrom === undefined ? {} : { to: wasFrom }),
    ownershipTypeCode: row.ownership_type_code,
    ...(row.owner_partner_id === null ? {} : { ownerPartnerId: Number(row.owner_partner_id) }),
    ...(row.handling_unit_id === null ? {} : { handlingUnitId: Number(row.handling_unit_id) }),
  };
}

/**
 * 되돌릴 수량을 도메인이 «고르지 않고» 코어가 원 라인에서 읽으므로 하한 검사도 코어가 한다
 * (I-4 §3-3 과 반대 방향 · I-5 §3-8). 같은 11칸 키의 라인이 둘이면 **합계**로 본다(R-4).
 */
export function assertReversible(lines: PostingLine[], locked: LockedBalanceRow[]): void {
  const rows = new Map(
    locked.map((r) => [
      dimensionKey(r.warehouseId, r.locationId, r.itemId, r.lotKey, r.quality_status_code,
        r.inventory_status_code, r.ownership_type_code, r.owner_partner_id ?? 0n), r,
    ]),
  );
  const demand = new Map<string, Prisma.Decimal>();
  for (const line of lines) {
    // 역행에서 «나가는» 쪽만 하한이 걸린다 — 들어오는 쪽은 잔량을 늘린다.
    if (line.from === undefined) continue;
    const e = line.from;
    const key = dimensionKey(e.warehouseId, e.locationId, line.itemId, line.lotId ?? 0,
      e.qualityStatusCode, e.inventoryStatusCode, line.ownershipTypeCode, line.ownerPartnerId ?? 0);
    demand.set(key, (demand.get(key) ?? new Prisma.Decimal(0)).plus(line.qty));
  }
  for (const [key, qty] of demand) {
    const row = rows.get(key);
    // 0행이면 그 차원이 통째로 사라진 것이다 — 없는 자리에서 뺄 수 없다.
    if (row === undefined) throw negativeBalance();
    // ⛔ 조용히 0 으로 대신하지 않는다 — 생성 컬럼이 비었다는 것은 물리가 어긋났다는 뜻이다.
    if (row.available_qty === null) throw new Error(`available_qty 가 비어 있다: ${key}`);
    if (row.available_qty.lessThan(qty)) throw negativeBalance();
  }
}

const negativeBalance = (): ContractException =>
  new ContractException(HttpStatus.BAD_REQUEST, [
    { scope: 'screen', code: ERROR_CODE.NEGATIVE_BALANCE, message: '되돌리면 재고가 음수가 됩니다.' },
  ]);

/** `uq_inventory_transaction_no` 위반과 갈라야 한다 — 그쪽은 삼키지 않고 그대로 던진다. */
export function isIdempotencyConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  return [error.meta?.target].flat().join(',').includes('uq_inventory_idempotency');
}

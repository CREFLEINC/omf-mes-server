import { Prisma } from '@prisma/client';

/**
 * 계약 `RecycleEntry` 로 옮기는 자리 — 프로퍼티 10 · required 5.
 *
 * ⛔ **저장 칸 여섯을 싣지 않는다**(`recycleEntryNo`·`remarks`·`statusCode`·`recycleTypeCode`·
 * `processedAt`·`sourceDocument*`) — 계약에 그 프로퍼티가 없다.
 * ⛔ 선택 칸은 널일 때 **키를 생략**한다 — 계약이 `[integer,null]` 이 아니라 `integer` 라 널을
 * 실으면 ajv 가 깨진다(`handling-unit-view.ts` 는 계약이 널을 명시해 갈린다).
 * ⛔ **계보를 싣지 않는다** — DR-006 이 「추적 불필요」로 확정했고, 일부만 채워진 계보가 빈
 * 계보보다 위험하다(계약 `x-internal-note`).
 */
export type RecycleEntryRow = Prisma.recycle_entryGetPayload<{ include: { lot: true } }>;

export interface RecycleEntryView {
  recycleEntryId: number;
  lotId: number;
  lotNo: string;
  itemId: number;
  quantity: number;
  uomId?: number;
  warehouseId?: number;
  locationId?: number;
  businessDate?: string;
  occurredAt?: string;
}

/**
 * ⭐ `businessDate` 를 **따로 받는다** — `recycle_entry` 18칸에 영업일 칸이 «0개»고 그 값이
 * 사는 곳은 원장 헤더다(§1-2). 계약 응답은 그것을 「본문 그대로」 돌려주라 한다.
 * ⛔ `processed_at` 에서 도출하지 않는다 — 시각을 날짜로 깎는 것은 타임존 캐스팅이다.
 */
export function recycleEntryView(row: RecycleEntryRow, businessDate: string): RecycleEntryView {
  // 물리는 nullable 이나 이 경로는 언제나 채운다(§5-2) — 비면 호출자 버그다.
  if (row.lot === null) throw new Error(`재생재 등록에 LOT 이 없다: ${row.recycle_entry_id}`);

  return {
    recycleEntryId: Number(row.recycle_entry_id),
    lotId: Number(row.lot.lot_id),
    lotNo: row.lot.lot_no,
    itemId: Number(row.item_id),
    quantity: Number(row.recycle_qty),
    uomId: Number(row.uom_id),
    ...(row.warehouse_id === null ? {} : { warehouseId: Number(row.warehouse_id) }),
    ...(row.destination_location_id === null
      ? {}
      : { locationId: Number(row.destination_location_id) }),
    businessDate,
    ...(row.processed_at === null ? {} : { occurredAt: row.processed_at.toISOString() }),
  };
}

import { omitEmpty } from '../../common/http/omit-empty';

/**
 * `lot-status-query.ts` 의 `SELECT_COLUMNS` 가 내는 원시 행 — `$queryRawUnsafe` 는 칸 이름을
 * 그대로 돌려주고 타입을 강제하지 않는다(숫자 축이 `string`/`bigint`/`number` 로 섞여 온다).
 */
export interface LotStatusRow {
  lot_id: bigint | number;
  lot_no: string;
  item_id: bigint | number;
  lot_type_code: string;
  status_code: string;
  version_no: number;
  on_hand_qty: unknown;
  uom_id: bigint | number | null;
  warehouse_id: bigint | number | null;
  location_id: bigint | number | null;
  open_hold_count: number;
  fully_held: boolean;
  partial_hold_qty: unknown;
  latest_transition_at: Date | null;
  latest_reason_code: string | null;
}

/** 계약 `LotQualityStatus` 와 동형(required 6: lotId·lotNo·itemId·lotStatusCode·fullyHeld·versionNo). */
export interface LotStatusView {
  lotId: number;
  lotNo: string;
  itemId: number;
  lotTypeCode: string;
  lotStatusCode: string;
  versionNo: number;
  warehouseId?: number;
  locationId?: number;
  onHandQty?: number;
  heldQty?: number;
  availableQty?: number;
  uomId?: number;
  openHoldCount: number;
  fullyHeld: boolean;
  latestTransitionAt?: string;
  latestReasonCode?: string;
}

/**
 * ⭐ **§0 #5·R-11** — `heldQty`·`availableQty` 는 `lot_hold` 가 정본이다(`inventory_balance`
 * 를 쓰지 않는다). `fullyHeld` 면 `heldQty = onHandQty`(전량 보류를 `SUM(hold_qty)` 로 재면
 * NULL 이 되는 함정을 피한다 — R-19 #9). 잔액 행이 0 인 LOT(L7)은 `onHandQty`·`availableQty`·
 * `uomId`·창고·위치를 **키 생략**한다(0 이 아니라 「모른다」 — L-8). ⚠ `uomId` 는 `lot_hold.uom_id`
 * 와 다를 수 있고 `uq_inventory_balance_dim` 밖이라 창고·위치와 같은 「값이 하나일 때만」 규칙을
 * 적용한다 — 단위 축을 판정한 흔적이고 문의 075 를 넓히는 자리다(R-11).
 */
export function lotStatusView(row: LotStatusRow): LotStatusView {
  const onHandQty = row.on_hand_qty === null || row.on_hand_qty === undefined ? undefined : num(row.on_hand_qty);
  const fullyHeld = Boolean(row.fully_held);
  const heldQty = onHandQty === undefined && fullyHeld ? undefined : fullyHeld ? onHandQty : num(row.partial_hold_qty ?? 0);
  const availableQty = onHandQty === undefined || heldQty === undefined ? undefined : onHandQty - heldQty;

  return omitEmpty({
    lotId: Number(row.lot_id),
    lotNo: row.lot_no,
    itemId: Number(row.item_id),
    lotTypeCode: row.lot_type_code,
    lotStatusCode: row.status_code,
    versionNo: row.version_no,
    warehouseId: id(row.warehouse_id),
    locationId: id(row.location_id),
    onHandQty,
    heldQty,
    availableQty,
    uomId: id(row.uom_id),
    openHoldCount: Number(row.open_hold_count),
    fullyHeld,
    latestTransitionAt: row.latest_transition_at instanceof Date ? row.latest_transition_at.toISOString() : undefined,
    latestReasonCode: row.latest_reason_code ?? undefined,
  });
}

function id(value: bigint | number | null): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function num(value: unknown): number {
  return Number(value);
}

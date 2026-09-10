import { Prisma } from '@prisma/client';

import { RecycleEntryRow, recycleEntryView } from './recycle-entry-view';

/**
 * ⭐ **키 생략은 HTTP e2e 로 구조적으로 반증되지 않는다**(README §6-3 ⑹) — ajv 는 required 가
 * 아닌 칸이 `null` 로 와도 「타입이 틀렸다」만 말하고, 아예 빠진 것은 아무도 나무라지 않는다.
 * 그래서 그 층을 여기서 잰다.
 *
 * ⭐ id 를 **표별로 벌려** 둔다 — `recycleEntryId`·`lotId`·`itemId`·`uomId` 가 다 같은 값이면
 * 투영 칸을 뒤바꿔도 초록이다(R-7 ⓑ).
 */
const ENTRY_ID = 90001n;
const LOT_ID = 501n;
const ITEM_ID = 77n;
const UOM_ID = 13n;
const WAREHOUSE_ID = 21n;
const LOCATION_ID = 34n;
const DAY = '2026-08-11';
const AT = new Date('2026-08-11T00:12:00.000Z');

function row(over: Partial<RecycleEntryRow> = {}): RecycleEntryRow {
  return {
    recycle_entry_id: ENTRY_ID,
    recycle_entry_no: 'RC-20260811-0007',
    plant_id: 5n,
    item_id: ITEM_ID,
    lot_id: LOT_ID,
    source_document_type_code: null,
    source_document_id: null,
    recycle_type_code: 'RECYCLED',
    recycle_qty: new Prisma.Decimal('12.5'),
    uom_id: UOM_ID,
    destination_location_id: LOCATION_ID,
    status_code: 'POSTED',
    processed_at: AT,
    created_at: AT,
    created_by: 9n,
    updated_at: AT,
    updated_by: null,
    version_no: 1,
    warehouse_id: WAREHOUSE_ID,
    remarks: '분쇄재 1차',
    lot: { lot_id: LOT_ID, lot_no: 'M00000520260811000001ABCDEFGHJKLMN' },
    ...over,
  } as unknown as RecycleEntryRow;
}

describe('recycleEntryView — 계약에 있는 칸만, 널이면 키를 생략한다', () => {
  it('1. `remarks` 를 저장해도 응답에 그 키가 없다 — 계약 응답에 프로퍼티가 0개다', () => {
    expect(recycleEntryView(row(), DAY)).not.toHaveProperty('remarks');
    expect(recycleEntryView(row({ remarks: null }), DAY)).not.toHaveProperty('remarks');
  });

  it('2. 저장 칸 넷(번호·상태·구분·처리시각)의 키가 없다 — 계약에 없는 칸을 새어 보내지 않는다', () => {
    const view = recycleEntryView(row(), DAY);

    for (const absent of ['recycleEntryNo', 'statusCode', 'recycleTypeCode', 'processedAt']) {
      expect(view).not.toHaveProperty(absent);
    }
    for (const absent of ['sourceDocumentTypeCode', 'sourceDocumentId', 'plantId', 'versionNo']) {
      expect(view).not.toHaveProperty(absent);
    }
  });

  it('3. 선택 칸은 값이 있으면 싣고 **널이면 키를 생략**한다 — `null` 을 실으면 ajv 가 깨진다', () => {
    expect(recycleEntryView(row(), DAY)).toMatchObject({
      recycleEntryId: 90001,
      lotId: 501,
      itemId: 77,
      quantity: 12.5,
      uomId: 13,
      warehouseId: 21,
      locationId: 34,
    });

    const bare = recycleEntryView(
      row({ warehouse_id: null, destination_location_id: null, processed_at: null }),
      DAY,
    );
    expect(bare).not.toHaveProperty('warehouseId');
    expect(bare).not.toHaveProperty('locationId');
    expect(bare).not.toHaveProperty('occurredAt');
  });

  it('4. `businessDate` 는 **받은 문자열 그대로** 나간다 — 타임존 캐스팅 0', () => {
    // ⛔ `processed_at`(UTC 00:12) 에서 도출하면 하노이 로컬로는 다음 날이 된다.
    expect(recycleEntryView(row(), '2026-08-12').businessDate).toBe('2026-08-12');
    expect(recycleEntryView(row(), DAY).businessDate).toBe(DAY);
  });

  it('5. `occurredAt` 은 `processed_at` 의 ISO 다 · `lotNo` 는 LOT 행에서 온다', () => {
    const view = recycleEntryView(row(), DAY);

    expect(view.occurredAt).toBe('2026-08-11T00:12:00.000Z');
    expect(view.lotNo).toBe('M00000520260811000001ABCDEFGHJKLMN');
  });

  it('⛔ LOT 이 안 붙은 행은 던진다 — 이 경로는 «언제나» 채우므로 비면 호출자 버그다', () => {
    expect(() => recycleEntryView(row({ lot: null }), DAY)).toThrow('LOT 이 없다');
  });
});

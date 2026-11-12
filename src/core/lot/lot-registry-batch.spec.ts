import { ContractException } from '../../common/errors';
import { LotLifecycleService } from './lot-lifecycle.service';
import {
  assertMaterialLotBatchShape,
  issueMaterialLotBatchWithin,
  type MaterialLotBatchInput,
  voidMaterialLotsWithin,
} from './lot-registry-batch';
import type { Tx } from './lot-registry.service';

const base: MaterialLotBatchInput = {
  plantId: 1, supplierId: 30, itemId: 20, lotQty: 1000, lotCount: 3, businessDate: '2026-11-12',
};

function errorsOf(fn: () => unknown): { field?: string; code: string }[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ContractException) return (error.getResponse() as { errors: { field?: string; code: string }[] }).errors;
    throw error;
  }
  throw new Error('던지지 않았다');
}

function fakeTx(existingLotNos: string[] = []) {
  const created: { lots: Record<string, unknown>[]; identifiers: Record<string, unknown>[]; batch?: Record<string, unknown> } = {
    lots: [], identifiers: [],
  };
  const holds = jest.fn();
  const requests = jest.fn();
  const tx = {
    plant: { findUnique: jest.fn().mockResolvedValue({ plant_id: 1n }) },
    partner: { findUnique: jest.fn().mockResolvedValue({ partner_id: 30n, partner_code: 'SUP01' }) },
    item: { findUnique: jest.fn().mockResolvedValue({ base_uom_id: 7n, item_code: 'ITEM-A' }) },
    uom: { findUnique: jest.fn().mockResolvedValue({ uom_id: 5n }) },
    material_lot_batch: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.batch = data;
        return { material_lot_batch_id: 900n };
      }),
    },
    lot: {
      findMany: jest.fn(async ({ where }: { where: { lot_no: { startsWith?: string; in?: string[] } } }) => {
        if (where.lot_no.startsWith !== undefined) return existingLotNos.map((lot_no) => ({ lot_no }));
        return (where.lot_no.in ?? []).map((lot_no, index) => ({ lot_id: BigInt(100 + index), lot_no }));
      }),
      createMany: jest.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
        created.lots.push(...data);
        return { count: data.length };
      }),
    },
    lot_external_identifier: {
      createMany: jest.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
        created.identifiers.push(...data);
        return { count: data.length };
      }),
    },
    lot_hold: { create: holds },
    inspection_request: { create: requests },
  };
  return { tx: tx as unknown as Tx, created, holds, requests };
}

describe('자재 관리 LOT 발행 묶음(T016)', () => {
  it('FR-003 950 — 패키징 곱(10 × 100)이 재고 수량과 다르면 400 INVALID(package)', () => {
    expect(errorsOf(() => assertMaterialLotBatchShape({ ...base, lotQty: 950, package: { uomId: 5, count: 10, qtyPerPackage: 100 } })))
      .toEqual([expect.objectContaining({ field: 'package', code: 'INVALID' })]);
    expect(() => assertMaterialLotBatchShape({ ...base, package: { uomId: 5, count: 10, qtyPerPackage: 100 } })).not.toThrow();
    // 십진 곱이다 — 0.1 × 3 이 0.3 과 같다.
    expect(() => assertMaterialLotBatchShape({ ...base, lotQty: 0.3, package: { uomId: 5, count: 3, qtyPerPackage: 0.1 } })).not.toThrow();
  });

  it('수량 ≤ 0 · 개수 0/201 은 400 RANGE', () => {
    expect(errorsOf(() => assertMaterialLotBatchShape({ ...base, lotQty: 0 }))).toEqual([expect.objectContaining({ field: 'lotQty', code: 'RANGE' })]);
    for (const lotCount of [0, 201]) {
      expect(errorsOf(() => assertMaterialLotBatchShape({ ...base, lotCount }))).toEqual([expect.objectContaining({ field: 'lotCount', code: 'RANGE' })]);
    }
  });

  it('수량 단위는 품목 기본 단위다 — 다른 단위를 보내면 400 INVALID(uomId)', async () => {
    const { tx, created } = fakeTx();
    await issueMaterialLotBatchWithin(tx, base, { channel: 'WEB', appUserId: 3 });
    expect(created.lots.every((lot) => lot.uom_id === 7n)).toBe(true);

    const other = fakeTx();
    await expect(issueMaterialLotBatchWithin(other.tx, { ...base, uomId: 8 }, { channel: 'WEB', appUserId: 3 }))
      .rejects.toThrow(ContractException);
    expect(other.created.lots).toHaveLength(0);
  });

  it('번호는 자재 MES 규칙(품목|수량|YYMMDD|공급사|NNNN · 수량 = lotQty)이고 일련은 기존 최댓값 다음부터 이어진다', async () => {
    const { tx, created } = fakeTx(['ITEM-A|1000|261112|SUP01|0002', 'ITEM-A|1000|261112|SUP01|0001']);
    const result = await issueMaterialLotBatchWithin(tx, base, { channel: 'WEB', appUserId: 3 });
    expect(created.lots.map((lot) => lot.lot_no)).toEqual([
      'ITEM-A|1000|261112|SUP01|0003', 'ITEM-A|1000|261112|SUP01|0004', 'ITEM-A|1000|261112|SUP01|0005',
    ]);
    expect(result).toEqual({ batchId: 900n, lotIds: [100n, 101n, 102n] });
  });

  it('대기(WAITING)·검사 대기(INSPECTION_PENDING)로 태어나고 보류·IQC 요청을 만들지 않는다 — 원천은 묶음', async () => {
    const { tx, created, holds, requests } = fakeTx();
    await issueMaterialLotBatchWithin(tx, { ...base, package: { uomId: 5, count: 10, qtyPerPackage: 100 } }, { channel: 'WEB', appUserId: 3 });
    for (const lot of created.lots) {
      expect(lot).toMatchObject({
        lifecycle_status_code: 'WAITING', status_code: 'INSPECTION_PENDING', lot_type_code: 'MATERIAL',
        source_type_code: 'MATERIAL_LOT_BATCH', source_id: 900n, initial_qty: 1000,
        package_uom_id: 5, package_count: 10, qty_per_package: 100, created_by: 3n,
      });
    }
    expect(holds).not.toHaveBeenCalled();
    expect(requests).not.toHaveBeenCalled();
    expect(created.batch).toMatchObject({ created_channel_code: 'WEB', created_by: 3n, created_worker_id: null, lot_count: 3 });
  });

  it('US1-5 공급사 LOT 번호는 LOT 마다 같은 값의 SUPPLIER_LOT 식별자다(N:1) — 없으면 만들지 않는다', async () => {
    const { tx, created } = fakeTx();
    await issueMaterialLotBatchWithin(tx, { ...base, supplierLotNo: '  SL-77 ' }, { channel: 'WEB', appUserId: 3 });
    expect(created.identifiers).toHaveLength(3);
    expect(created.identifiers.map((row) => [row.identifier_type_code, row.external_identifier, row.partner_id]))
      .toEqual(Array.from({ length: 3 }, () => ['SUPPLIER_LOT', 'SL-77', 30]));

    const none = fakeTx();
    await issueMaterialLotBatchWithin(none.tx, { ...base, supplierLotNo: '  ' }, { channel: 'WEB', appUserId: 3 });
    expect(none.created.identifiers).toHaveLength(0);
  });
});

describe('대기 자재 관리 LOT 폐기(T016 · L5)', () => {
  const rows = [
    { lot_id: 1n, lot_no: 'W-1', lot_type_code: 'MATERIAL', source_type_code: 'MATERIAL_LOT_BATCH', source_id: 900n, lifecycle_status_code: 'WAITING' },
    { lot_id: 2n, lot_no: 'A-2', lot_type_code: 'MATERIAL', source_type_code: 'INBOUND_RECEIPT_LINE', source_id: 5n, lifecycle_status_code: 'ACTIVE' },
    { lot_id: 3n, lot_no: 'P-3', lot_type_code: 'PRODUCTION', source_type_code: 'WORK_ORDER', source_id: 7n, lifecycle_status_code: 'WAITING' },
    { lot_id: 4n, lot_no: 'V-4', lot_type_code: 'MATERIAL', source_type_code: 'MATERIAL_LOT_BATCH', source_id: 900n, lifecycle_status_code: 'VOIDED' },
  ];

  function voidTx() {
    const history: Record<string, unknown>[] = [];
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue(rows),
      lot: {
        findMany: jest.fn(async ({ where }: { where: { lot_id: { in: bigint[] } } }) =>
          rows.filter((row) => where.lot_id.in.includes(row.lot_id))),
        update: jest.fn(),
      },
      lot_lifecycle_history: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => history.push(data)) },
    };
    return { tx: tx as unknown as Tx, history };
  }

  it('WAITING 자재 관리 LOT 만 VOIDED(L5)로 옮기고, 나머지(입하됨·생산 선발행·이미 폐기)는 건별 STATE_LOCKED 다', async () => {
    const { tx, history } = voidTx();
    const outcomes = await voidMaterialLotsWithin(tx, new LotLifecycleService(), [1n, 2n, 3n, 4n], new Date('2026-11-12T00:00:00Z'));
    expect(outcomes).toEqual([
      { lotId: 1n, lotNo: 'W-1', voided: true, errorCode: null },
      { lotId: 2n, lotNo: 'A-2', voided: false, errorCode: 'STATE_LOCKED' },
      { lotId: 3n, lotNo: 'P-3', voided: false, errorCode: 'STATE_LOCKED' },
      { lotId: 4n, lotNo: 'V-4', voided: false, errorCode: 'STATE_LOCKED' },
    ]);
    expect(history).toEqual([expect.objectContaining({
      lot_id: 1n, from_lifecycle_status_code: 'WAITING', to_lifecycle_status_code: 'VOIDED', transition_code: 'L5',
      source_document_type_code: 'MATERIAL_LOT_BATCH', source_document_id: 900n,
    })]);
  });

  it('없는 LOT 이 섞이면 아무것도 하지 않고 400 이다', async () => {
    const { tx, history } = voidTx();
    await expect(voidMaterialLotsWithin(tx, new LotLifecycleService(), [1n, 99n], new Date())).rejects.toThrow(ContractException);
    expect(history).toHaveLength(0);
  });
});

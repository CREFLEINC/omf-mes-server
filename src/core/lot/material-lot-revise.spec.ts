import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { reviseMaterialLotWithin } from './material-lot-revise';

/** 피처 014 — 출력 전 수정·번호 다시 받기(R-7 · FR-016·017). */
describe('reviseMaterialLotWithin', () => {
  const LOT_NO = 'A|100|261123|S|0003';
  const tx = (lot: Record<string, unknown> = {}, printed = 0, existing: string[] = []) => {
    const updates: Record<string, unknown>[] = [];
    const client = {
      $queryRaw: jest.fn().mockResolvedValue([{
        lot_id: 10n, lot_no: LOT_NO, plant_id: 3n, item_id: 7n, lot_type_code: 'MATERIAL', lifecycle_status_code: 'WAITING',
        source_type_code: 'MATERIAL_LOT_BATCH', source_id: 90n, initial_qty: new Prisma.Decimal(100), ...lot,
      }]),
      document_issue_log: { count: jest.fn().mockResolvedValue(printed) },
      material_lot_batch: { findUniqueOrThrow: jest.fn().mockResolvedValue({ supplier_id: 5n }) },
      uom: { findUnique: jest.fn(async ({ where }: { where: { uom_id: number } }) => (where.uom_id === 31 ? { uom_id: 31n } : null)) },
      item: { findUnique: jest.fn().mockResolvedValue({ item_code: 'A' }) },
      partner: { findUnique: jest.fn().mockResolvedValue({ partner_code: 'S' }) },
      lot: {
        findMany: jest.fn().mockResolvedValue(existing.map((lot_no) => ({ lot_no }))),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => updates.push(data)),
      },
    } as unknown as Prisma.TransactionClient;
    return { client, updates };
  };
  const revision = (overrides: Record<string, unknown> = {}) => ({
    qty: 80, package: { uomId: 31, count: 8, qtyPerPackage: 10 }, businessDate: '2026-11-23', ...overrides,
  });
  const codeOf = async (promise: Promise<unknown>): Promise<[number, string[]]> => {
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContractException);
    const contract = error as ContractException;
    return [contract.getStatus(), (contract.getResponse() as { errors: { code: string }[] }).errors.map((item) => item.code)];
  };

  it('US3-1 Q6 100 → 80·패키징 8×10: 같은 LOT, 수량 자리 80 의 다음 일련으로 번호를 다시 받는다', async () => {
    const { client, updates } = tx({}, 0, ['A|80|261123|S|0001']);
    await expect(reviseMaterialLotWithin(client, 10n, revision())).resolves.toEqual({
      lotId: 10n, oldLotNo: LOT_NO, lotNo: 'A|80|261123|S|0002', renumbered: true,
    });
    expect(updates[0]).toMatchObject({
      lot_no: 'A|80|261123|S|0002', initial_qty: 80, package_uom_id: 31, package_count: 8, qty_per_package: 10,
    });
  });

  it('US3-1 수량이 같고 패키징만 바꾸면 번호 그대로, package null 이면 패키징 없음', async () => {
    const { client, updates } = tx();
    await expect(reviseMaterialLotWithin(client, 10n, revision({ qty: 100, package: null }))).resolves.toMatchObject({
      lotNo: LOT_NO, renumbered: false,
    });
    expect(updates[0]).toMatchObject({ lot_no: LOT_NO, initial_qty: 100, package_uom_id: null, package_count: null, qty_per_package: null });
  });

  it('US3-2 곱 불일치·qty ≤ 0·없는 단위 → 400, 고치지 않는다', async () => {
    const { client, updates } = tx();
    expect(await codeOf(reviseMaterialLotWithin(client, 10n, revision({ qty: 90 })))).toEqual([400, ['INVALID']]);
    expect(await codeOf(reviseMaterialLotWithin(client, 10n, revision({ qty: 0, package: null })))).toEqual([400, ['RANGE']]);
    expect(await codeOf(reviseMaterialLotWithin(client, 10n, revision({ package: { uomId: 32, count: 8, qtyPerPackage: 10 } })))).toEqual([400, ['INVALID']]);
    expect(updates).toEqual([]);
  });

  it('US3-3 Q7 발행 기록이 있으면 409 ALREADY_PRINTED, 대기 아님·자재 아님은 409 STATE_LOCKED', async () => {
    expect(await codeOf(reviseMaterialLotWithin(tx({}, 1).client, 10n, revision()))).toEqual([409, ['ALREADY_PRINTED']]);
    expect(await codeOf(reviseMaterialLotWithin(tx({ lifecycle_status_code: 'ACTIVE' }).client, 10n, revision()))).toEqual([409, ['STATE_LOCKED']]);
    expect(await codeOf(reviseMaterialLotWithin(tx({ lifecycle_status_code: 'VOIDED' }).client, 10n, revision()))).toEqual([409, ['STATE_LOCKED']]);
    expect(await codeOf(reviseMaterialLotWithin(tx({ lot_type_code: 'PRODUCT' }).client, 10n, revision()))).toEqual([409, ['STATE_LOCKED']]);
  });
});

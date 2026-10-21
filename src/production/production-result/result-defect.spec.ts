import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductionResultRow } from './production-result-view';
import { assertDefectCodes, resolveDefectQty, writeDefects } from './result-defect';

const PROCESS_ID = 30n;

function codes(rows: { id: number; active?: boolean; parent?: bigint | null; mapped?: boolean }[]) {
  return rows.map((row) => ({
    defect_code_id: BigInt(row.id),
    is_active: row.active ?? true,
    parent_defect_code_id: row.parent === undefined ? 1n : row.parent,
    defect_code_process: row.mapped === false ? [] : [{ defect_code_process_id: 9n }],
  }));
}

function prismaWith(codeRows: ReturnType<typeof codes>): PrismaService {
  return {
    work_order: { findUnique: () => Promise.resolve({ routing_operation: { process_id: PROCESS_ID } }) },
    defect_code: { findMany: () => Promise.resolve(codeRows) },
  } as unknown as PrismaService;
}

async function errorFields(promise: Promise<unknown>): Promise<string[]> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ContractException);
  return (error as ContractException).errors.map((item) => item.field as string);
}

describe('생산 실적 불량 유형', () => {
  it('defects 만 오면 불량수량을 그 합으로 채운다', () => {
    expect(resolveDefectQty({ defects: [{ defectCodeId: 1, qty: 0.1 }, { defectCodeId: 2, qty: 0.2 }] })).toBe(0.3);
  });

  it('defects 가 없으면 불량수량을 그대로 둔다', () => {
    expect(resolveDefectQty({ defectQty: 5 })).toBe(5);
    expect(resolveDefectQty({ defectQty: 5, defects: [] })).toBe(5);
  });

  it('불량수량과 defects 합이 다르면 400', () => {
    expect(() => resolveDefectQty({ defectQty: 4, defects: [{ defectCodeId: 1, qty: 3 }] })).toThrow(ContractException);
  });

  it('같은 불량 코드가 두 번이면 400', () => {
    const defects = [
      { defectCodeId: 1, qty: 1 },
      { defectCodeId: 1, qty: 2 },
    ];
    expect(() => resolveDefectQty({ defects })).toThrow(ContractException);
  });

  it('수량이 0 이하인 불량 유형은 400', () => {
    expect(() => resolveDefectQty({ defects: [{ defectCodeId: 1, qty: 0 }] })).toThrow(ContractException);
  });

  it('대분류·비활성·없는 코드·W/O 공정에 매핑되지 않은 코드는 400 — 줄마다 짚는다', async () => {
    const prisma = prismaWith(codes([{ id: 1, parent: null }, { id: 2, active: false }, { id: 3, mapped: false }, { id: 4 }]));
    const defects = [1, 2, 3, 4, 5].map((defectCodeId) => ({ defectCodeId, qty: 1 }));

    expect(await errorFields(assertDefectCodes(prisma, 900, defects))).toEqual([
      'defects[0].defectCodeId',
      'defects[1].defectCodeId',
      'defects[2].defectCodeId',
      'defects[4].defectCodeId',
    ]);
  });

  it('공정에 매핑된 상세 코드면 W/O 공정을 돌려준다', async () => {
    const prisma = prismaWith(codes([{ id: 4 }]));
    await expect(assertDefectCodes(prisma, 900, [{ defectCodeId: 4, qty: 1 }])).resolves.toBe(PROCESS_ID);
  });

  it('불량 기록은 실적의 작업자·설비·금형·시각과 W/O 공정으로 남기고 LOT 은 비운다', async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 1 });
    const occurredAt = new Date('2026-10-21T01:00:00Z');
    const row = {
      production_result_id: 501n,
      work_order_id: 900n,
      uom_id: 7n,
      worker_id: 11n,
      equipment_id: 21n,
      mold_id: null,
      occurred_at: occurredAt,
    } as unknown as ProductionResultRow;
    const tx = { defect_record: { createMany } } as unknown as Prisma.TransactionClient;

    await writeDefects(tx, row, [{ defectCodeId: 4, qty: 2 }], PROCESS_ID, 3);

    const [data] = createMany.mock.calls[0][0].data;
    expect(data).toMatchObject({
      source_type_code: 'FIELD',
      production_result_id: 501n,
      work_order_id: 900n,
      defect_code_id: 4n,
      uom_id: 7n,
      occurrence_process_id: PROCESS_ID,
      detection_process_id: PROCESS_ID,
      worker_id: 11n,
      equipment_id: 21n,
      mold_id: null,
      detected_at: occurredAt,
      created_by: 3,
    });
    expect(data.defect_qty.toNumber()).toBe(2);
    expect(data).not.toHaveProperty('lot_id');
  });
});

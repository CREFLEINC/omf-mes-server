import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { InspectionRequestService } from './inspection-request.service';

/** omf-all-around#64 — IQC 의뢰 응답의 검사 수준(장부 P-87). 기존 칸은 그대로, 칸 하나만 더한다. */

const row = (id: number, overrides: Record<string, unknown> = {}) => ({
  inspection_request_id: BigInt(id),
  inspection_request_no: `IR-${id}`,
  inspection_type_code: 'IQC',
  inspection_plan_version_id: null,
  target_type_code: 'LOT',
  target_id: 1n,
  item_id: 10n,
  lot_id: 3n,
  work_order_id: null,
  production_result_id: null,
  target_qty: new Prisma.Decimal(100),
  uom_id: 1n,
  coverage_from_at: null,
  coverage_to_at: null,
  status_code: 'REQUESTED',
  requested_at: new Date('2026-10-21T00:00:00Z'),
  version_no: 1,
  inspection_level_code: null,
  ...overrides,
});

const harness = (rows: ReturnType<typeof row>[]) => {
  const prisma = {
    inspection_request: {
      findMany: jest.fn().mockResolvedValue(rows),
      count: jest.fn().mockResolvedValue(rows.length),
      findFirst: jest.fn().mockResolvedValue(rows[0]),
    },
    item_inspection_level: {
      findMany: jest.fn().mockResolvedValue([{ item_id: 10n, inspection_level_code: 'TIGHTENED' }]),
    },
  };
  return { prisma, service: new InspectionRequestService(prisma as unknown as PrismaService) };
};

describe('InspectionRequestService — IQC 검사 수준 칸', () => {
  it('대기 의뢰는 품목의 현재 수준, 확정 때 기록한 의뢰는 기록값을 싣는다', async () => {
    const { service } = harness([row(1), row(2, { status_code: 'COMPLETED', inspection_level_code: 'NORMAL' })]);
    const { items } = await service.list({});
    expect(items.map((item) => item.inspectionLevelCode)).toEqual(['TIGHTENED', 'NORMAL']);
    expect(items[0]).toMatchObject({ inspectionRequestId: 1, inspectionRequestNo: 'IR-1', statusCode: 'REQUESTED' });
  });

  it('기록 없이 끝난 의뢰·PQC 의뢰는 칸을 싣지 않는다', async () => {
    const { service, prisma } = harness([
      row(1, { status_code: 'COMPLETED' }),
      row(2, { inspection_type_code: 'PQC', lot_id: null }),
    ]);
    const { items } = await service.list({});
    expect(items.map((item) => 'inspectionLevelCode' in item)).toEqual([false, false]);
    expect(prisma.item_inspection_level.findMany).not.toHaveBeenCalled();
  });

  it('수준 미설정 품목은 칸을 싣지 않는다', async () => {
    const { service, prisma } = harness([row(1, { item_id: 77n })]);
    prisma.item_inspection_level.findMany.mockResolvedValueOnce([]);
    expect(await service.detail(1)).not.toHaveProperty('inspectionLevelCode');
  });
});

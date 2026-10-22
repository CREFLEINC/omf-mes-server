import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../prisma/prisma.service';
import { OutboundMessage } from '../outbound-builder';
import { productionReceiptBuilder } from './production-receipt.send';

const D = (value: number): Prisma.Decimal => new Prisma.Decimal(value);

const ORDER = {
  erp_order_no: 'PD2610210001',
  erp_operation_no: '020',
  uom_id: 1n,
  plant: { plant_code: 'PL11', timezone_code: 'Asia/Ho_Chi_Minh' },
};
const WORK_ORDER = {
  work_order_no: 'WO-2610-0001',
  work_order_type_code: 'NORMAL',
  // 하노이 2026-10-22 01:30 — UTC 로는 아직 21일이다.
  closed_at: new Date('2026-10-21T18:30:00.000Z'),
  item: { base_uom_id: 1n },
  shift: null as { crosses_midnight: boolean } | null,
  routing_operation: { routing_id: 7n, operation_seq: 20 },
  production_plan: { production_order: ORDER } as { production_order: Record<string, unknown> } | null,
};

interface Setup {
  workOrder?: Partial<typeof WORK_ORDER>;
  order?: Partial<typeof ORDER>;
  lastSeq?: number;
  units?: bigint[];
  sums?: Partial<Record<'good_qty' | 'defect_qty' | 'scrap_qty', Prisma.Decimal | null>>;
}

function fake(setup: Setup): PrismaService {
  const workOrder = {
    ...WORK_ORDER,
    production_plan: { production_order: { ...ORDER, ...setup.order } },
    ...setup.workOrder,
  };
  return {
    work_order: { findUniqueOrThrow: async () => workOrder },
    routing_operation: { aggregate: async () => ({ _max: { operation_seq: setup.lastSeq ?? 20 } }) },
    production_result: {
      findMany: async () => (setup.units ?? [1n]).map((uom_id) => ({ uom_id })),
      aggregate: async () => ({ _sum: { good_qty: D(85), defect_qty: D(2), scrap_qty: D(1), ...setup.sums } }),
    },
  } as unknown as PrismaService;
}

const MESSAGE: OutboundMessage = {
  id: 1n,
  interfaceCode: 'IF-WO-CLOSE-SEND',
  targetTypeCode: 'WORK_ORDER',
  targetId: 11n,
  payload: {},
};
const build = (setup: Setup = {}) => productionReceiptBuilder(fake(setup)).build(MESSAGE);

describe('productionReceiptBuilder', () => {
  it('마감 하나를 양품 1행·불량 1행으로 바꾼다 — 불량은 불량 + 폐기, 실적일은 마감한 날의 공장 현지 날짜', async () => {
    const rows = await build();

    expect(rows.map((row) => row.table.name)).toEqual(['T_IF_RCV_PROD_RSLT_KO324', 'T_IF_RCV_PROD_RSLT_KO324']);
    expect(rows[0].values).toEqual({
      PLANT_CD: 'PL11',
      PRODT_ORDER_NO: 'PD2610210001',
      OPR_NO: '020',
      REPORT_DT: '2026-10-22',
      REPORT_TYPE: 'G',
      PROD_QTY_IN_ORDER_UNIT: '85',
      PROD_QTY_IN_BASE_UNIT: '85',
      SHIFT_CD: 'D',
      REASON_CD: null,
      LOT_NO: '',
      LOT_SUB_NO: 0,
      REMARK: 'WO-2610-0001',
      JOB_STATUS: 'P',
      INPUT_TYPE: 'D',
      TRACKING_NO: '*',
      SUBCONTRACT_PRC: 0,
      MOLD_BASE_SEQ: '',
    });
    expect(rows[1].values).toMatchObject({ REPORT_TYPE: 'B', PROD_QTY_IN_ORDER_UNIT: '3', PROD_QTY_IN_BASE_UNIT: '3' });
  });

  it.each([
    [true, 'N'],
    [false, 'D'],
  ])('계획 근무조가 자정을 넘는가(%s) → %s', async (crossesMidnight, shiftCode) => {
    const [row] = await build({ workOrder: { shift: { crosses_midnight: crossesMidnight } } });

    expect(row.values.SHIFT_CD).toBe(shiftCode);
  });

  it('수량이 0 인 쪽은 보내지 않는다 — 둘 다 0 이면 보낼 것이 없다', async () => {
    expect((await build({ sums: { good_qty: D(0) } })).map((row) => row.values.REPORT_TYPE)).toEqual(['B']);
    expect((await build({ sums: { defect_qty: null, scrap_qty: null } })).map((row) => row.values.REPORT_TYPE)).toEqual(['G']);
    expect(await build({ sums: { good_qty: null, defect_qty: null, scrap_qty: null } })).toEqual([]);
  });

  it('소수 수량은 지수 표기 없이 그대로 싣는다', async () => {
    const [row] = await build({ sums: { good_qty: D(0.000001) } });

    expect(row.values.PROD_QTY_IN_ORDER_UNIT).toBe('0.000001');
  });

  it('라우팅의 마지막 공정 W/O 만 보낸다', async () => {
    expect(await build({ lastSeq: 30 })).toEqual([]);
  });

  it.each([
    ['REWORK', 0],
    ['EMERGENCY', 2],
  ])('W/O 종류 %s → %i행 — 재작업은 처음 W/O 가 불량으로 보낸 수량이라 다시 보내지 않는다', async (type, count) => {
    expect(await build({ workOrder: { work_order_type_code: type } })).toHaveLength(count);
  });

  it('ERP W/O 에 붙지 않은 MES W/O 는 보낼 곳이 없다', async () => {
    expect(await build({ workOrder: { production_plan: null } })).toEqual([]);
    expect(await build({ order: { erp_order_no: null as unknown as string } })).toEqual([]);
  });

  it('ERP W/O 에 공정번호가 없으면 실패한다', async () => {
    await expect(build({ order: { erp_operation_no: null as unknown as string } })).rejects.toThrow(
      'ERP W/O PD2610210001 에 공정번호(OPR_NO)가 없다',
    );
  });

  it('ERP W/O 단위나 실적 단위가 품목 기본단위와 다르면 실패한다 — 환산이 필요하다', async () => {
    const message = 'ERP W/O PD2610210001 의 단위가 품목 기본단위와 달라 환산이 필요하다';
    await expect(build({ order: { uom_id: 2n } })).rejects.toThrow(message);
    await expect(build({ units: [1n, 2n] })).rejects.toThrow(message);
  });

  it('비고에는 MES W/O 번호를 칸 길이(20자)까지 싣는다', async () => {
    const [row] = await build({ workOrder: { work_order_no: 'WO-20261022-PL11-000123' } });

    expect(row.values.REMARK).toBe('WO-20261022-PL11-000');
  });
});

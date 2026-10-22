/**
 * ERP 보내기 — 생산입고 바꾸개를 로컬 DB 의 실제 W/O·실적으로 돌린다. 만든 행은 실제 MSSQL 사본 표에 넣어 본다
 * (`ERP_RELAY_E2E=1`) — 중계 표의 NOT NULL 칸이 다 차는지가 여기서만 드러난다.
 */
import * as mssql from 'mssql';

import { OutboundMessage } from '../src/integration/erp/outbound-builder';
import { RowDraft } from '../src/integration/erp/outbound-rows';
import { PROD_RSLT } from '../src/integration/erp/rcv-tables';
import { RelayClient } from '../src/integration/erp/relay-client';
import { productionReceiptBuilder } from '../src/integration/erp/send/production-receipt.send';
import { PrismaService } from '../src/prisma/prisma.service';
import { RELAY, connectSa, createCopy, describeRelay, dropCopy, ensurePlant } from './erp-relay.fixture';

const PREFIX = `PR${Date.now().toString(36).toUpperCase()}`;
// 하노이 2026-10-22 01:30 — UTC 로는 아직 21일이다.
const CLOSED_AT = new Date('2026-10-21T18:30:00.000Z');

describe('ERP 보내기 — 생산입고 바꾸개 (e2e)', () => {
  let prisma: PrismaService;
  const createdPlants: bigint[] = [];
  const ids: Record<string, bigint> = {};

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    await ensurePlant(prisma, 'PL11', createdPlants);
    await seed();
  });

  afterAll(async () => {
    const workOrders = [ids.lastWorkOrder, ids.firstWorkOrder, ids.reworkWorkOrder].filter(Boolean);
    await prisma.production_result.deleteMany({ where: { work_order_id: { in: workOrders } } });
    await prisma.work_order.deleteMany({ where: { work_order_id: { in: workOrders } } });
    await prisma.production_plan.deleteMany({ where: { production_plan_id: ids.plan } });
    await prisma.production_order.deleteMany({ where: { production_order_id: ids.order } });
    await prisma.bom.deleteMany({ where: { bom_id: ids.bom } });
    await prisma.routing_operation.deleteMany({ where: { routing_id: ids.routing } });
    await prisma.routing.deleteMany({ where: { routing_id: ids.routing } });
    await prisma.process.deleteMany({ where: { process_id: ids.process } });
    await prisma.item.deleteMany({ where: { item_id: ids.item } });
    await prisma.shift.deleteMany({ where: { shift_id: ids.shift } });
    await prisma.worker.deleteMany({ where: { worker_id: ids.worker } });
    await prisma.plant.deleteMany({ where: { plant_id: { in: createdPlants } } });
    await prisma.$disconnect();
  });

  async function seed(): Promise<void> {
    const plant = await prisma.plant.findFirstOrThrow({ where: { plant_code: 'PL11' } });
    const businessUnitId = plant.business_unit_id ?? (await prisma.business_unit.findFirstOrThrow()).business_unit_id;
    const uom = await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } });
    const item = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT`, item_name: '생산입고 검사 품목', item_type_code: 'FINISHED_GOODS', base_uom_id: uom.uom_id },
    });
    ids.item = item.item_id;
    ids.process = (
      await prisma.process.create({ data: { process_code: `${PREFIX}-PR`, process_name: '조립', process_type_code: 'ASSEMBLY' } })
    ).process_id;
    ids.routing = (
      await prisma.routing.create({
        data: { item_id: item.item_id, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' },
      })
    ).routing_id;
    const operations: { routing_operation_id: bigint }[] = [];
    for (const seq of [10, 20]) {
      operations.push(
        await prisma.routing_operation.create({
          data: { routing_id: ids.routing, operation_seq: seq, process_id: ids.process, operation_name: `공정${seq}` },
        }),
      );
    }
    ids.bom = (
      await prisma.bom.create({
        data: {
          parent_item_id: item.item_id,
          bom_code: `${PREFIX}-BOM`,
          bom_version: 1,
          status_code: 'ACTIVE',
          effective_from: new Date('2026-01-01T00:00:00.000Z'),
          base_qty: 1,
          base_uom_id: uom.uom_id,
        },
      })
    ).bom_id;
    ids.order = (
      await prisma.production_order.create({
        data: {
          production_order_no: `${PREFIX}-PD`,
          erp_order_no: `${PREFIX}-PD`,
          erp_operation_no: '020',
          business_unit_id: businessUnitId,
          plant_id: plant.plant_id,
          item_id: item.item_id,
          order_qty: 100,
          uom_id: uom.uom_id,
          status_code: 'CONFIRMED',
        },
      })
    ).production_order_id;
    ids.plan = (
      await prisma.production_plan.create({
        data: {
          production_order_id: ids.order,
          plan_no: `${PREFIX}-PP`,
          plan_date: new Date('2026-10-21T00:00:00.000Z'),
          planned_qty: 100,
          uom_id: uom.uom_id,
          bom_id: ids.bom,
          routing_id: ids.routing,
          status_code: 'CONFIRMED',
        },
      })
    ).production_plan_id;
    ids.shift = (
      await prisma.shift.create({
        data: {
          plant_id: plant.plant_id,
          shift_code: `${PREFIX}-N`,
          shift_name: '야간',
          start_time: new Date('1970-01-01T20:00:00.000Z'),
          end_time: new Date('1970-01-01T08:00:00.000Z'),
          crosses_midnight: true,
        },
      })
    ).shift_id;
    ids.worker = (
      await prisma.worker.create({
        data: {
          worker_no: `${PREFIX}-WK`,
          worker_name: '생산입고 검사 작업자',
          business_unit_id: businessUnitId,
          plant_id: plant.plant_id,
          status_code: 'EMPLOYED',
        },
      })
    ).worker_id;

    const workOrder = async (key: string, operation: number, type = 'NORMAL'): Promise<bigint> => {
      const created = await prisma.work_order.create({
        data: {
          work_order_no: `${PREFIX}-${key}`,
          work_order_type_code: type,
          production_plan_id: ids.plan,
          routing_operation_id: operations[operation].routing_operation_id,
          item_id: item.item_id,
          order_qty: 100,
          uom_id: uom.uom_id,
          planned_shift_id: ids.shift,
          status_code: 'IN_PROGRESS',
        },
      });
      return created.work_order_id;
    };
    ids.firstWorkOrder = await workOrder('WO10', 0);
    ids.lastWorkOrder = await workOrder('WO20', 1);
    ids.reworkWorkOrder = await workOrder('RW20', 1, 'REWORK');

    let sequence = 0;
    const result = async (
      workOrderId: bigint,
      qty: Partial<Record<'good_qty' | 'defect_qty' | 'hold_qty' | 'scrap_qty' | 'rework_qty', number>>,
      corrects?: bigint,
    ): Promise<bigint> => {
      sequence += 1;
      const created = await prisma.production_result.create({
        data: {
          production_result_no: `${PREFIX}-R${sequence}`,
          work_order_id: workOrderId,
          result_sequence: sequence,
          corrects_production_result_id: corrects,
          ...qty,
          uom_id: uom.uom_id,
          result_source_code: 'MANUAL',
          occurred_at: new Date('2026-10-21T15:00:00.000Z'),
          worker_id: ids.worker,
          status_code: 'CONFIRMED',
          idempotency_key: `${PREFIX}-R${sequence}`,
        },
      });
      return created.production_result_id;
    };
    // 정정된 원본(50)은 빼고 정정본(45)을 센다.
    const original = await result(ids.lastWorkOrder, { good_qty: 50 });
    await result(ids.lastWorkOrder, { good_qty: 45, defect_qty: 2, scrap_qty: 1 }, original);
    await result(ids.lastWorkOrder, { good_qty: 40, hold_qty: 3, rework_qty: 1 });
    await result(ids.firstWorkOrder, { good_qty: 100 });
    await result(ids.reworkWorkOrder, { good_qty: 3 });

    await prisma.work_order.updateMany({
      where: { work_order_id: { in: [ids.firstWorkOrder, ids.lastWorkOrder, ids.reworkWorkOrder] } },
      data: { status_code: 'CLOSED', closed_at: CLOSED_AT },
    });
  }

  const build = (workOrderId: bigint): Promise<RowDraft[]> => {
    const message: OutboundMessage = {
      id: 1n,
      interfaceCode: 'IF-WO-CLOSE-SEND',
      targetTypeCode: 'WORK_ORDER',
      targetId: workOrderId,
      payload: {},
    };
    return productionReceiptBuilder(prisma).build(message);
  };

  it('마지막 공정 W/O 마감을 양품·불량 두 행으로 — 정정된 원본은 빼고, 불량은 불량 + 폐기', async () => {
    const rows = await build(ids.lastWorkOrder);

    expect(rows.map((row) => row.values)).toEqual([
      expect.objectContaining({ REPORT_TYPE: 'G', PROD_QTY_IN_ORDER_UNIT: '85' }),
      expect.objectContaining({ REPORT_TYPE: 'B', PROD_QTY_IN_ORDER_UNIT: '3' }),
    ]);
    expect(rows[0].values).toMatchObject({
      PLANT_CD: 'PL11',
      PRODT_ORDER_NO: `${PREFIX}-PD`,
      OPR_NO: '020',
      REPORT_DT: '2026-10-22',
      SHIFT_CD: 'N',
      REMARK: `${PREFIX}-WO20`,
    });
  });

  it('앞 공정 W/O 와 재작업 W/O 는 보내지 않는다', async () => {
    expect(await build(ids.firstWorkOrder)).toEqual([]);
    expect(await build(ids.reworkWorkOrder)).toEqual([]);
  });

  describeRelay('중계 DB', () => {
    const COPY = { ...PROD_RSLT, name: 'E2E_IF_RCV_PROD_RSLT_RECEIPT' };
    let sa: mssql.ConnectionPool;
    let relay: RelayClient;

    beforeAll(async () => {
      sa = await connectSa();
      await createCopy(sa, COPY.name, PROD_RSLT.name);
      relay = new RelayClient(RELAY);
    });

    afterAll(async () => {
      await relay?.close();
      await dropCopy(sa, COPY.name);
      await sa?.close();
    });

    it('만든 행이 중계 표에 그대로 들어간다 — 비어서는 안 되는 칸이 다 찼다', async () => {
      const rows = await build(ids.lastWorkOrder);

      await relay.insertRows(
        rows.map((row, index) => ({
          table: COPY,
          values: { ...row.values, IF_SEQ: index + 1, CREATE_TYPE: 'A', ...PROD_RSLT.initialFlags },
        })),
      );

      const stored = await sa.request().query(
        `SELECT REPORT_TYPE, PROD_QTY_IN_ORDER_UNIT, PROD_QTY_IN_BASE_UNIT, REPORT_DT, SHIFT_CD, REASON_CD, ` +
          `INPUT_TYPE, TRACKING_NO, JOB_STATUS, SUBCONTRACT_PRC, MOLD_BASE_SEQ FROM dbo.${COPY.name} ORDER BY IF_SEQ`,
      );
      expect(stored.recordset).toEqual([
        {
          REPORT_TYPE: 'G', PROD_QTY_IN_ORDER_UNIT: 85, PROD_QTY_IN_BASE_UNIT: 85, REPORT_DT: '2026-10-22', SHIFT_CD: 'N',
          REASON_CD: null, INPUT_TYPE: 'D', TRACKING_NO: '*', JOB_STATUS: 'P', SUBCONTRACT_PRC: 0, MOLD_BASE_SEQ: '',
        },
        expect.objectContaining({ REPORT_TYPE: 'B', PROD_QTY_IN_ORDER_UNIT: 3 }),
      ]);
    });
  });
});

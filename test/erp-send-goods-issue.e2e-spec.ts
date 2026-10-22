/**
 * ERP 보내기 — 제품출하 바꾸개를 로컬 DB 의 실제 출하로 돌린다. 만든 행은 실제 MSSQL 사본 표에 넣어 본다
 * (`ERP_RELAY_E2E=1`) — 중계 표의 NOT NULL 칸이 다 차는지가 여기서만 드러난다.
 */
import * as mssql from 'mssql';

import { OutboundMessage } from '../src/integration/erp/outbound-builder';
import { RowDraft } from '../src/integration/erp/outbound-rows';
import { GOODS_ISSUE } from '../src/integration/erp/rcv-tables';
import { RelayClient } from '../src/integration/erp/relay-client';
import { goodsIssueBuilder } from '../src/integration/erp/send/goods-issue.send';
import { PrismaService } from '../src/prisma/prisma.service';
import { RELAY, connectSa, createCopy, describeRelay, dropCopy, ensurePlant } from './erp-relay.fixture';

const PREFIX = `GI${Date.now().toString(36).toUpperCase()}`;
// 하노이 2026-10-22 01:30:05 — UTC 로는 아직 21일이다.
const SHIPPED_AT = new Date('2026-10-21T18:30:05.000Z');

describe('ERP 보내기 — 제품출하 바꾸개 (e2e)', () => {
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
    await prisma.shipment_line.deleteMany({ where: { shipment_id: ids.shipment } });
    await prisma.shipment.deleteMany({ where: { shipment_id: ids.shipment } });
    await prisma.shipment_request_line.deleteMany({ where: { shipment_request_id: ids.request } });
    await prisma.shipment_request.deleteMany({ where: { shipment_request_id: ids.request } });
    await prisma.sales_order_line.deleteMany({ where: { sales_order_id: ids.order } });
    await prisma.sales_order.deleteMany({ where: { sales_order_id: ids.order } });
    await prisma.warehouse.deleteMany({ where: { warehouse_id: ids.warehouse } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.partner.deleteMany({ where: { partner_id: ids.customer } });
    await prisma.plant.deleteMany({ where: { plant_id: { in: createdPlants } } });
    await prisma.$disconnect();
  });

  async function seed(): Promise<void> {
    const plant = await prisma.plant.findFirstOrThrow({ where: { plant_code: 'PL11' } });
    const businessUnitId = plant.business_unit_id ?? (await prisma.business_unit.findFirstOrThrow()).business_unit_id;
    const uom = await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } });
    const items = [];
    for (const suffix of ['A', 'B']) {
      items.push(
        await prisma.item.create({
          data: { item_code: `${PREFIX}-${suffix}`, item_name: `출하 검사 품목 ${suffix}`, item_type_code: 'FINISHED_GOODS', base_uom_id: uom.uom_id },
        }),
      );
    }
    ids.customer = (
      await prisma.partner.create({ data: { partner_code: `${PREFIX}-C`, partner_name: '출하 검사 고객', erp_partner_code: 'C0001' } })
    ).partner_id;
    ids.warehouse = (
      await prisma.warehouse.create({
        data: {
          plant_id: plant.plant_id,
          business_unit_id: businessUnitId,
          warehouse_code: `${PREFIX}-WH`,
          warehouse_name: '출하 검사 창고',
          warehouse_type_code: 'FINISHED',
          management_level_code: 'WAREHOUSE',
        },
      })
    ).warehouse_id;
    ids.order = (
      await prisma.sales_order.create({
        data: {
          sales_order_no: `${PREFIX}-SO`,
          erp_sales_order_no: `${PREFIX}-SO`,
          erp_movement_type_code: 'I31',
          customer_id: ids.customer,
          ship_to_partner_id: ids.customer,
          order_date: new Date('2026-10-01T00:00:00.000Z'),
          status_code: 'CONFIRMED',
        },
      })
    ).sales_order_id;
    const orderLine = await prisma.sales_order_line.create({
      data: {
        sales_order_id: ids.order,
        line_no: 1,
        item_id: items[0].item_id,
        ordered_qty: 10,
        uom_id: uom.uom_id,
        erp_storage_location_code: 'S210',
      },
    });
    ids.request = (
      await prisma.shipment_request.create({
        data: {
          shipment_request_no: `${PREFIX}-SR`,
          customer_id: ids.customer,
          ship_to_partner_id: ids.customer,
          requested_ship_date: new Date('2026-10-22T00:00:00.000Z'),
          status_code: 'CONFIRMED',
          sales_order_id: ids.order,
        },
      })
    ).shipment_request_id;
    // 둘째 라인은 수주에 붙지 않았다 — ERP 로 갈 곳이 없다.
    const requestLines = [];
    for (const [index, item] of items.entries()) {
      requestLines.push(
        await prisma.shipment_request_line.create({
          data: {
            shipment_request_id: ids.request,
            line_no: index + 1,
            sales_order_line_id: index === 0 ? orderLine.sales_order_line_id : null,
            item_id: item.item_id,
            requested_qty: 8,
            uom_id: uom.uom_id,
          },
        }),
      );
    }
    ids.shipment = (
      await prisma.shipment.create({
        data: {
          shipment_no: `${PREFIX}-SH`,
          shipment_request_id: ids.request,
          warehouse_id: ids.warehouse,
          status_code: 'CONFIRMED',
          shipped_at: SHIPPED_AT,
          confirmed_at: SHIPPED_AT,
        },
      })
    ).shipment_id;
    for (const [index, requestLine] of requestLines.entries()) {
      await prisma.shipment_line.create({
        data: {
          shipment_id: ids.shipment,
          line_no: index + 1,
          shipment_request_line_id: requestLine.shipment_request_line_id,
          item_id: requestLine.item_id,
          shipped_qty: 7.5,
          uom_id: uom.uom_id,
        },
      });
    }
  }

  const build = (): Promise<RowDraft[]> => {
    const message: OutboundMessage = {
      id: 1n,
      interfaceCode: 'IF-SHIPMENT-PGI-SEND',
      targetTypeCode: 'SHIPMENT',
      targetId: ids.shipment,
      payload: {},
    };
    return goodsIssueBuilder(prisma).build(message);
  };

  it('수주에 붙은 출하 라인만 한 행씩 — 수주의 수불유형·창고·거래처, 공장 현지 출고 시각', async () => {
    const rows = await build();

    expect(rows.map((row) => row.values)).toEqual([
      expect.objectContaining({
        DN_REQ_NO: `${PREFIX}-SH`,
        DN_REQ_SEQ: 1,
        MOV_TYPE: 'I31',
        SHIP_TO_PARTY: 'C0001',
        ACTUAL_GI_DT: '2026-10-22 01:30:05',
        PLANT_CD: 'PL11',
        SL_CD: 'S210',
        ITEM_CD: `${PREFIX}-A`,
        GI_UNIT: 'EA',
        REQ_QTY: '8',
        GI_QTY: '7.5',
      }),
    ]);
  });

  describeRelay('중계 DB', () => {
    const COPY = { ...GOODS_ISSUE, name: 'E2E_IF_RCV_GOODS_ISSUE_SEND' };
    let sa: mssql.ConnectionPool;
    let relay: RelayClient;

    beforeAll(async () => {
      sa = await connectSa();
      await createCopy(sa, COPY.name, GOODS_ISSUE.name);
      relay = new RelayClient(RELAY);
    });

    afterAll(async () => {
      await relay?.close();
      await dropCopy(sa, COPY.name);
      await sa?.close();
    });

    it('만든 행이 중계 표에 그대로 들어간다 — 비어서는 안 되는 칸이 다 찼다', async () => {
      const rows = await build();

      await relay.insertRows(
        rows.map((row) => ({ table: COPY, values: { ...row.values, IF_SEQ: 1, CREATE_TYPE: 'A', ...GOODS_ISSUE.initialFlags } })),
      );

      const stored = await sa.request().query(
        `SELECT DN_REQ_NO, MOV_TYPE, ACTUAL_GI_DT, GI_QTY, DN_SEQ_NO, ERP_APPLY_FLAG1, ERP_APPLY_FLAG2 FROM dbo.${COPY.name}`,
      );
      expect(stored.recordset).toEqual([
        {
          DN_REQ_NO: `${PREFIX}-SH`,
          MOV_TYPE: 'I31',
          // datetime 은 시간대가 없다 — 드라이버는 UTC 로 읽어 Date 를 만든다. 넣은 벽시계 그대로다.
          ACTUAL_GI_DT: new Date('2026-10-22T01:30:05.000Z'),
          GI_QTY: 7.5,
          DN_SEQ_NO: 1,
          ERP_APPLY_FLAG1: '',
          ERP_APPLY_FLAG2: '',
        },
      ]);
    });
  });
});

/**
 * ERP 보내기 — 구매입고(장부 P-104). 입고 서비스로 실제 입고를 만들어, ERP 발주에 이어진 자재 입고만 적재되는지 본다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import * as mssql from 'mssql';

import { AppModule } from '../src/app.module';
import { OutboxService } from '../src/core/outbox';
import { OutboundRows, RowDraft } from '../src/integration/erp/outbound-rows';
import { GR_INFOR } from '../src/integration/erp/rcv-tables';
import { RelayClient } from '../src/integration/erp/relay-client';
import { goodsReceiptBuilder } from '../src/integration/erp/send/goods-receipt.send';
import { enqueueReceiptCancel } from '../src/logistics/goods-receipt/erp-receipt';
import { GoodsReceiptService } from '../src/logistics/goods-receipt/goods-receipt.service';
import { InboundExcessService } from '../src/logistics/inbound-receipt/inbound-excess.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RELAY, connectSa, createCopy, describeRelay, dropCopy, ensurePlant } from './erp-relay.fixture';

const PREFIX = `GR${Date.now().toString(36).toUpperCase()}`;
const RECEIVED_AT = new Date('2026-10-21T18:30:00.000Z');

describe('ERP 보내기 — 구매입고 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let receipts: GoodsReceiptService;
  let excesses: InboundExcessService;
  const createdPlants: bigint[] = [];
  const ids: Record<string, bigint> = {};
  let userId: number;
  let sequence = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    receipts = app.get(GoodsReceiptService);
    excesses = app.get(InboundExcessService);
    await ensurePlant(prisma, 'PL11', createdPlants);
    await seed();
  });

  afterAll(async () => {
    // 적재한 메시지는 지운다 — 남기면 이 DB 에서 보내기를 켤 때 실제로 나간다. 입고·원장은 접두어로 남는다.
    await prisma.erp_outbound_row.deleteMany({ where: { document_no: { in: received } } });
    await prisma.integration_message.deleteMany({
      where: {
        message_key: {
          in: [
            ...received.map((no) => `IF-GR-SEND:${no}`),
            ...received.map((no) => `IF-GR-SEND:CANCEL:${no}`),
            ...allocationIds.map((id) => `IF-GR-SEND:ALLOC:${id}`),
          ],
        },
      },
    });
    // 특채는 지운다 — 남기면 특채 목록 검사(quality-concession)의 «쓸 수 있는 특채»에 섞인다.
    await prisma.concession.deleteMany({ where: { concession_no: { startsWith: PREFIX } } });
    await prisma.approval_request.deleteMany({ where: { approval_request_no: { startsWith: PREFIX } } });
    await prisma.nonconformance.deleteMany({ where: { nonconformance_no: { startsWith: PREFIX } } });
    await app.close();
  });

  const received: string[] = [];
  /** 이 파일이 만든 배정 — 지울 `ALLOC` 묶음 키를 찾는다. */
  const allocationIds: bigint[] = [];

  async function seed(): Promise<void> {
    userId = Number((await prisma.app_user.findFirstOrThrow({ orderBy: { app_user_id: 'asc' } })).app_user_id);
    const plant = await prisma.plant.findFirstOrThrow({ where: { plant_code: 'PL11' } });
    ids.plant = plant.plant_id;
    const businessUnitId = plant.business_unit_id ?? (await prisma.business_unit.findFirstOrThrow()).business_unit_id;
    ids.uom = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    ids.item = (
      await prisma.item.create({
        data: { item_code: `${PREFIX}-IT`, item_name: '구매입고 검사 자재', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.uom },
      })
    ).item_id;
    ids.supplier = (
      await prisma.partner.create({ data: { partner_code: `${PREFIX}-S`, partner_name: '구매입고 검사 공급사', erp_partner_code: 'S0001' } })
    ).partner_id;
    for (const [key, isDefect] of [['warehouse', false], ['defectWarehouse', true]] as const) {
      ids[key] = (
        await prisma.warehouse.create({
          data: {
            plant_id: plant.plant_id,
            business_unit_id: businessUnitId,
            warehouse_code: `${PREFIX}-${key === 'warehouse' ? 'WH' : 'NG'}`,
            warehouse_name: `구매입고 검사 ${key}`,
            warehouse_type_code: 'RAW',
            management_level_code: 'LOCATION',
            is_defect: isDefect,
          },
        })
      ).warehouse_id;
      ids[`${key}Location`] = (
        await prisma.location.create({
          data: { warehouse_id: ids[key], location_code: `${PREFIX}-${key}-L`, location_name: '구매입고 검사 위치', location_type_code: 'BIN' },
        })
      ).location_id;
    }
    for (const [key, erpNo] of [['erpOrder', `${PREFIX}-PO`], ['mesOrder', null]] as const) {
      ids[key] = (
        await prisma.purchase_order.create({
          data: {
            purchase_order_no: `${PREFIX}-${key}`,
            erp_purchase_order_no: erpNo,
            supplier_id: ids.supplier,
            business_unit_id: businessUnitId,
            plant_id: plant.plant_id,
            order_date: new Date('2026-10-01T00:00:00.000Z'),
            status_code: 'CONFIRMED',
            erp_purchase_group_code: 'P01',
            erp_io_type_code: 'DGR',
          },
        })
      ).purchase_order_id;
      for (const lineNo of [1, 2]) {
        ids[`${key}Line${lineNo === 1 ? '' : lineNo}`] = (
          await prisma.purchase_order_line.create({
            data: {
              purchase_order_id: ids[key],
              line_no: lineNo,
              item_id: ids.item,
              ordered_qty: 1000,
              uom_id: ids.uom,
              erp_storage_location_code: lineNo === 1 ? 'S240' : 'S230',
            },
          })
        ).purchase_order_line_id;
      }
    }
    ids.inbound = (
      await prisma.inbound_receipt.create({
        data: {
          inbound_receipt_no: `${PREFIX}-IR`,
          supplier_id: ids.supplier,
          plant_id: plant.plant_id,
          receipt_datetime: RECEIVED_AT,
          status_code: 'REGISTERED',
        },
      })
    ).inbound_receipt_id;
  }

  /**
   * ERP·MES 발주 라인에 이은 입하 줄 하나와 그 LOT. 초과분은 다른 P/O 라인에 이었거나(`orderLine`) 아직 안 이었다.
   * 쓰기 경로처럼 배정도 적는다 — 줄의 P/O 몫(받은 수량 − 초과분) 하나와 이은 초과분마다 하나.
   */
  async function inboundLot(
    orderLine: bigint,
    qty: number,
    excesses: { qty: number; orderLine: bigint | null }[] = [],
  ): Promise<{ inboundLineId: bigint; lotId: bigint; excessIds: bigint[] }> {
    sequence += 1;
    const line = await prisma.inbound_receipt_line.create({
      data: {
        inbound_receipt_id: ids.inbound,
        line_no: sequence,
        purchase_order_line_id: orderLine,
        item_id: ids.item,
        received_qty: qty,
        uom_id: ids.uom,
        inspection_required: false,
        supplier_lot_label_attached: true,
        status_code: 'REGISTERED',
      },
    });
    const created: bigint[] = [];
    for (const excess of excesses) {
      const row = await prisma.inbound_receipt_excess.create({
        data: {
          inbound_receipt_line_id: line.inbound_receipt_line_id,
          excess_qty: excess.qty,
          purchase_order_line_id: excess.orderLine,
          linked_at: excess.orderLine === null ? null : RECEIVED_AT,
        },
      });
      created.push(row.inbound_receipt_excess_id);
    }
    const shares = [
      { orderLine, qty: qty - excesses.reduce((sum, excess) => sum + excess.qty, 0) },
      ...excesses.flatMap((excess) => (excess.orderLine === null ? [] : [{ orderLine: excess.orderLine, qty: excess.qty }])),
    ];
    for (const share of shares.filter((row) => row.qty > 0)) {
      const row = await prisma.inbound_receipt_po_allocation.create({
        data: { inbound_receipt_line_id: line.inbound_receipt_line_id, purchase_order_line_id: share.orderLine, allocated_qty: share.qty },
      });
      allocationIds.push(row.inbound_receipt_po_allocation_id);
    }
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-L${sequence}`,
        item_id: ids.item,
        lot_type_code: 'MATERIAL',
        plant_id: ids.plant,
        initial_qty: qty,
        uom_id: ids.uom,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: line.inbound_receipt_line_id,
        status_code: 'NORMAL',
      },
    });
    return { inboundLineId: line.inbound_receipt_line_id, lotId: lot.lot_id, excessIds: created };
  }

  async function receive(
    warehouse: 'warehouse' | 'defectWarehouse',
    lots: { inboundLineId: bigint; lotId: bigint; qty: number }[],
    receiptTypeCode = 'MATERIAL',
  ) {
    const detail = await receipts.create(
      {
        receiptTypeCode,
        plantId: Number(ids.plant),
        warehouseId: Number(ids[warehouse]),
        receiptDatetime: RECEIVED_AT.toISOString(),
        businessDate: '2026-10-22',
        lines: lots.map((lot) => ({
          inboundReceiptLineId: Number(lot.inboundLineId),
          itemId: Number(ids.item),
          lotId: Number(lot.lotId),
          receiptQty: lot.qty,
          uomId: Number(ids.uom),
          qualityStatusCode: 'NORMAL',
          inventoryStatusCode: 'AVAILABLE',
          destinationLocationId: Number(ids[`${warehouse}Location`]),
        })),
      },
      userId,
    );
    received.push(detail.goodsReceipt.goodsReceiptNo);
    return detail;
  }

  const messageOf = (goodsReceiptNo: string) =>
    prisma.integration_message.findUnique({ where: { message_key: `IF-GR-SEND:${goodsReceiptNo}` } });

  it('ERP 발주에 이어진 자재 입고는 같은 트랜잭션에서 구매입고를 적재하고 erpMessageQueued 가 참이다', async () => {
    const lot = await inboundLot(ids.erpOrderLine, 100);

    const detail = await receive('warehouse', [{ ...lot, qty: 100 }]);

    expect(detail.goodsReceipt.erpMessageQueued).toBe(true);
    expect(await messageOf(detail.goodsReceipt.goodsReceiptNo)).toMatchObject({
      interface_code: 'IF-GR-SEND',
      direction_code: 'OUTBOUND',
      target_type_code: 'GOODS_RECEIPT',
      target_id: BigInt(detail.goodsReceipt.goodsReceiptId),
      status_code: 'PENDING',
      payload: { goodsReceiptNo: detail.goodsReceipt.goodsReceiptNo },
    });
    const listed = await receipts.list({ q: detail.goodsReceipt.goodsReceiptNo });
    expect(listed.items.map((item) => item.erpMessageQueued)).toEqual([true]);
  });

  it('MES 발주에만 이어진 입고·불량창고 입고·특채 LOT 입고·자재 입고가 아닌 입고는 적재하지 않는다', async () => {
    const mes = await inboundLot(ids.mesOrderLine, 10);
    const rejected = await inboundLot(ids.erpOrderLine, 10);
    const conceded = await inboundLot(ids.erpOrderLine, 10);
    const product = await inboundLot(ids.erpOrderLine, 10);
    await concede(conceded.lotId);

    const details = [
      await receive('warehouse', [{ ...mes, qty: 10 }]),
      await receive('defectWarehouse', [{ ...rejected, qty: 10 }]),
      await receive('warehouse', [{ ...conceded, qty: 10 }]),
      await receive('warehouse', [{ ...product, qty: 10 }], 'PRODUCT'),
    ];

    expect(details.map((detail) => detail.goodsReceipt.erpMessageQueued)).toEqual([false, false, false, false]);
    for (const detail of details) expect(await messageOf(detail.goodsReceipt.goodsReceiptNo)).toBeNull();
  });

  /** 선별로 떼어 낸 자식 LOT — 입고 줄에 입하 연결이 없고 조상(부모)의 입하 줄을 따른다(P-56). */
  async function splitLot(parentLotId: bigint, qty: number): Promise<bigint> {
    sequence += 1;
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-S${sequence}`,
        item_id: ids.item,
        lot_type_code: 'MATERIAL',
        plant_id: ids.plant,
        initial_qty: qty,
        uom_id: ids.uom,
        source_type_code: 'LOT_SPLIT',
        source_id: parentLotId,
        parent_lot_id: parentLotId,
        status_code: 'NORMAL',
      },
    });
    return lot.lot_id;
  }

  const build = (goodsReceiptId: number): Promise<RowDraft[]> =>
    goodsReceiptBuilder(prisma).build({
      id: 1n,
      interfaceCode: 'IF-GR-SEND',
      targetTypeCode: 'GOODS_RECEIPT',
      targetId: BigInt(goodsReceiptId),
      payload: {},
    });
  const summary = (rows: RowDraft[]) =>
    rows.map((row) => [row.values.PO_NO, row.values.PO_SEQ_NO, row.values.SL_CD, row.values.GR_QTY]);

  it('구매입고 행 — 배정 몫마다 그 P/O 라인으로, 같은 라인은 합친다 · 미배정 몫과 특채 LOT 은 빠진다', async () => {
    const linked = await inboundLot(ids.erpOrderLine, 100, [{ qty: 20, orderLine: ids.erpOrderLine2 }]);
    const waiting = await inboundLot(ids.erpOrderLine, 50, [{ qty: 10, orderLine: null }]);
    const conceded = await inboundLot(ids.erpOrderLine, 10);
    await concede(conceded.lotId);

    const detail = await receive('warehouse', [
      { ...linked, qty: 100 },
      { ...waiting, qty: 50 },
      { ...conceded, qty: 10 },
    ]);
    const rows = await build(detail.goodsReceipt.goodsReceiptId);

    // P/O 라인 1 = 80 + 40(같은 라인은 합친다) · 입고 전에 다른 라인에 이은 20 은 라인 2 로 같이 간다.
    // 안 이은 10 은 미배정이라 없고, 특채 LOT 10 도 없다.
    expect(summary(rows)).toEqual([
      [`${PREFIX}-PO`, 1, 'S240', '120'],
      [`${PREFIX}-PO`, 2, 'S230', '20'],
    ]);
    expect(rows[0].values).toEqual({
      POP_INF_KEY: detail.goodsReceipt.goodsReceiptNo,
      PLANT_CD: 'PL11',
      ITEM_CD: `${PREFIX}-IT`,
      PO_NO: `${PREFIX}-PO`,
      PO_SEQ_NO: 1,
      GR_QTY: '120',
      GR_UNIT: 'EA',
      SL_CD: 'S240',
      TRACKING_NO: '',
      LOT_NO: '',
      LOT_SUB_NO: 0,
      MAKER_LOT_NO: null,
      MAKER_LOT_SUB_NO: 0,
      // 하노이 2026-10-22 01:30 — UTC 로는 아직 21일이다.
      RCPT_DT: '2026-10-22 01:30:00',
      BP_CD: 'S0001',
      PUR_GRP_CD: 'P01',
      IO_TYPE_CD: 'DGR',
      INSPECT_FLAG: 'N',
      INSPECT_METHOD_CD: null,
      CC_NO: '',
      CC_SEQ_NO: 0,
      LLC_SEQ_NO: 0,
      IV_SEQ_NO: 0,
      GM_SUB_SEQ_NO: 0,
    });
  });

  it('선별로 떼어 낸 LOT 은 조상의 입하 줄을 따르고, 입고가 적으면 먼저 만든 배정 몫부터 채운다', async () => {
    const parent = await inboundLot(ids.erpOrderLine, 100, [{ qty: 20, orderLine: ids.erpOrderLine2 }]);
    const child = await splitLot(parent.lotId, 90);

    const detail = await receipts.create(
      {
        receiptTypeCode: 'MATERIAL',
        plantId: Number(ids.plant),
        warehouseId: Number(ids.warehouse),
        receiptDatetime: RECEIVED_AT.toISOString(),
        businessDate: '2026-10-22',
        lines: [
          {
            itemId: Number(ids.item),
            lotId: Number(child),
            receiptQty: 90,
            uomId: Number(ids.uom),
            qualityStatusCode: 'NORMAL',
            inventoryStatusCode: 'AVAILABLE',
            destinationLocationId: Number(ids.warehouseLocation),
          },
        ],
      },
      userId,
    );
    received.push(detail.goodsReceipt.goodsReceiptNo);

    expect(detail.goodsReceipt.erpMessageQueued).toBe(true);
    // 라인 2 몫 20 중 받은 것은 90 − 80 = 10 이다.
    expect(summary(await build(detail.goodsReceipt.goodsReceiptId))).toEqual([
      [`${PREFIX}-PO`, 1, 'S240', '80'],
      [`${PREFIX}-PO`, 2, 'S230', '10'],
    ]);
  });

  it('입하 줄 하나가 ERP 로 가는 입고 여럿에 나뉘면 실패한다 — 부분 입고는 생기지 않는다', async () => {
    const parent = await inboundLot(ids.erpOrderLine, 100);
    const [first, second] = [await splitLot(parent.lotId, 50), await splitLot(parent.lotId, 50)];
    const receiveChild = async (lotId: bigint) => {
      const detail = await receipts.create(
        {
          receiptTypeCode: 'MATERIAL',
          plantId: Number(ids.plant),
          warehouseId: Number(ids.warehouse),
          receiptDatetime: RECEIVED_AT.toISOString(),
          businessDate: '2026-10-22',
          lines: [
            {
              itemId: Number(ids.item),
              lotId: Number(lotId),
              receiptQty: 50,
              uomId: Number(ids.uom),
              qualityStatusCode: 'NORMAL',
              inventoryStatusCode: 'AVAILABLE',
              destinationLocationId: Number(ids.warehouseLocation),
            },
          ],
        },
        userId,
      );
      received.push(detail.goodsReceipt.goodsReceiptNo);
      return detail.goodsReceipt;
    };
    const [a, b] = [await receiveChild(first), await receiveChild(second)];

    await expect(build(b.goodsReceiptId)).rejects.toThrow(
      `입고 ${b.goodsReceiptNo} 입하 줄 ${parent.inboundLineId} — 다른 입고(${a.goodsReceiptNo})에도 들어가 P/O 몫을 나눌 수 없다`,
    );
  });

  it('발주에 구매그룹이 없으면 실패한다 — 입고 쪽 칸은 NOT NULL 이다', async () => {
    const lot = await inboundLot(ids.erpOrderLine, 5);
    const detail = await receive('warehouse', [{ ...lot, qty: 5 }]);
    await prisma.purchase_order.update({ where: { purchase_order_id: ids.erpOrder }, data: { erp_purchase_group_code: null } });

    try {
      await expect(build(detail.goodsReceipt.goodsReceiptId)).rejects.toThrow(
        `입고 ${detail.goodsReceipt.goodsReceiptNo} — ERP 발주 ${PREFIX}-PO 라인 1 — 발주에 구매그룹(PUR_GRP_CD)이 없다`,
      );
    } finally {
      await prisma.purchase_order.update({ where: { purchase_order_id: ids.erpOrder }, data: { erp_purchase_group_code: 'P01' } });
    }
  });

  it('보내기 전에 취소된 입고는 보낼 것이 없다', async () => {
    const lot = await inboundLot(ids.erpOrderLine, 5);
    const detail = await receive('warehouse', [{ ...lot, qty: 5 }]);
    await prisma.goods_receipt.update({
      where: { goods_receipt_id: BigInt(detail.goodsReceipt.goodsReceiptId) },
      data: { status_code: 'CANCELLED' },
    });

    expect(await build(detail.goodsReceipt.goodsReceiptId)).toEqual([]);
  });

  function buildAllocation(allocationId: bigint): Promise<RowDraft[]> {
    return goodsReceiptBuilder(prisma).build({
      id: 1n,
      interfaceCode: 'IF-GR-SEND',
      targetTypeCode: 'INBOUND_RECEIPT_PO_ALLOCATION',
      targetId: allocationId,
      payload: {},
    });
  }
  /** 그 줄의 그 P/O 라인 배정 — 가장 최근 것. */
  async function allocationOf(inboundLineId: bigint, orderLine: bigint): Promise<bigint> {
    const row = await prisma.inbound_receipt_po_allocation.findFirstOrThrow({
      where: { inbound_receipt_line_id: inboundLineId, purchase_order_line_id: orderLine },
      orderBy: { inbound_receipt_po_allocation_id: 'desc' },
    });
    allocationIds.push(row.inbound_receipt_po_allocation_id);
    return row.inbound_receipt_po_allocation_id;
  }
  const buildCancel = (goodsReceiptId: number): Promise<RowDraft[]> =>
    goodsReceiptBuilder(prisma).build({
      id: 1n,
      interfaceCode: 'IF-GR-SEND',
      targetTypeCode: 'GOODS_RECEIPT_CANCEL',
      targetId: BigInt(goodsReceiptId),
      payload: {},
    });
  const allocationMessage = (allocationId: bigint) =>
    prisma.integration_message.findUnique({ where: { message_key: `IF-GR-SEND:ALLOC:${allocationId}` } });

  it('입고 전에 더한 몫은 입고 묶음에 함께 실린다 — 자기 묶음(ALLOC)을 세우지 않는다', async () => {
    const lot = await inboundLot(ids.erpOrderLine, 100, [{ qty: 20, orderLine: ids.erpOrderLine2 }]);

    const detail = await receive('warehouse', [{ ...lot, qty: 100 }]);

    expect(await allocationMessage(await allocationOf(lot.inboundLineId, ids.erpOrderLine2))).toBeNull();
    const rows = await build(detail.goodsReceipt.goodsReceiptId);
    expect(summary(rows)).toEqual([
      [`${PREFIX}-PO`, 1, 'S240', '80'],
      [`${PREFIX}-PO`, 2, 'S230', '20'],
    ]);
    expect(rows[1].values).toMatchObject({ POP_INF_KEY: detail.goodsReceipt.goodsReceiptNo, RCPT_DT: '2026-10-22 01:30:00' });
  });

  it('입고 뒤에 이은 몫은 이을 때 자기 묶음을 적재하고 입고 묶음에서는 빠진다 · 그 뒤에는 풀지 못한다', async () => {
    const lot = await inboundLot(ids.erpOrderLine, 50, [{ qty: 10, orderLine: null }]);
    const [excessId] = lot.excessIds;
    const detail = await receive('warehouse', [{ ...lot, qty: 50 }]);

    await excesses.link(excessId, ids.erpOrderLine2, userId);

    const allocationId = await allocationOf(lot.inboundLineId, ids.erpOrderLine2);
    expect(await allocationMessage(allocationId)).toMatchObject({
      interface_code: 'IF-GR-SEND',
      target_type_code: 'INBOUND_RECEIPT_PO_ALLOCATION',
      target_id: allocationId,
      status_code: 'PENDING',
    });
    const rows = await buildAllocation(allocationId);
    expect(summary(rows)).toEqual([[`${PREFIX}-PO`, 2, 'S230', '10']]);
    expect(rows[0].values).toMatchObject({ POP_INF_KEY: detail.goodsReceipt.goodsReceiptNo });
    // 입고 묶음이 늦게 바뀌어도 같은 몫을 두 번 싣지 않는다.
    expect(summary(await build(detail.goodsReceipt.goodsReceiptId))).toEqual([[`${PREFIX}-PO`, 1, 'S240', '40']]);
    await expect(excesses.unlink(excessId, userId)).rejects.toMatchObject({
      response: { errors: [expect.objectContaining({ code: 'STATE_LOCKED', message: 'ERP 구매입고로 보낸 배정입니다.' })] },
    });
  });

  it('입고 전에는 이어도 적재하지 않고 풀 수 있다 — 입고할 때 함께 간다', async () => {
    const lot = await inboundLot(ids.erpOrderLine, 30, [{ qty: 5, orderLine: null }]);
    const [excessId] = lot.excessIds;

    await excesses.link(excessId, ids.erpOrderLine2, userId);
    expect(await allocationMessage(await allocationOf(lot.inboundLineId, ids.erpOrderLine2))).toBeNull();

    await excesses.unlink(excessId, userId);
    expect((await prisma.inbound_receipt_excess.findUniqueOrThrow({ where: { inbound_receipt_excess_id: excessId } })).purchase_order_line_id).toBeNull();
    expect(await prisma.inbound_receipt_po_allocation.count({ where: { inbound_receipt_line_id: lot.inboundLineId, purchase_order_line_id: ids.erpOrderLine2 } })).toBe(0);
  });

  it('전부 미배정으로 입고한 줄 — 입고 묶음은 서되 행이 없고, 새 ERP 발주에 배정하면 그 몫이 자기 묶음으로 간다', async () => {
    const lot = await inboundLot(ids.erpOrderLine, 15, [{ qty: 15, orderLine: null }]);
    const detail = await receive('warehouse', [{ ...lot, qty: 15 }]);
    expect(detail.goodsReceipt.erpMessageQueued).toBe(true);
    expect(await build(detail.goodsReceipt.goodsReceiptId)).toEqual([]);

    await excesses.link(lot.excessIds[0], ids.erpOrderLine2, userId);

    expect(summary(await buildAllocation(await allocationOf(lot.inboundLineId, ids.erpOrderLine2)))).toEqual([[`${PREFIX}-PO`, 2, 'S230', '15']]);
  });

  /** 그 메시지를 바꾸고 키를 적고(넣었다면) 넣었다고 표시한다 — 실행기가 하는 일을 손으로. */
  async function send(messageKey: string, drafts: RowDraft[], inserted = true) {
    const message = await prisma.integration_message.findUniqueOrThrow({ where: { message_key: messageKey } });
    const rows = new OutboundRows(prisma);
    const reserved = await rows.reserve(message.integration_message_id, drafts, () => 0);
    if (inserted) await rows.markInserted(reserved.map((row, index) => ({ id: row.id, relayInfId: BigInt(index + 1) })), new Date());
    return { message, reserved };
  }

  async function cancelReceipt(goodsReceiptId: number): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.goods_receipt.update({ where: { goods_receipt_id: BigInt(goodsReceiptId) }, data: { status_code: 'CANCELLED' } });
      await enqueueReceiptCancel(tx, app.get(OutboxService), BigInt(goodsReceiptId));
    });
  }

  it('보낸 입고를 취소하면 그 입고번호로 넣은 행마다 취소 행(C)을 보낸다 — IF_SEQ 는 처음 그대로', async () => {
    const lot = await inboundLot(ids.erpOrderLine, 100, [{ qty: 20, orderLine: ids.erpOrderLine2 }]);
    const detail = await receive('warehouse', [{ ...lot, qty: 100 }]);
    const { goodsReceiptId, goodsReceiptNo } = detail.goodsReceipt;
    await send(`IF-GR-SEND:${goodsReceiptNo}`, await build(goodsReceiptId));

    await cancelReceipt(goodsReceiptId);

    const cancelKey = `IF-GR-SEND:CANCEL:${goodsReceiptNo}`;
    expect(await prisma.integration_message.findUnique({ where: { message_key: cancelKey } })).toMatchObject({
      target_type_code: 'GOODS_RECEIPT_CANCEL',
      target_id: BigInt(goodsReceiptId),
    });
    const drafts = await buildCancel(goodsReceiptId);
    const { reserved } = await send(cancelKey, drafts);
    expect(reserved.map((row) => row.relayKey)).toEqual([
      `${goodsReceiptNo}|PL11|${PREFIX}-IT|${PREFIX}-PO|1|1|C`,
      // 두 몫이 한 묶음에 실려 라인마다 처음 순번(1)을 받았다 — 취소 행은 그 순번을 그대로 쓴다.
      `${goodsReceiptNo}|PL11|${PREFIX}-IT|${PREFIX}-PO|2|1|C`,
    ]);
    expect(reserved[0].values).toMatchObject({ GR_QTY: '80', CREATE_TYPE: 'C', ERP_APPLY_FLAG: 'N' });
    // 다 취소했으니 다시 바꿔도 보낼 것이 없다.
    expect(await buildCancel(goodsReceiptId)).toEqual([]);
  });

  it('넣는 중(키만 적은) 행이 있으면 취소는 다음에 다시 한다 — 그 행이 C 보다 늦게 들어갈 수 있다', async () => {
    const lot = await inboundLot(ids.erpOrderLine, 10);
    const detail = await receive('warehouse', [{ ...lot, qty: 10 }]);
    await send(`IF-GR-SEND:${detail.goodsReceipt.goodsReceiptNo}`, await build(detail.goodsReceipt.goodsReceiptId), false);
    await cancelReceipt(detail.goodsReceipt.goodsReceiptId);

    await expect(buildCancel(detail.goodsReceipt.goodsReceiptId)).rejects.toThrow(
      `입고 ${detail.goodsReceipt.goodsReceiptNo} 의 구매입고를 넣는 중이다 — 넣은 뒤 취소를 다시 한다`,
    );
  });

  it('취소 요청 중인 입고는 그대로 보낸다 — 결재가 반려되면 입고가 남는다', async () => {
    const lot = await inboundLot(ids.erpOrderLine, 12, [{ qty: 2, orderLine: ids.erpOrderLine2 }]);
    const detail = await receive('warehouse', [{ ...lot, qty: 12 }]);
    await prisma.goods_receipt.update({
      where: { goods_receipt_id: BigInt(detail.goodsReceipt.goodsReceiptId) },
      data: { status_code: 'CANCEL_REQUESTED' },
    });

    expect(summary(await build(detail.goodsReceipt.goodsReceiptId))).toEqual([
      [`${PREFIX}-PO`, 1, 'S240', '10'],
      [`${PREFIX}-PO`, 2, 'S230', '2'],
    ]);
  });

  describeRelay('중계 DB', () => {
    const COPY = { ...GR_INFOR, name: 'E2E_IF_RCV_GR_INFOR_SEND' };
    let sa: mssql.ConnectionPool;
    let relay: RelayClient;

    beforeAll(async () => {
      sa = await connectSa();
      await createCopy(sa, COPY.name, GR_INFOR.name);
      relay = new RelayClient(RELAY);
    });

    afterAll(async () => {
      await relay?.close();
      await dropCopy(sa, COPY.name);
      await sa?.close();
    });

    it('만든 행이 중계 표에 그대로 들어간다 — 비어서는 안 되는 칸이 다 찼다', async () => {
      const lot = await inboundLot(ids.erpOrderLine, 30);
      const detail = await receive('warehouse', [{ ...lot, qty: 30 }]);
      const rows = await build(detail.goodsReceipt.goodsReceiptId);

      await relay.insertRows(
        rows.map((row) => ({ table: COPY, values: { ...row.values, IF_SEQ: 1, CREATE_TYPE: 'A', ...GR_INFOR.initialFlags } })),
      );

      const stored = await sa.request().query(`SELECT PO_SEQ_NO, GR_QTY, RCPT_DT, ERP_APPLY_FLAG FROM dbo.${COPY.name}`);
      expect(stored.recordset).toEqual([
        { PO_SEQ_NO: 1, GR_QTY: 30, RCPT_DT: new Date('2026-10-22T01:30:00.000Z'), ERP_APPLY_FLAG: 'N' },
      ]);
    });
  });

  /** 특채가 적용된 LOT — 부적합·결재 요청·특채(APPROVED)를 그대로 세운다(P-79). */
  async function concede(lotId: bigint): Promise<void> {
    const nonconformance = await prisma.nonconformance.create({
      data: {
        nonconformance_no: `${PREFIX}-NC${sequence}`,
        item_id: ids.item,
        severity_code: 'MAJOR',
        description: 'IQC 불합격',
        status_code: 'CLOSED',
        opened_at: RECEIVED_AT,
      },
    });
    const approval = await prisma.approval_request.create({
      data: {
        approval_request_no: `${PREFIX}-AR${sequence}`,
        approval_type_code: 'CONCESSION',
        target_type_code: 'NONCONFORMANCE',
        target_id: nonconformance.nonconformance_id,
        requested_by: BigInt(userId),
        requested_at: RECEIVED_AT,
        status_code: 'APPROVED',
        reason: '특채',
      },
    });
    await prisma.concession.create({
      data: {
        concession_no: `${PREFIX}-CN${sequence}`,
        nonconformance_id: nonconformance.nonconformance_id,
        lot_id: lotId,
        approved_qty: 10,
        uom_id: ids.uom,
        valid_from: new Date('2026-10-01T00:00:00.000Z'),
        approval_request_id: approval.approval_request_id,
        status_code: 'APPROVED',
      },
    });
  }
});

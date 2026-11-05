import { Prisma } from '@prisma/client';

import { IF_GOODS_RECEIPT } from '../../../core/outbox/outbox.service';
import {
  ALLOCATION_TARGET,
  RECEIPT_CANCEL_TARGET,
  allocationMessageKey,
  erpInboundLines,
  erpReceiptLinesOf,
  receiptShares,
} from '../../../logistics/goods-receipt/erp-receipt';
import { PrismaService } from '../../../prisma/prisma.service';
import { CustomsClearance, CustomsClearances } from '../customs-clearance';
import { OutboundBuilder, OutboundMessage } from '../outbound-builder';
import { OUTBOUND_ROW_STATUS, OutboundRows, RowDraft } from '../outbound-rows';
import { GR_INFOR } from '../rcv-tables';
import { relayDateTime } from './relay-time';

/** 인터페이스 키(POP_INF_KEY) 칸 길이. MES 입고번호를 그대로 쓴다. */
const POP_INF_KEY_LENGTH = 25;
const CANCELLED = 'CANCELLED';

const ORDER_LINE = {
  purchase_order_line_id: true,
  line_no: true,
  uom_id: true,
  erp_storage_location_code: true,
  erp_customs_clearance_no: true,
  erp_customs_clearance_seq: true,
  purchase_order: {
    select: {
      erp_purchase_order_no: true,
      erp_order_type_code: true,
      erp_purchase_group_code: true,
      erp_io_type_code: true,
      partner: { select: { erp_partner_code: true } },
    },
  },
} satisfies Prisma.purchase_order_lineSelect;
type OrderLine = Prisma.purchase_order_lineGetPayload<{ select: typeof ORDER_LINE }>;

const ALLOCATION = {
  inbound_receipt_po_allocation_id: true,
  allocated_qty: true,
  purchase_order_line: { select: ORDER_LINE },
} satisfies Prisma.inbound_receipt_po_allocationSelect;

interface Receipt {
  goods_receipt_no: string;
  receipt_datetime: Date;
  plant: { plant_code: string; timezone_code: string };
}

interface Share {
  orderLine: OrderLine;
  itemCode: string;
  uomCode: string;
  qty: Prisma.Decimal;
  inspected: boolean;
}

/**
 * 구매입고(`T_IF_RCV_GR_INFOR_KO324`) — 입고 하나(`IF-GR-SEND`)를 ERP 발주 라인마다 한 행으로 바꾼다(장부 P-104).
 * - 보낼 줄은 `erpInboundLines` 가 고른다 — 입하를 거쳐 ERP 발주 라인에 이어진 줄, 특채 LOT 은 빠진다.
 * - 입하 줄의 몫: 입고 수량을 배정 순서대로 채운다(`receiptShares`) — 배정 몫 하나가 ERP 발주 라인 한 행이고, 같은
 *   P/O 라인의 몫은 합친다(키가 P/O 라인이다). 미배정 몫·MES 발주 몫은 가지 않는다.
 * - 입고 뒤에 더한 몫은 자기 묶음(`INBOUND_RECEIPT_PO_ALLOCATION` · `ALLOC:{id}`)으로 간다 — 입고 묶음은 그 키가 없는
 *   몫만 싣는다. 시각 비교 없이 갈린다.
 * - 수불유형·창고·공급처·구매그룹은 발주에서 이어받는다(컬럼 정의서). 입고 일시는 공장 현지 시각이다.
 * - 통관번호는 외자 발주만 싣는다(`CustomsClearances`) — 그 밖은 빈 값, 순번 칸은 0 이다(NOT NULL).
 * 입고 취소 묶음(`GOODS_RECEIPT_CANCEL`)은 그 입고번호로 넣은 행(입고 행·배정 몫 행)마다 취소 행(C)이다.
 */
export function goodsReceiptBuilder(
  prisma: PrismaService,
  customs: CustomsClearances = new CustomsClearances(prisma, null),
): OutboundBuilder {
  return { interfaceCode: IF_GOODS_RECEIPT, build: (message) => build(prisma, customs, message) };
}

async function build(prisma: PrismaService, customs: CustomsClearances, message: OutboundMessage): Promise<RowDraft[]> {
  if (message.targetTypeCode === ALLOCATION_TARGET) return allocationRows(prisma, customs, message.targetId);
  if (message.targetTypeCode === RECEIPT_CANCEL_TARGET) return cancelRows(prisma, message.targetId);
  const receipt = await prisma.goods_receipt.findUniqueOrThrow({
    where: { goods_receipt_id: message.targetId },
    select: {
      goods_receipt_no: true,
      receipt_datetime: true,
      status_code: true,
      plant: { select: { plant_code: true, timezone_code: true } },
      warehouse: { select: { is_defect: true } },
      goods_receipt_line: {
        orderBy: { line_no: 'asc' },
        select: {
          line_no: true,
          lot_id: true,
          inbound_receipt_line_id: true,
          receipt_qty: true,
          uom_id: true,
          item: { select: { item_code: true, base_uom_id: true } },
          uom: { select: { uom_code: true } },
        },
      },
    },
  });
  // 보내기 전에 취소된 입고는 보낼 것이 없다. 취소 요청 중이면 그대로 보낸다 — 반려되면 입고가 남는다.
  if (receipt.status_code === CANCELLED || receipt.warehouse.is_defect) return [];
  if (receipt.goods_receipt_no.length > POP_INF_KEY_LENGTH) {
    throw new Error(`입고번호 ${receipt.goods_receipt_no} 가 인터페이스 키 칸(${POP_INF_KEY_LENGTH}자)보다 길다`);
  }

  const lines = receipt.goods_receipt_line;
  const inboundLineIds = await erpInboundLines(
    prisma,
    lines.map((line) => ({ lotId: line.lot_id, inboundReceiptLineId: line.inbound_receipt_line_id })),
  );
  // 입하 줄마다 이 입고가 받은 수량 — 같은 입하 줄의 LOT(선별 자식)이 여럿일 수 있다.
  const byInboundLine = new Map<bigint, { qty: Prisma.Decimal; itemCode: string; uomId: bigint; uomCode: string }>();
  for (const [index, line] of lines.entries()) {
    const inboundLineId = inboundLineIds[index];
    if (inboundLineId === null) continue;
    // 수불은 품목 기본단위로 한다(9/3 고객 답). 받은 환산표는 아직 쓰지 않는다.
    if (line.uom_id !== line.item.base_uom_id) {
      throw new Error(`입고 ${receipt.goods_receipt_no} 라인 ${line.line_no} — 단위가 품목 기본단위와 달라 환산이 필요하다`);
    }
    const sum = byInboundLine.get(inboundLineId);
    byInboundLine.set(inboundLineId, {
      qty: (sum?.qty ?? new Prisma.Decimal(0)).plus(line.receipt_qty),
      itemCode: line.item.item_code,
      uomId: line.uom_id,
      uomCode: line.uom.uom_code,
    });
  }

  const shares = new Map<bigint, Share>();
  for (const [inboundLineId, received] of byInboundLine) {
    const at = `입고 ${receipt.goods_receipt_no} 입하 줄 ${inboundLineId}`;
    // 부분 입고는 생기지 않는다(사용자 2026-10-22) — 입하 줄 하나가 ERP 로 가는 입고 여럿에 나뉘면 몫을 나눌 수 없다.
    const others = new Set(
      (await erpReceiptLinesOf(prisma, inboundLineId))
        .map((line) => line.goodsReceiptNo)
        .filter((no) => no !== receipt.goods_receipt_no),
    );
    if (others.size > 0) throw new Error(`${at} — 다른 입고(${[...others].join(', ')})에도 들어가 P/O 몫을 나눌 수 없다`);
    const inbound = await prisma.inbound_receipt_line.findUniqueOrThrow({
      where: { inbound_receipt_line_id: inboundLineId },
      select: { inspection_required: true, inbound_receipt_po_allocation: { select: ALLOCATION } },
    });
    // 입고 뒤에 더한 몫은 자기 묶음(`ALLOC`)으로 간다 — 그 키가 있는 몫은 여기서 싣지 않는다(두 번 가지 않게).
    const own = await ownBundles(prisma, inbound.inbound_receipt_po_allocation);
    const filled = receiptShares(received.qty, inbound.inbound_receipt_po_allocation);
    for (const allocation of inbound.inbound_receipt_po_allocation) {
      const orderLine = allocation.purchase_order_line;
      const qty = filled.get(allocation.inbound_receipt_po_allocation_id) ?? new Prisma.Decimal(0);
      if (own.has(allocation.inbound_receipt_po_allocation_id) || orderLine.purchase_order.erp_purchase_order_no === null) continue;
      if (qty.lessThanOrEqualTo(0)) continue;
      if (orderLine.uom_id !== received.uomId) throw new Error(`${at} — 단위가 발주 라인과 달라 환산이 필요하다`);
      // 같은 P/O 라인의 몫은 합친다 — 행의 키가 P/O 라인이다.
      const share = shares.get(orderLine.purchase_order_line_id);
      shares.set(orderLine.purchase_order_line_id, {
        orderLine,
        itemCode: received.itemCode,
        uomCode: received.uomCode,
        qty: (share?.qty ?? new Prisma.Decimal(0)).plus(qty),
        inspected: (share?.inspected ?? false) || inbound.inspection_required,
      });
    }
  }

  const rows: RowDraft[] = [];
  for (const share of shares.values()) rows.push(rowOf(receipt, share, await customs.forReceipt(share.orderLine)));
  return rows;
}

/** 배정 몫 하나 — 입고 뒤에 더한 몫이다. 그 입하 줄이 들어간 입고의 번호·일시로, 입고 수량을 배정 순서로 나눈 이 몫. */
async function allocationRows(prisma: PrismaService, customs: CustomsClearances, allocationId: bigint): Promise<RowDraft[]> {
  const allocation = await prisma.inbound_receipt_po_allocation.findUniqueOrThrow({
    where: { inbound_receipt_po_allocation_id: allocationId },
    select: {
      inbound_receipt_line_id: true,
      purchase_order_line: { select: ORDER_LINE },
      inbound_receipt_line: {
        select: {
          inspection_required: true,
          uom_id: true,
          item: { select: { item_code: true, base_uom_id: true } },
          uom: { select: { uom_code: true } },
          inbound_receipt_po_allocation: { select: { inbound_receipt_po_allocation_id: true, allocated_qty: true } },
        },
      },
    },
  });
  const orderLine = allocation.purchase_order_line;
  if (orderLine.purchase_order.erp_purchase_order_no === null) return [];
  const inbound = allocation.inbound_receipt_line;
  const at = `배정 ${allocationId}`;
  if (inbound.uom_id !== inbound.item.base_uom_id || orderLine.uom_id !== inbound.uom_id) {
    throw new Error(`${at} — 단위가 품목 기본단위·발주 라인과 달라 환산이 필요하다`);
  }
  const taken = await erpReceiptLinesOf(prisma, allocation.inbound_receipt_line_id);
  const receiptNos = [...new Set(taken.map((line) => line.goodsReceiptNo))];
  if (receiptNos.length === 0) return [];
  if (receiptNos.length > 1) throw new Error(`${at} — 입하 줄이 ERP 로 가는 입고 여럿(${receiptNos.join(', ')})에 나뉘어 몫을 나눌 수 없다`);
  const received = taken.reduce((sum, line) => sum.plus(line.receiptQty), new Prisma.Decimal(0));
  const mine = receiptShares(received, inbound.inbound_receipt_po_allocation).get(allocationId) ?? new Prisma.Decimal(0);
  if (mine.lessThanOrEqualTo(0)) return [];
  const receipt = await prisma.goods_receipt.findUniqueOrThrow({
    where: { goods_receipt_id: taken[0].goodsReceiptId },
    select: { goods_receipt_no: true, receipt_datetime: true, plant: { select: { plant_code: true, timezone_code: true } } },
  });
  const share: Share = {
    orderLine,
    itemCode: inbound.item.item_code,
    uomCode: inbound.uom.uom_code,
    qty: mine,
    inspected: inbound.inspection_required,
  };
  return [rowOf(receipt, share, await customs.forReceipt(orderLine))];
}

/** 자기 묶음(`ALLOC`)이 적재된 배정 — 입고 뒤에 더한 몫이다. */
async function ownBundles(
  prisma: PrismaService,
  allocations: readonly { inbound_receipt_po_allocation_id: bigint }[],
): Promise<Set<bigint>> {
  if (allocations.length === 0) return new Set();
  const keys = new Map(allocations.map((row) => [allocationMessageKey(row.inbound_receipt_po_allocation_id), row.inbound_receipt_po_allocation_id]));
  const queued = await prisma.integration_message.findMany({
    where: { message_key: { in: [...keys.keys()] } },
    select: { message_key: true },
  });
  return new Set(queued.map((row) => keys.get(row.message_key) as bigint));
}

/**
 * 입고 취소 — 그 입고번호로 넣은 생성 행마다 취소 행. 넣는 중인 행(키만 적었다)이 있으면 다음에 다시 한다 —
 * 지금 C 를 보내면 그 행이 C 보다 늦게 들어갈 수 있다.
 */
async function cancelRows(prisma: PrismaService, goodsReceiptId: bigint): Promise<RowDraft[]> {
  const { goods_receipt_no: receiptNo } = await prisma.goods_receipt.findUniqueOrThrow({
    where: { goods_receipt_id: goodsReceiptId },
    select: { goods_receipt_no: true },
  });
  const sent = await new OutboundRows(prisma).uncancelled(GR_INFOR.name, receiptNo);
  if (sent.some((row) => row.statusCode === OUTBOUND_ROW_STATUS.RESERVED)) {
    throw new Error(`입고 ${receiptNo} 의 구매입고를 넣는 중이다 — 넣은 뒤 취소를 다시 한다`);
  }
  return sent.map((row) => ({ table: GR_INFOR, values: row.values, cancels: row }));
}

function rowOf(receipt: Receipt, share: Share, customs: CustomsClearance): RowDraft {
  const { orderLine } = share;
  const order = orderLine.purchase_order;
  const at = `입고 ${receipt.goods_receipt_no} — ERP 발주 ${order.erp_purchase_order_no} 라인 ${orderLine.line_no}`;
  if (orderLine.erp_storage_location_code === null) throw new Error(`${at} 에 창고(SL_CD)가 없다`);
  if (order.erp_purchase_group_code === null) throw new Error(`${at} — 발주에 구매그룹(PUR_GRP_CD)이 없다`);
  if (order.partner.erp_partner_code === null) throw new Error(`${at} — 공급사에 ERP 거래처 코드가 없다`);
  return {
    table: GR_INFOR,
    values: {
      POP_INF_KEY: receipt.goods_receipt_no,
      PLANT_CD: receipt.plant.plant_code,
      ITEM_CD: share.itemCode,
      PO_NO: order.erp_purchase_order_no,
      PO_SEQ_NO: orderLine.line_no,
      GR_QTY: share.qty.toFixed(),
      GR_UNIT: share.uomCode,
      SL_CD: orderLine.erp_storage_location_code,
      TRACKING_NO: '',
      LOT_NO: '',
      LOT_SUB_NO: 0,
      MAKER_LOT_NO: null,
      MAKER_LOT_SUB_NO: 0,
      RCPT_DT: relayDateTime(receipt.receipt_datetime, receipt.plant.timezone_code),
      BP_CD: order.partner.erp_partner_code,
      PUR_GRP_CD: order.erp_purchase_group_code,
      IO_TYPE_CD: order.erp_io_type_code,
      INSPECT_FLAG: share.inspected ? 'Y' : 'N',
      INSPECT_METHOD_CD: null,
      CC_NO: customs.no,
      CC_SEQ_NO: customs.seq,
      LLC_SEQ_NO: 0,
      IV_SEQ_NO: 0,
      GM_SUB_SEQ_NO: 0,
    },
  };
}

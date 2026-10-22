import { Prisma } from '@prisma/client';

import { IF_GOODS_RECEIPT } from '../../../core/outbox/outbox.service';
import { erpInboundLines, erpReceiptLinesOf } from '../../../logistics/goods-receipt/erp-receipt';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboundBuilder, OutboundMessage } from '../outbound-builder';
import { RowDraft } from '../outbound-rows';
import { GR_INFOR } from '../rcv-tables';
import { relayDateTime } from './relay-time';

/** 인터페이스 키(POP_INF_KEY) 칸 길이. MES 입고번호를 그대로 쓴다. */
const POP_INF_KEY_LENGTH = 25;
const POSTED = 'POSTED';

const ORDER_LINE = {
  purchase_order_line_id: true,
  line_no: true,
  uom_id: true,
  erp_storage_location_code: true,
  purchase_order: {
    select: {
      erp_purchase_order_no: true,
      erp_purchase_group_code: true,
      erp_io_type_code: true,
      partner: { select: { erp_partner_code: true } },
    },
  },
} satisfies Prisma.purchase_order_lineSelect;
type OrderLine = Prisma.purchase_order_lineGetPayload<{ select: typeof ORDER_LINE }>;

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
 * - 입하 줄의 몫(P-100): 입고 수량으로 P/O 라인 몫부터 채우고 나머지가 초과분이다. 초과분은 이어진 P/O 라인으로
 *   따로 보낸다(초과분마다 한 묶음). 같은 P/O 라인의 몫은 합친다(키가 P/O 라인이다).
 * - 수불유형·창고·공급처·구매그룹은 발주에서 이어받는다(컬럼 정의서). 입고 일시는 공장 현지 시각이다.
 * - 통관번호는 고객 답(질문 5) 전까지 빈 값, 순번 칸은 0 이다(NOT NULL).
 */
export function goodsReceiptBuilder(prisma: PrismaService): OutboundBuilder {
  return { interfaceCode: IF_GOODS_RECEIPT, build: (message) => build(prisma, message) };
}

async function build(prisma: PrismaService, message: OutboundMessage): Promise<RowDraft[]> {
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
  // 보내기 전에 취소된 입고는 보낼 것이 없다.
  if (receipt.status_code !== POSTED || receipt.warehouse.is_defect) return [];
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
      select: {
        received_qty: true,
        inspection_required: true,
        purchase_order_line: { select: ORDER_LINE },
        inbound_receipt_excess: { select: { excess_qty: true } },
      },
    });
    const orderLine = inbound.purchase_order_line;
    if (orderLine === null || orderLine.purchase_order.erp_purchase_order_no === null) continue;
    if (orderLine.uom_id !== received.uomId) throw new Error(`${at} — 단위가 발주 라인과 달라 환산이 필요하다`);
    // 입고 수량으로 P/O 라인 몫부터 채운다 — 나머지는 초과분이고, 초과분은 따로 보낸다(P-100).
    const excessTotal = inbound.inbound_receipt_excess.reduce(
      (sum, excess) => sum.plus(excess.excess_qty),
      new Prisma.Decimal(0),
    );
    const qty = Prisma.Decimal.min(received.qty, inbound.received_qty.minus(excessTotal));
    if (qty.lessThanOrEqualTo(0)) continue;
    const share = shares.get(orderLine.purchase_order_line_id);
    shares.set(orderLine.purchase_order_line_id, {
      orderLine,
      itemCode: received.itemCode,
      uomCode: received.uomCode,
      qty: (share?.qty ?? new Prisma.Decimal(0)).plus(qty),
      inspected: (share?.inspected ?? false) || inbound.inspection_required,
    });
  }

  return [...shares.values()].map((share) => {
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
        CC_NO: '',
        CC_SEQ_NO: 0,
        LLC_SEQ_NO: 0,
        IV_SEQ_NO: 0,
        GM_SUB_SEQ_NO: 0,
      },
    };
  });
}

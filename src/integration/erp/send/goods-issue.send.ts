import { IF_SHIPMENT_PGI } from '../../../core/outbox/outbox.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboundBuilder, OutboundMessage } from '../outbound-builder';
import { RowDraft } from '../outbound-rows';
import { GOODS_ISSUE } from '../rcv-tables';
import { relayDateTime } from './relay-time';

/** 출하요청번호(DN_REQ_NO) 칸 길이. MES 출하번호를 그대로 쓴다. */
const DN_REQ_NO_LENGTH = 18;

/**
 * 제품출하(`T_IF_RCV_GOODS_ISSUE_KO324`) — 출하 확정 하나(`IF-SHIPMENT-PGI-SEND`)를 출하 라인마다 한 행으로 바꾼다.
 * LOT 은 보내지 않는다 — 라인의 출하수량이 LOT 합이다.
 * - 수불유형·출하처·출고 창고는 라인에 붙은 ERP 수주에서 이어받는다(컬럼 정의서). ERP 수주에 붙지 않은 라인은
 *   보낼 곳이 없어 빼고, 남는 라인이 없으면 보낼 것이 없다(2026-10-22 사용자 결정).
 * - 출고 일시는 공장 현지 시각이다. 출하전표 라인 순번(DN_SEQ_NO)은 숫자 NOT NULL 칸이라 출하요청 라인 순번과 같은
 *   값을 넣는다(고객 질문 10).
 */
export function goodsIssueBuilder(prisma: PrismaService): OutboundBuilder {
  return { interfaceCode: IF_SHIPMENT_PGI, build: (message) => build(prisma, message) };
}

async function build(prisma: PrismaService, message: OutboundMessage): Promise<RowDraft[]> {
  const shipment = await prisma.shipment.findUniqueOrThrow({
    where: { shipment_id: message.targetId },
    select: {
      shipment_no: true,
      shipped_at: true,
      confirmed_at: true,
      warehouse: { select: { plant: { select: { plant_code: true, timezone_code: true } } } },
      shipment_line: {
        orderBy: { line_no: 'asc' },
        select: {
          line_no: true,
          shipped_qty: true,
          uom_id: true,
          item: { select: { item_code: true, base_uom_id: true } },
          uom: { select: { uom_code: true } },
          shipment_request_line: {
            select: {
              requested_qty: true,
              sales_order_line: {
                select: {
                  erp_storage_location_code: true,
                  sales_order: {
                    select: {
                      erp_sales_order_no: true,
                      erp_movement_type_code: true,
                      partner_sales_order_customer_idTopartner: { select: { erp_partner_code: true } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  const lines = shipment.shipment_line.flatMap((line) => {
    const orderLine = line.shipment_request_line.sales_order_line;
    if (orderLine === null || orderLine.sales_order.erp_sales_order_no === null) return [];
    return [{ line, orderLine }];
  });
  if (lines.length === 0) return [];
  const shippedAt = shipment.shipped_at ?? shipment.confirmed_at;
  if (shippedAt === null) throw new Error(`출하 ${shipment.shipment_no} 에 출고 시각이 없다`);
  if (shipment.shipment_no.length > DN_REQ_NO_LENGTH) {
    throw new Error(`출하번호 ${shipment.shipment_no} 가 출하요청번호 칸(${DN_REQ_NO_LENGTH}자)보다 길다`);
  }
  const { plant } = shipment.warehouse;

  return lines.map(({ line, orderLine }) => {
    const order = orderLine.sales_order;
    const at = `출하 ${shipment.shipment_no} 라인 ${line.line_no}`;
    if (order.erp_movement_type_code === null) {
      throw new Error(`${at} — ERP 수주 ${order.erp_sales_order_no} 에 수불유형(MOV_TYPE)이 없다`);
    }
    if (orderLine.erp_storage_location_code === null) {
      throw new Error(`${at} — ERP 수주 ${order.erp_sales_order_no} 라인에 창고(SL_CD)가 없다`);
    }
    const shipTo = order.partner_sales_order_customer_idTopartner.erp_partner_code;
    if (shipTo === null) throw new Error(`${at} — 수주 거래처에 ERP 거래처 코드가 없다`);
    // 수불은 품목 기본단위로 한다(9/3 고객 답). 받은 환산표는 아직 쓰지 않는다.
    if (line.uom_id !== line.item.base_uom_id) throw new Error(`${at} — 단위가 품목 기본단위와 달라 환산이 필요하다`);
    return {
      table: GOODS_ISSUE,
      values: {
        DN_REQ_NO: shipment.shipment_no,
        DN_REQ_SEQ: line.line_no,
        MOV_TYPE: order.erp_movement_type_code,
        SHIP_TO_PARTY: shipTo,
        ACTUAL_GI_DT: relayDateTime(shippedAt, plant.timezone_code),
        PLANT_CD: plant.plant_code,
        SL_CD: orderLine.erp_storage_location_code,
        ITEM_CD: line.item.item_code,
        LOT_NO: '',
        LOT_SUB_NO: 0,
        GI_UNIT: line.uom.uom_code,
        REQ_QTY: line.shipment_request_line.requested_qty.toFixed(),
        GI_QTY: line.shipped_qty.toFixed(),
        REF_NO1: '',
        REF_NO2: '',
        DN_SEQ_NO: line.line_no,
      },
    };
  });
}

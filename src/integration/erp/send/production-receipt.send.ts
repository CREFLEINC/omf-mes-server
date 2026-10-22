import { Prisma } from '@prisma/client';

import { IF_WO_CLOSE } from '../../../core/outbox/outbox.service';
import { localDate } from '../../../planning/production-plan/plan-window';
import { PrismaService } from '../../../prisma/prisma.service';
import { ACTIVE_RESULT_WHERE } from '../../../production/work-order/work-order-progress';
import { OutboundBuilder, OutboundMessage } from '../outbound-builder';
import { RelayValues, RowDraft } from '../outbound-rows';
import { PROD_RSLT } from '../rcv-tables';

/** 재작업 W/O 는 보내지 않는다 — 처음 W/O 가 불량으로 보낸 수량이 양품으로 한 번 더 간다. */
const SENT_WORK_ORDER_TYPES = ['NORMAL', 'EMERGENCY'];

/**
 * 생산입고(`T_IF_RCV_PROD_RSLT_KO324`) — W/O 마감 하나(`IF-WO-CLOSE-SEND`)를 양품 1행·불량 1행으로 바꾼다.
 * ERP 는 근무조로 실적을 나누지 않는다(2026-10-22 사용자 결정).
 * - 라우팅의 마지막 공정 W/O 만 보낸다 — ERP W/O 는 공정번호(OPR_NO)가 하나다.
 * - ERP W/O 에 붙지 않은 MES W/O 는 보낼 곳이 없다.
 * - 불량 = 불량 + 폐기. 보류(판정 전)·재작업(다시 양품이 될 수 있다)은 보내지 않는다.
 * - 실적일은 마감한 날(공장 현지)이다. 근무조는 W/O 계획 근무조가 자정을 넘으면 N, 아니면 D.
 * - 고정값은 9/3 고객 답(INPUT_TYPE D · TRACKING_NO * · JOB_STATUS P · 외주가공 단가 0 · 금형 차수 빈 값)이다.
 *   불량유형(REASON_CD)은 varchar(2) 라 3자리 코드(B01)가 안 들어가 비운다(고객 질문 3).
 */
export function productionReceiptBuilder(prisma: PrismaService): OutboundBuilder {
  return { interfaceCode: IF_WO_CLOSE, build: (message) => build(prisma, message) };
}

async function build(prisma: PrismaService, message: OutboundMessage): Promise<RowDraft[]> {
  const workOrder = await prisma.work_order.findUniqueOrThrow({
    where: { work_order_id: message.targetId },
    select: {
      work_order_no: true,
      work_order_type_code: true,
      closed_at: true,
      item: { select: { base_uom_id: true } },
      shift: { select: { crosses_midnight: true } },
      routing_operation: { select: { routing_id: true, operation_seq: true } },
      production_plan: {
        select: {
          production_order: {
            select: {
              erp_order_no: true,
              erp_operation_no: true,
              uom_id: true,
              plant: { select: { plant_code: true, timezone_code: true } },
            },
          },
        },
      },
    },
  });
  const order = workOrder.production_plan?.production_order;
  if (!SENT_WORK_ORDER_TYPES.includes(workOrder.work_order_type_code)) return [];
  if (order?.erp_order_no === null || order?.erp_order_no === undefined) return [];
  if (!(await isLastOperation(prisma, workOrder.routing_operation))) return [];
  if (order.erp_operation_no === null) {
    throw new Error(`ERP W/O ${order.erp_order_no} 에 공정번호(OPR_NO)가 없다`);
  }
  if (workOrder.closed_at === null) throw new Error(`MES W/O ${workOrder.work_order_no} 가 마감되지 않았다`);

  const where = { work_order_id: message.targetId, ...ACTIVE_RESULT_WHERE };
  const units = await prisma.production_result.findMany({ where, select: { uom_id: true }, distinct: ['uom_id'] });
  // 수불은 품목 기본단위로 한다(9/3 고객 답). 오더단위가 다르면 환산표가 필요하다 — 받은 환산표는 아직 쓰지 않는다.
  if ([order.uom_id, ...units.map((unit) => unit.uom_id)].some((uom) => uom !== workOrder.item.base_uom_id)) {
    throw new Error(`ERP W/O ${order.erp_order_no} 의 단위가 품목 기본단위와 달라 환산이 필요하다`);
  }
  const sums = await prisma.production_result.aggregate({
    where,
    _sum: { good_qty: true, defect_qty: true, scrap_qty: true },
  });
  const good = sums._sum.good_qty ?? new Prisma.Decimal(0);
  const bad = (sums._sum.defect_qty ?? new Prisma.Decimal(0)).plus(sums._sum.scrap_qty ?? 0);

  const common: RelayValues = {
    PLANT_CD: order.plant.plant_code,
    PRODT_ORDER_NO: order.erp_order_no,
    OPR_NO: order.erp_operation_no,
    REPORT_DT: localDate(workOrder.closed_at, order.plant.timezone_code),
    SHIFT_CD: workOrder.shift?.crosses_midnight === true ? 'N' : 'D',
    REASON_CD: null,
    LOT_NO: '',
    LOT_SUB_NO: 0,
    // ERP 에서 MES W/O 를 찾아올 실마리 — 칸이 varchar(20) 이다.
    REMARK: workOrder.work_order_no.slice(0, 20),
    JOB_STATUS: 'P',
    INPUT_TYPE: 'D',
    TRACKING_NO: '*',
    SUBCONTRACT_PRC: 0,
    MOLD_BASE_SEQ: '',
  };
  const row = (reportType: 'G' | 'B', qty: Prisma.Decimal): RowDraft => ({
    table: PROD_RSLT,
    values: {
      ...common,
      REPORT_TYPE: reportType,
      PROD_QTY_IN_ORDER_UNIT: qty.toFixed(),
      PROD_QTY_IN_BASE_UNIT: qty.toFixed(),
    },
  });
  return [...(good.isZero() ? [] : [row('G', good)]), ...(bad.isZero() ? [] : [row('B', bad)])];
}

/** 라우팅의 마지막 공정인가 — 공정 순번이 가장 큰 것. */
async function isLastOperation(
  prisma: PrismaService,
  operation: { routing_id: bigint; operation_seq: number },
): Promise<boolean> {
  const last = await prisma.routing_operation.aggregate({
    where: { routing_id: operation.routing_id },
    _max: { operation_seq: true },
  });
  return last._max.operation_seq === operation.operation_seq;
}

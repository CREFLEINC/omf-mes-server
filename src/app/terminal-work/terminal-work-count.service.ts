import { Injectable } from '@nestjs/common';

import type { TerminalContext } from '../../auth/terminal-context';
import { pickingOrderWhere } from '../../logistics/picking/picking-query.service';
import { putawayTaskWhere } from '../../logistics/putaway/putaway-task.service';
import { FROM_SQL as SHIPMENT_FROM_SQL } from '../../logistics/shipment/shipment-query.sql';
import { shipmentWhereSql } from '../../logistics/shipment/shipment-query.service';
import { FROM_SQL as REQUEST_FROM_SQL, PICKING_COMPLETE_SQL } from '../../logistics/shipment-request/shipment-request-query.sql';
import { shipmentRequestWhereSql } from '../../logistics/shipment-request/shipment-request-query.service';
import { stockTransferWhere } from '../../logistics/stock-transfer/stock-transfer-query.service';
import { TerminalListScope } from '../../logistics/terminal-list-scope';
import { localDate } from '../../planning/production-plan/plan-window';
import { PrismaService } from '../../prisma/prisma.service';
import { workOrderListWhere } from '../../production/work-order/work-order-query.service';
import { inspectionRequestListWhere } from '../../quality/inspection/inspection-request.service';

export interface MobileWorkCounts {
  putaway: number;
  materialPicking: number;
  stockTransferArrival: number;
  shipmentPicking: number;
}

export interface PopWorkCounts {
  shipmentPacking: number;
  workStart: number;
  emergencyWorkOrder: number;
  reworkResult: number;
  oqcInspection: number;
}

/**
 * 단말 작업 수(omf-all-around#190 · research R-5). ⭐ 배지 수 = 그 화면 목록 건수 — 각 목록이 쓰는 조건 함수를
 * 그대로 불러 센다. 화면이 부르는 질의(아래 각 줄)를 바꾸면 여기도 바꾼다. 알림 설정과 무관하다(FR-019).
 * 「오늘」은 공장 시간대 날짜다(화면은 기기 날짜 — 현장은 같은 시간대다).
 */
@Injectable()
export class TerminalWorkCountService {
  constructor(private readonly prisma: PrismaService) {}

  async counts(terminal: TerminalContext): Promise<MobileWorkCounts | PopWorkCounts> {
    const scope: TerminalListScope = { plantId: terminal.plantId, warehouseId: terminal.warehouseId ?? null };
    const plant = await this.prisma.plant.findUniqueOrThrow({ where: { plant_id: terminal.plantId }, select: { timezone_code: true } });
    const today = localDate(new Date(), plant.timezone_code);
    return terminal.terminalTypeCode === 'POP' ? this.pop(terminal, scope, today) : this.mobile(scope, today);
  }

  private async mobile(scope: TerminalListScope, today: string): Promise<MobileWorkCounts> {
    const request = shipmentRequestWhereSql({ shipDateFrom: today, shipDateTo: today }, scope.plantId);
    const [putaway, materialPicking, stockTransferArrival, shipmentPicking] = await Promise.all([
      // M-01-05 적치: statusCode=PENDING
      this.prisma.putaway_task.count({ where: putawayTaskWhere({ statusCode: 'PENDING' }, scope) }),
      // M-01-08 자재 출고·피킹: statusCode=REGISTERED, 화면이 출처를 자재 출고 요청으로 거른다
      this.prisma.picking_order.count({
        where: { AND: [pickingOrderWhere({ statusCode: 'REGISTERED' }, scope), { source_document_type_code: 'MATERIAL_ISSUE_REQUEST' }] },
      }),
      // M-01-10 재고 이동: inTransitOnly=true(도착 창고 기준)
      this.prisma.stock_transfer.count({ where: stockTransferWhere({ inTransitOnly: true }, scope) }),
      // 제품 출하 피킹: 오늘 출하일 중 피킹이 끝나지 않은 출하지시(확정 항목 5 — 목록은 끝난 것도 보인다)
      this.rawCount(`SELECT count(*)::int AS total FROM ${REQUEST_FROM_SQL} WHERE (${request.sql}) AND NOT ${PICKING_COMPLETE_SQL}`, request.params),
    ]);
    return { putaway, materialPicking, stockTransferArrival, shipmentPicking };
  }

  private async pop(terminal: TerminalContext, scope: TerminalListScope, today: string): Promise<PopWorkCounts> {
    const packing = shipmentWhereSql({ pickedOnly: true, shipDateFrom: today, shipDateTo: today }, scope);
    // P-02-01 작업 시작: 설비가 있으면 그 설비 + 설비 미정 W/O(화면 기본 보기)
    const equipment = terminal.equipmentId === null ? {} : { plannedEquipmentId: Number(terminal.equipmentId), includeUnplannedEquipment: true };
    const workOrders = (query: Parameters<typeof workOrderListWhere>[1]) =>
      workOrderListWhere(this.prisma, query, terminal).then((where) => this.prisma.work_order.count({ where }));
    const [shipmentPacking, workStart, emergencyWorkOrder, reworkResult, oqcInspection] = await Promise.all([
      // P-04-01 출하 포장: pickedOnly=true, 오늘
      this.rawCount(`SELECT count(*)::int AS total FROM ${SHIPMENT_FROM_SQL} WHERE ${packing.sql}`, packing.params),
      workOrders({ open: true, ...equipment }),
      // P-02-12 긴급 W/O: workOrderTypeCode=EMERGENCY, open=true
      workOrders({ workOrderTypeCode: 'EMERGENCY', open: true }),
      // P-04-03 재작업 실적: workOrderTypeCode=REWORK, open=true(PLANNED 는 고를 수 없어 세지 않는다)
      workOrders({ workOrderTypeCode: 'REWORK', open: true }),
      // P-04-06 OQC: inspectionTypeCode=OQC, pendingOnly=true
      inspectionRequestListWhere(this.prisma, { inspectionTypeCode: 'OQC', pendingOnly: true }, {
        plantId: terminal.plantId,
        terminalId: terminal.terminalId,
        terminalTypeCode: 'POP',
      }).then((where) => this.prisma.inspection_request.count({ where })),
    ]);
    return { shipmentPacking, workStart, emergencyWorkOrder, reworkResult, oqcInspection };
  }

  private async rawCount(sql: string, params: unknown[]): Promise<number> {
    const [row] = await this.prisma.$queryRawUnsafe<{ total: number }[]>(sql, ...params);
    return row.total;
  }
}

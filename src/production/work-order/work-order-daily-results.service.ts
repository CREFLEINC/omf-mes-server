import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { DailyResultRow, dailyResultsOf } from './daily-results';
import { ACTIVE_RESULT_WHERE } from './work-order-progress';

/** 공장을 알 수 없는 W/O 의 시간대 — 현장이 하노이 한 곳이다(`dashboard-scope.ts` 와 같다). */
const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';

const SHIFT_SELECT = { select: { shift_id: true, shift_name: true, end_time: true, crosses_midnight: true } } as const;

/**
 * 마감 상세의 일자별 실적. 수량은 W/O 누계(`progress`)와 같은 잎 규칙(`ACTIVE_RESULT_WHERE`)으로 센다 —
 * 화면이 실적 목록을 쪽으로 돌며 묶으면 정정·자정 넘는 교대 판정이 서버와 갈린다.
 */
@Injectable()
export class WorkOrderDailyResultsService {
  constructor(private readonly prisma: PrismaService) {}

  async dailyResults(workOrderId: number) {
    const workOrder = await this.prisma.work_order.findUnique({
      where: { work_order_id: workOrderId },
      select: {
        order_qty: true,
        uom: { select: { uom_id: true, uom_code: true } },
        production_plan: { select: { production_order: { select: { plant: { select: { timezone_code: true } } } } } },
        production_line: { select: { plant: { select: { timezone_code: true } } } },
      },
    });
    if (workOrder === null) {
      throw new NotFoundException('없는 MES W/O 입니다. W/O 목록을 새로 고쳐 다시 고르세요.');
    }
    const timezone = workOrder.production_plan?.production_order.plant.timezone_code
      ?? workOrder.production_line?.plant.timezone_code
      ?? DEFAULT_TIMEZONE;

    const results = await this.prisma.production_result.findMany({
      where: { work_order_id: workOrderId, ...ACTIVE_RESULT_WHERE },
      select: {
        good_qty: true, defect_qty: true, hold_qty: true, scrap_qty: true, rework_qty: true,
        occurred_at: true, corrects_production_result_id: true,
        shift: SHIFT_SELECT,
        work_session: { select: { shift: SHIFT_SELECT } },
      },
    });
    // 등록은 실적에 교대를 비우고 세션이 교대를 갖는다 — 실적에 교대가 있으면 그것이 앞선다.
    const rows: DailyResultRow[] = results.map(({ shift, work_session, ...row }) => ({
      ...row,
      shift: shift ?? work_session?.shift ?? null,
    }));

    return {
      uomId: Number(workOrder.uom.uom_id),
      uomCode: workOrder.uom.uom_code,
      orderQty: workOrder.order_qty.toNumber(),
      ...dailyResultsOf(rows, timezone),
    };
  }
}

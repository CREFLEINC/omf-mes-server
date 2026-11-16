import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { plantPolicyText } from '../../app/policy/plant-policy-text';
import { proposedPlanDate } from '../../planning/plan-proposal/proposal-policy';
import { chooseRouting, defaultBomOf } from '../../planning/production-plan/master-choice';
import { PlanConfirmService } from '../../planning/production-plan/plan-confirm.service';
import { ProductionPlanService } from '../../planning/production-plan/production-plan.service';
import { createAutoRouting } from '../../planning/routing/auto-routing';
import { plantToday, usableWhere } from '../../planning/routing/routing.service';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkOrderReleaseService } from '../../production/work-order/work-order-release.service';

const ORDER_SELECT = {
  production_order_id: true,
  plant_id: true,
  item_id: true,
  uom_id: true,
  order_qty: true,
  planned_start_date: true,
  status_code: true,
  item: { select: { item_code: true } },
} satisfies Prisma.production_orderSelect;
type Order = Prisma.production_orderGetPayload<{ select: typeof ORDER_SELECT }>;

const PLAN_SELECT = { production_plan_id: true, status_code: true, version_no: true, created_automatically: true } satisfies Prisma.production_planSelect;
type Plan = Prisma.production_planGetPayload<{ select: typeof PLAN_SELECT }>;

/** 자동 흐름이 이어 받는 계획 상태 — 그 밖(사람이 손댄 상태)이면 손대지 않는다. */
const RESUMABLE = ['DRAFT', 'CONFIRMED'];

/**
 * OA 자동 W/O(안 B · 사용자 결정 2026-11-05 · 11-16) — ERP W/O 한 건을 계획·확정·배포까지 사람 없이 끌고 간다.
 * 계획·생산 코드를 둘 다 부른다 — 「다른 도메인의 service 를 부르지 않는다」의 예외로 연동 모듈에 둔다(사용자 2026-11-16).
 * 단계마다 트랜잭션이 따로라 중간에 끊길 수 있다 — 다시 부르면 남은 단계부터 잇는다. 기록자는 비운다(ERP 받기·다른 실행기와 같다).
 */
@Injectable()
export class AutoWorkOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: ProductionPlanService,
    private readonly confirms: PlanConfirmService,
    private readonly releases: WorkOrderReleaseService,
  ) {}

  /** 취소된 ERP W/O 나 사람이 세운 계획이 있는 ERP W/O 는 그대로 둔다. 못 하면 까닭을 담은 오류를 던진다. */
  async run(productionOrderId: bigint, now: Date = new Date()): Promise<void> {
    const order = await this.prisma.production_order.findUniqueOrThrow({
      where: { production_order_id: productionOrderId },
      select: ORDER_SELECT,
    });
    if (order.status_code === 'CANCELLED') return;
    const saved = await this.prisma.production_plan.findMany({
      where: { production_order_id: productionOrderId },
      select: PLAN_SELECT,
      orderBy: { production_plan_id: 'asc' },
    });
    if (saved.some((plan) => !plan.created_automatically || !RESUMABLE.includes(plan.status_code))) return;

    for (const plan of saved.length === 0 ? [await this.plan(order, now)] : saved) {
      if (plan.status_code === 'DRAFT') await this.confirms.confirm(Number(plan.production_plan_id), plan.version_no, undefined);
      await this.releaseAll(plan.production_plan_id);
    }
  }

  /** 계획량은 지시수량 전부, 계획일은 계획 제안과 같은 규칙이다. BOM 부터 본다 — 막히면 Routing 을 만들지 않는다. */
  private async plan(order: Order, now: Date): Promise<Plan> {
    const today = await plantToday(this.prisma, order.plant_id, now);
    const bomId = await this.bomOf(order);
    const routingId = await this.routingOf(order, today);
    const startDate = order.planned_start_date?.toISOString().slice(0, 10) ?? null;
    await this.plans.create(
      {
        productionOrderId: Number(order.production_order_id),
        planDate: proposedPlanDate(startDate, today),
        plannedQty: order.order_qty.toNumber(),
        uomId: Number(order.uom_id),
        bomId: Number(bomId),
        routingId: Number(routingId),
        planDateSourceCode: 'SYSTEM',
      },
      undefined,
      undefined,
      { createdAutomatically: true },
    );
    return this.prisma.production_plan.findFirstOrThrow({
      where: { production_order_id: order.production_order_id },
      select: PLAN_SELECT,
    });
  }

  /** 품목의 ERP 기본 BOM — 그 공장의 BOM 이어야 한다(사용자 결정 2026-11-04 — OA 는 PL13 BOM 만 푼다). */
  private async bomOf(order: Order): Promise<bigint> {
    const boms = await this.prisma.bom.findMany({
      where: { parent_item_id: order.item_id, is_default: true },
      select: { bom_id: true, plant_id: true },
    });
    const bomId = defaultBomOf(boms.map((bom) => bom.bom_id));
    if (bomId === null) throw new Error('품목의 ERP 기본 BOM 이 없습니다.');
    if (boms[0].plant_id !== order.plant_id) {
      throw new Error('품목의 기본 BOM 이 이 공장의 것이 아닙니다 — BOM 의 공장이 비었거나 다른 공장입니다.');
    }
    return bomId;
  }

  /**
   * 쓸 수 있는 Routing 이 있으면 그것(계획 제안과 같은 규칙). 품목에 Routing 이 하나도 없을 때만 공장 정책의 공정으로
   * 1공정 Routing 을 만든다 — 사람이 만든 Rev 가 있는데 쓸 수 없으면 사람이 고친다.
   */
  private async routingOf(order: Order, today: string): Promise<bigint> {
    const usable = await this.prisma.routing.findMany({
      where: { item_id: order.item_id, ...usableWhere(today) },
      select: { routing_id: true, is_default: true },
    });
    const chosen = chooseRouting(usable.map((routing) => ({ routingId: routing.routing_id, isDefault: routing.is_default })));
    if (chosen.routingId !== null) return chosen.routingId;
    if (chosen.reason === 'ROUTING_DEFAULT_REQUIRED') throw new Error('쓸 수 있는 Routing 이 여럿인데 기본 Routing 이 없습니다.');
    if ((await this.prisma.routing.count({ where: { item_id: order.item_id } })) > 0) {
      throw new Error('품목의 Routing 이 모두 작성중·폐기이거나 유효 기간 밖입니다 — 새로 만들지 않습니다.');
    }

    const processCode = await plantPolicyText(this.prisma, 'AUTO_ROUTING_PROCESS', order.plant_id, today);
    if (processCode === null) throw new Error('공장에 자동 라우팅 공정 정책(AUTO_ROUTING_PROCESS)이 없습니다.');
    const process = await this.prisma.process.findUnique({
      where: { process_code: processCode },
      select: { process_id: true, process_name: true, is_active: true },
    });
    if (process?.is_active !== true) throw new Error(`자동 라우팅 공정 ${processCode} 이 없거나 쓰지 않는 공정입니다.`);
    return this.prisma.$transaction((tx) =>
      createAutoRouting(tx, {
        itemId: order.item_id,
        itemCode: order.item.item_code,
        processId: process.process_id,
        operationName: process.process_name,
      }),
    );
  }

  /** 계획의 배포 전 W/O 를 배포한다. LOT 크기는 지시수량 — 한 W/O 에 제품 LOT 하나다(사용자 결정 2026-11-05). */
  private async releaseAll(productionPlanId: bigint): Promise<void> {
    const pending = await this.prisma.work_order.findMany({
      where: { production_plan_id: productionPlanId, released_at: null, status_code: { in: ['PLANNED', 'CONFIRMED'] } },
      select: { work_order_id: true, version_no: true, order_qty: true },
      orderBy: { work_order_id: 'asc' },
    });
    for (const workOrder of pending) {
      await this.releases.release(Number(workOrder.work_order_id), workOrder.version_no, { lotSize: workOrder.order_qty.toNumber() }, null);
    }
  }
}

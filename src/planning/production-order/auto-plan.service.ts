import { HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE } from '../../common/errors';
import { toDateString } from '../../common/master';
import { PrismaService } from '../../prisma/prisma.service';
import { localDate } from '../production-plan/plan-window';
import { PlanConfirmService } from '../production-plan/plan-confirm.service';
import { ProductionPlanService } from '../production-plan/production-plan.service';
import { DefaultMap, OperationNeed, pairKey, readDefaultMapsOf } from '../production-plan/resource-assign';
import { usableWhere as usableRoutingWhere } from '../routing/routing.service';
import {
  AutoPlanReason,
  AutoPlanView,
  MasterChoice,
  PlanFact,
  autoPlanDate,
  autoPlanView,
  chooseMasters,
  expansionHasLine,
} from './auto-plan';

const CONFIRMED = 'CONFIRMED';
const CANCELLED = 'CANCELLED';
/** 점유 시간 — 계획 생성·확정 전개가 이 안에 끝난다고 본다. 프로세스가 죽으면 이만큼 뒤 다시 할 수 있다. */
const CLAIM_SECONDS = 120;
/** `ProductionConflictResponse.code`(required). */
const INVALID_STATE = 'INVALID_STATE';

/** 판정에 쓰는 오더 칸만. */
export interface AutoPlanOrder {
  production_order_id: bigint;
  plant_id: bigint;
  item_id: bigint;
  order_qty: Prisma.Decimal;
  status_code: string;
  auto_plan_attempted_at: Date | null;
}

/** 계약 `ProductionOrderAutoPlanResult`. */
export interface AutoPlanResult {
  productionOrderId: number;
  outcome: 'CONFIRMED' | 'DRAFT' | 'NOT_PLANNED';
  productionPlanId: number | null;
  reasons: AutoPlanReason[];
}

interface PlanRow {
  production_plan_id: bigint;
  production_order_id: bigint;
  status_code: string;
  planned_qty: Prisma.Decimal;
  routing_id: bigint;
  planned_line_id: bigint | null;
  version_no: number;
}

interface OrderFacts {
  plans: (PlanRow & PlanFact)[];
  /** 계획이 없는 오더만 — 지금 자동 계획을 세운다면 고를 BOM·Routing. */
  choice?: MasterChoice;
  /** `choice` 로 세운 계획을 확정하면 W/O 에 라인이 서는가. */
  choiceLineKnown?: boolean;
}

/**
 * ERP W/O 를 받으면 계획을 하나 세우고, 정할 수 있으면 확정까지 한다. 정할 수 없으면 확정하지 않고
 * 그 이유를 목록·상세의 `autoPlan` 으로 보인다 — 별도 표 없이 읽을 때 계산한다.
 */
@Injectable()
export class AutoPlanService {
  private readonly logger = new Logger(AutoPlanService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: ProductionPlanService,
    private readonly confirms: PlanConfirmService,
  ) {}

  /**
   * 오더 수신 뒤 — 수신이 커밋된 «다음»에 부른다. 건너뛸지(`skipOnReceipt`)는 수신이 정하고 시도 시각도 수신 트랜잭션에서
   * 찍는다 — 여기서 무엇이 실패해도 오더는 「확인 필요」로 남고 `:auto-plan` 으로 다시 한다. ⛔ 실패를 던지지 않는다.
   */
  async planReceived(productionOrderId: number, appUserId: number | undefined): Promise<void> {
    try {
      await this.run(productionOrderId, appUserId);
    } catch (error) {
      this.logger.warn(`ERP W/O ${String(productionOrderId)} 자동 계획 실패 — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 계획이 없으면 세우고(정할 수 있으면 확정), 작성중 계획이 있으면 이제 라인이 서는지 보고 확정한다.
   * 확정 계획이 수량을 채웠으면 바꾸지 않는다. 확정에서 막히면 확정의 오류를 그대로 낸다.
   * 취소된 오더는 400 `STATE_LOCKED`, 다른 자동 계획이 돌고 있으면 409 `INVALID_STATE` 다.
   */
  async run(productionOrderId: number, appUserId: number | undefined): Promise<AutoPlanResult> {
    const found = await this.prisma.production_order.findUnique({
      where: { production_order_id: BigInt(productionOrderId) },
      select: { production_order_id: true, plant_id: true, item_id: true, order_qty: true, uom_id: true, planned_start_date: true, status_code: true },
    });
    if (!found) throw new NotFoundException('없는 생산오더입니다.');
    if (found.status_code === CANCELLED) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '취소된 생산오더는 계획을 세우지 않습니다.' },
      ]);
    }
    await this.claim(found.production_order_id);
    try {
      return await this.runClaimed({ ...found, auto_plan_attempted_at: new Date() }, appUserId);
    } finally {
      await this.prisma.$executeRaw`
        UPDATE planning.production_order SET auto_plan_running_until = NULL WHERE production_order_id = ${found.production_order_id}`;
    }
  }

  /**
   * ⛔ 오더마다 하나씩 — 「계획이 있나」를 본 뒤 세우기까지 사이에 다른 호출이 끼면 둘 다 계획을 세운다. 트랜잭션·연결을
   * 쥐고 기다리지 않게 행 하나의 조건부 UPDATE 로 점유하고, 못 잡으면 바로 409 다. 시도 시각도 함께 찍는다.
   * 판(`version_no`)은 올리지 않는다 — 업무 값이 아니라서, 확인(`:acknowledge`)의 If-Match 를 낡게 만들면 안 된다.
   */
  private async claim(productionOrderId: bigint): Promise<void> {
    const claimed = await this.prisma.$executeRaw`
      UPDATE planning.production_order
         SET auto_plan_running_until = clock_timestamp() + make_interval(secs => ${CLAIM_SECONDS}),
             auto_plan_attempted_at = clock_timestamp()
       WHERE production_order_id = ${productionOrderId}
         AND (auto_plan_running_until IS NULL OR auto_plan_running_until < clock_timestamp())`;
    if (claimed === 0) {
      throw new ConflictException('user', '이 생산오더의 자동 계획이 이미 진행 중입니다. 잠시 뒤 다시 시도하세요.', { code: INVALID_STATE });
    }
  }

  private async runClaimed(
    order: AutoPlanOrder & { uom_id: bigint; planned_start_date: Date | null },
    appUserId: number | undefined,
  ): Promise<AutoPlanResult> {
    const productionOrderId = Number(order.production_order_id);
    const facts = (await this.factsOf([order])).get(order.production_order_id) as OrderFacts;
    const { outcome, productionPlanId } = await this.act(order, facts, appUserId);
    const view = (await this.viewsOf([order])).get(order.production_order_id);
    return { productionOrderId, outcome, productionPlanId, reasons: view?.reasons ?? [] };
  }

  /** 페이지 단위로 읽는다 — 오더마다 돌지 않는다. */
  async viewsOf(orders: readonly AutoPlanOrder[]): Promise<Map<bigint, AutoPlanView | null>> {
    const facts = await this.factsOf(orders);
    return new Map(
      orders.map((order) => {
        const fact = facts.get(order.production_order_id) as OrderFacts;
        const unplanned = [...(fact.choice?.reasons ?? []), ...(fact.choiceLineKnown === false ? (['LINE_UNKNOWN'] as const) : [])];
        // 취소된 오더는 계획할 일이 없다 — 「확인 필요」로 남기지 않는다.
        if (order.status_code === CANCELLED) return [order.production_order_id, null];
        return [order.production_order_id, autoPlanView(order.order_qty, fact.plans, unplanned, order.auto_plan_attempted_at !== null)];
      }),
    );
  }

  private async act(
    order: AutoPlanOrder & { uom_id: bigint; planned_start_date: Date | null },
    facts: OrderFacts,
    appUserId: number | undefined,
  ): Promise<Pick<AutoPlanResult, 'outcome' | 'productionPlanId'>> {
    if (facts.plans.length === 0) return this.planFresh(order, facts, appUserId);

    const confirmed = facts.plans.filter((plan) => plan.confirmed);
    const confirmedQty = confirmed.reduce((sum, plan) => sum.plus(plan.planned_qty), new Prisma.Decimal(0));
    if (confirmedQty.gte(order.order_qty)) {
      return { outcome: 'CONFIRMED', productionPlanId: Number(confirmed[confirmed.length - 1].production_plan_id) };
    }
    const draft = facts.plans.find((plan) => !plan.confirmed);
    if (draft === undefined) return { outcome: 'NOT_PLANNED', productionPlanId: null };
    const draftId = Number(draft.production_plan_id);
    if (!draft.lineKnown) return { outcome: 'DRAFT', productionPlanId: draftId };
    await this.confirms.confirm(draftId, draft.version_no, appUserId);
    return { outcome: 'CONFIRMED', productionPlanId: draftId };
  }

  /** 라인을 모르면 작성중으로 둔다 — 사람이 라인만 고르고 확정하면 된다. */
  private async planFresh(
    order: AutoPlanOrder & { uom_id: bigint; planned_start_date: Date | null },
    facts: OrderFacts,
    appUserId: number | undefined,
  ): Promise<Pick<AutoPlanResult, 'outcome' | 'productionPlanId'>> {
    const choice = facts.choice as MasterChoice;
    if (choice.bomId === null || choice.routingId === null) return { outcome: 'NOT_PLANNED', productionPlanId: null };

    const plant = await this.prisma.plant.findUniqueOrThrow({ where: { plant_id: order.plant_id }, select: { timezone_code: true } });
    const plan = await this.plans.create(
      {
        productionOrderId: Number(order.production_order_id),
        planDate: autoPlanDate(toDateString(order.planned_start_date), localDate(new Date(), plant.timezone_code)),
        plannedQty: Number(order.order_qty),
        uomId: Number(order.uom_id),
        bomId: Number(choice.bomId),
        routingId: Number(choice.routingId),
      },
      appUserId,
    );
    if (facts.choiceLineKnown !== true) return { outcome: 'DRAFT', productionPlanId: plan.productionPlanId };
    await this.confirms.confirm(plan.productionPlanId, plan.versionNo, appUserId);
    return { outcome: 'CONFIRMED', productionPlanId: plan.productionPlanId };
  }

  /** 계획 → (계획 없는 오더의) BOM·Routing → 라인 판정에 쓸 공정·기본 매핑 순으로 몇 번의 쿼리로 모은다. */
  private async factsOf(orders: readonly AutoPlanOrder[]): Promise<Map<bigint, OrderFacts>> {
    const result = new Map<bigint, OrderFacts>();
    if (orders.length === 0) return result;

    const planRows = await this.prisma.production_plan.findMany({
      where: { production_order_id: { in: orders.map((order) => order.production_order_id) } },
      orderBy: { production_plan_id: 'asc' },
      select: {
        production_plan_id: true, production_order_id: true, status_code: true, planned_qty: true,
        routing_id: true, planned_line_id: true, version_no: true,
      },
    });
    const plansOf = groupBy(planRows, (plan) => plan.production_order_id);

    // 시도한 적 없거나 취소된 미계획 오더는 상태가 없다 — BOM·Routing 을 읽지 않는다.
    const unplanned = orders.filter(
      (order) => !plansOf.has(order.production_order_id) && order.auto_plan_attempted_at !== null && order.status_code !== CANCELLED,
    );
    const itemIds = [...new Set(unplanned.map((order) => order.item_id))];
    const [boms, routings] =
      itemIds.length === 0
        ? [[], []]
        : await Promise.all([
            this.prisma.bom.findMany({ where: { parent_item_id: { in: itemIds }, is_default: true }, select: { bom_id: true, parent_item_id: true } }),
            this.prisma.routing.findMany({ where: { item_id: { in: itemIds }, ...usableRoutingWhere() }, select: { routing_id: true, item_id: true, is_default: true } }),
          ]);
    const bomsOf = groupBy(boms, (bom) => bom.parent_item_id);
    const routingsOf = groupBy(routings, (routing) => routing.item_id);
    const choices = new Map(
      unplanned.map((order) => [
        order.production_order_id,
        chooseMasters(
          (bomsOf.get(order.item_id) ?? []).map((bom) => bom.bom_id),
          (routingsOf.get(order.item_id) ?? []).map((routing) => ({ routingId: routing.routing_id, isDefault: routing.is_default })),
        ),
      ]),
    );

    // 라인 판정이 필요한 것 — 고른 Routing 이 있는 미계획 오더와 라인 없는 작성중 계획.
    const judged = orders.filter((order) => {
      const choice = choices.get(order.production_order_id);
      if (choice !== undefined) return choice.bomId !== null && choice.routingId !== null;
      return (plansOf.get(order.production_order_id) ?? []).some((plan) => plan.status_code !== CONFIRMED && plan.planned_line_id === null);
    });
    const routingIds = new Set<bigint>();
    for (const order of judged) {
      const chosen = choices.get(order.production_order_id)?.routingId;
      if (chosen != null) routingIds.add(chosen);
      for (const plan of plansOf.get(order.production_order_id) ?? []) {
        if (plan.status_code !== CONFIRMED && plan.planned_line_id === null) routingIds.add(plan.routing_id);
      }
    }
    const [operations, maps] = await Promise.all([
      routingIds.size === 0
        ? Promise.resolve([])
        : this.prisma.routing_operation.findMany({
            where: { routing_id: { in: [...routingIds] } },
            orderBy: [{ routing_id: 'asc' }, { operation_seq: 'asc' }],
            select: { routing_id: true, routing_operation_id: true, process_id: true, equipment_required: true, mold_required: true },
          }),
      readDefaultMapsOf(this.prisma, uniquePairs(judged)),
    ]);
    const operationsOf = new Map<bigint, OperationNeed[]>();
    for (const operation of operations) {
      operationsOf.set(operation.routing_id, [
        ...(operationsOf.get(operation.routing_id) ?? []),
        {
          routingOperationId: operation.routing_operation_id,
          processId: operation.process_id,
          equipmentRequired: operation.equipment_required,
          moldRequired: operation.mold_required,
        },
      ]);
    }
    const lineKnown = (order: AutoPlanOrder, planLineId: bigint | null, routingId: bigint): boolean => {
      const orderMaps: DefaultMap[] = maps.get(pairKey(order.plant_id, order.item_id)) ?? [];
      return expansionHasLine(planLineId, operationsOf.get(routingId) ?? [], orderMaps);
    };

    for (const order of orders) {
      const id = order.production_order_id;
      const choice = choices.get(id);
      const plans = (plansOf.get(id) ?? []).map((plan) => ({
        ...plan,
        confirmed: plan.status_code === CONFIRMED,
        plannedQty: plan.planned_qty,
        lineKnown: plan.status_code === CONFIRMED || lineKnown(order, plan.planned_line_id, plan.routing_id),
      }));
      result.set(id, {
        plans,
        ...(choice === undefined ? {} : { choice }),
        ...(choice?.routingId == null || choice.bomId === null ? {} : { choiceLineKnown: lineKnown(order, null, choice.routingId) }),
      });
    }
    return result;
  }
}

function groupBy<T>(rows: readonly T[], key: (row: T) => bigint): Map<bigint, T[]> {
  const map = new Map<bigint, T[]>();
  for (const row of rows) map.set(key(row), [...(map.get(key(row)) ?? []), row]);
  return map;
}

function uniquePairs(orders: readonly AutoPlanOrder[]): { plantId: bigint; itemId: bigint }[] {
  const pairs = new Map<string, { plantId: bigint; itemId: bigint }>();
  for (const order of orders) pairs.set(pairKey(order.plant_id, order.item_id), { plantId: order.plant_id, itemId: order.item_id });
  return [...pairs.values()];
}

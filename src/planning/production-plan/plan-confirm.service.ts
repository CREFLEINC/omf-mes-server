import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ERROR_CODE, field, one } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { DocumentStateService } from '../../core/document-state';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanToExpand, dependencyRows, workOrderRows } from './expand';
import { assertPlanVersion, lockPlan } from './production-plan.service';
import { ProductionPlanView, productionPlanView } from './production-plan-view';

const STATUS_COLUMN = 'planning.production_plan.status_code';
const DRAFT = 'DRAFT';
/** `work_order_no` 채번 재시도 상한(I-2 R-2 · `goods-receipt.service.ts` 선례). */
const NUMBER_RETRY = 3;
/** `ProductionConflictResponse.code`(required) — 이 파일 전용이다. */
const VERSION_CONFLICT = 'VERSION_CONFLICT';
const DUPLICATE_KEY = 'DUPLICATE_KEY';

/**
 * 계획 확정 + Routing 공정별 W/O 전개를 한 트랜잭션으로(계약 「부분 성공을 만들지 않는다」).
 * ⛔ `src/production/` 의 service 를 부르지 않는다 — `tx.work_order.*` 를 직접 쓴다. 금지된 것은
 * 도메인 «간 service 호출»이고 prisma 직접 쓰기가 아니다(I-24 R-2 · §3-2).
 */
@Injectable()
export class PlanConfirmService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly documentState: DocumentStateService,
  ) {}

  async confirm(productionPlanId: number, version: number, appUserId: number | undefined): Promise<ProductionPlanView> {
    for (let attempt = 0; ; attempt += 1) {
      const plan = await this.read(productionPlanId);
      try {
        return await this.expand(plan, version, await this.workOrderNos(plan), appUserId);
      } catch (error) {
        if (!isDuplicateWorkOrderNo(error)) throw error;
        if (attempt >= NUMBER_RETRY) {
          throw new ConflictException('user', '작업지시번호를 매기지 못했습니다. 다시 시도해 주세요.', { code: DUPLICATE_KEY });
        }
      }
    }
  }

  /** tx 밖 ①~③ — 없는 계획은 404, 공정 0건 Routing 은 400 `LINE_REQUIRED` 다(§3-7). */
  private async read(productionPlanId: number): Promise<PlanToExpand> {
    const plan = await this.prisma.production_plan.findUnique({
      where: { production_plan_id: BigInt(productionPlanId) },
      select: { planned_qty: true, routing_id: true, status_code: true, uom_id: true, production_order: { select: { item_id: true } } },
    });
    if (!plan) throw new NotFoundException('없는 생산계획입니다.');

    const operations = await this.prisma.routing_operation.findMany({
      where: { routing_id: plan.routing_id },
      orderBy: { operation_seq: 'asc' },
      select: { routing_operation_id: true },
    });
    if (operations.length === 0) throw one(field('routingId', ERROR_CODE.LINE_REQUIRED, '공정이 한 줄도 없습니다.'));
    const operationIds = operations.map((operation) => operation.routing_operation_id);
    const dependencies = await this.prisma.routing_operation_dependency.findMany({
      where: { predecessor_operation_id: { in: operationIds }, successor_operation_id: { in: operationIds } },
      select: { predecessor_operation_id: true, successor_operation_id: true, dependency_type_code: true },
    });
    const { item_id: itemId } = plan.production_order;
    return { productionPlanId, statusCode: plan.status_code, itemId, plannedQty: plan.planned_qty, uomId: plan.uom_id, operationIds, dependencies };
  }

  /**
   * ⛔ 번호는 `$transaction` 을 «열기 전»에 뽑는다. 확정된 계획이면 아예 안 뽑는다 — 어차피
   * 전이 판정이 막아 N 개가 결번으로 탄다(R-6).
   * ⚠ 공장 축은 형제 `work-order-write.service.ts:140` 과 같이 **비운다** — 공장 지정본이
   * 전역본을 이겨, 규칙이 한 줄이라도 등재되면 두 경로가 다른 카운터로 같은 번호를 뽑는다.
   * 등재되면 두 자리를 함께 옮긴다.
   */
  private async workOrderNos(plan: PlanToExpand): Promise<string[]> {
    if (plan.statusCode !== DRAFT) return [];
    const today = new Date().toISOString().slice(0, 10);
    const numbers: string[] = [];
    for (let index = 0; index < plan.operationIds.length; index += 1) {
      numbers.push(await this.numbering.next('WORK_ORDER', null, today));
    }
    return numbers;
  }

  /** tx 안 ⑤~⑪ — 404 → 409 → 400 `STATE_LOCKED` 순이다(§3-7). */
  private expand(plan: PlanToExpand, version: number, workOrderNos: string[], appUserId: number | undefined): Promise<ProductionPlanView> {
    const productionPlanId = BigInt(plan.productionPlanId);
    return this.prisma.$transaction(async (tx) => {
      const locked = await lockPlan(tx, plan.productionPlanId);
      assertPlanVersion(locked, version);
      // ⛔ 400 이다 — 409 는 If-Match 저장 충돌이 쓴다(계약 `statusCode` 설명).
      const transition = this.documentState.assertTransition(STATUS_COLUMN, 'plan-confirm', locked.status_code, HttpStatus.BAD_REQUEST);

      const created = await tx.work_order.createManyAndReturn({
        data: workOrderRows(plan, workOrderNos, appUserId),
        select: { work_order_id: true, routing_operation_id: true },
      });
      if (plan.dependencies.length > 0) {
        const workOrderIdOf = new Map(created.map((row) => [row.routing_operation_id, row.work_order_id]));
        await tx.work_order_dependency.createMany({ data: dependencyRows(plan, workOrderIdOf, appUserId) });
      }

      const updated = await tx.production_plan.updateMany({
        where: { production_plan_id: productionPlanId, version_no: version },
        data: { status_code: transition.to, confirmed_at: new Date(), confirmed_by: appUserId ?? null, updated_by: appUserId ?? null, version_no: { increment: 1 } },
      });
      // 잠금 밖 경합의 마지막 그물 — 위 토큰 대조와 겹치는 것이 맞다.
      assertUpdated(updated.count, 'user', { code: VERSION_CONFLICT });

      return productionPlanView(await tx.production_plan.findUniqueOrThrow({ where: { production_plan_id: productionPlanId } }));
    });
  }
}

function isDuplicateWorkOrderNo(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const target = (error.meta ?? {}).target;
  return Array.isArray(target) && target.includes('work_order_no');
}

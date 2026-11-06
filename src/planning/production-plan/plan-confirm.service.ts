import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ERROR_CODE, field, one } from '../../common/errors';
import { fgLinkMessage, resolveFgLocation } from '../../core/erp-warehouse/fg-location';
import { assertUpdated } from '../../common/optimistic-lock';
import { DocumentStateService } from '../../core/document-state';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { assertPlannableRouting } from '../routing/routing.service';
import { PlanLine, PlanToExpand, WorkOrderSupplement, dependencyRows, workOrderRows } from './expand';
import { assertDefaultBom } from './master-choice';
import { DEFAULT_DAY_START, PlanWindow, dayWindow, timeOfColumn } from './plan-window';
import { assertWithinOrder } from './plan-quantity';
import { assertPlanVersion, lockPlan } from './production-plan.service';
import { assignResources, readDefaultMaps } from './resource-assign';
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
      const plan = await this.materials(this.prisma, productionPlanId);
      try {
        const workOrderNos = await this.workOrderNos(plan);
        return await this.prisma.$transaction((tx) => this.confirmIn(tx, plan, version, workOrderNos, appUserId));
      } catch (error) {
        if (!isDuplicateWorkOrderNo(error)) throw error;
        if (attempt >= NUMBER_RETRY) {
          throw new ConflictException('user', 'MES W/O 번호를 매기지 못했습니다. 다시 시도해 주세요.', { code: DUPLICATE_KEY });
        }
      }
    }
  }

  /**
   * ①~③ — 없는 계획은 404, 공정 0건 Routing 은 400 `LINE_REQUIRED`, 쓸 수 없는 Routing 은 400 `INVALID` 다(§3-7).
   * `:confirm` 은 트랜잭션 밖에서, 계획 제안 확정은 방금 그 트랜잭션에서 쓴 계획을 읽어야 해 그 트랜잭션으로 부른다.
   */
  async materials(client: Prisma.TransactionClient, productionPlanId: number): Promise<PlanToExpand> {
    const plan = await client.production_plan.findUnique({
      where: { production_plan_id: BigInt(productionPlanId) },
      select: {
        planned_qty: true, routing_id: true, status_code: true, uom_id: true, plan_date: true, planned_line_id: true,
        production_order: { select: { item_id: true, plant_id: true, erp_storage_location_code: true } },
      },
    });
    if (!plan) throw new NotFoundException('없는 생산계획입니다.');

    const operations = await client.routing_operation.findMany({
      where: { routing_id: plan.routing_id },
      orderBy: { operation_seq: 'asc' },
      select: { routing_operation_id: true, process_id: true, equipment_required: true, mold_required: true },
    });
    if (operations.length === 0) throw one(field('routingId', ERROR_CODE.LINE_REQUIRED, '공정이 한 줄도 없습니다.'));
    // 작성 중 계획만 본다 — 확정된 계획의 재확정은 아래 전이 판정이 400 STATE_LOCKED 로 막는다.
    if (plan.status_code === DRAFT) await assertPlannableRouting(client, plan.routing_id, plan.production_order.item_id, plan.production_order.plant_id);
    const operationIds = operations.map((operation) => operation.routing_operation_id);
    const dependencies = await client.routing_operation_dependency.findMany({
      where: { predecessor_operation_id: { in: operationIds }, successor_operation_id: { in: operationIds } },
      select: { predecessor_operation_id: true, successor_operation_id: true, dependency_type_code: true },
    });
    const { item_id: itemId, plant_id: plantId } = plan.production_order;
    const window = await planWindow(client, plantId, plan.plan_date);
    const line = await planLine(client, plan.planned_line_id);
    const fg = await resolveFgLocation(client, { plantId, erpCode: plan.production_order.erp_storage_location_code });
    const needs = operations.map((operation) => ({
      routingOperationId: operation.routing_operation_id,
      processId: operation.process_id,
      equipmentRequired: operation.equipment_required,
      moldRequired: operation.mold_required,
    }));
    const resources = assignResources(needs, await readDefaultMaps(client, plantId, itemId));
    const equipmentLines = await equipmentLinesOf(client, [...resources.values()].map((resource) => resource.equipmentLineId));
    return {
      productionPlanId, statusCode: plan.status_code, itemId, plannedQty: plan.planned_qty, uomId: plan.uom_id,
      operationIds, window, line, fg, resources, equipmentLines, dependencies,
    };
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

  /**
   * tx 안 ⑤~⑪ — 404 → 409 → 400 `STATE_LOCKED` → 400 `BOM_NOT_DEFAULT` 순이다(§3-7). 번호는 호출자가 트랜잭션 «밖»에서 뽑아 넘긴다.
   * `supplements` 는 계획 제안 확정이 공정마다 고른 4M 이다 — 없는 공정은 계획 라인·기본 매핑을 쓴다.
   */
  async confirmIn(
    tx: Prisma.TransactionClient,
    plan: PlanToExpand,
    version: number,
    workOrderNos: string[],
    appUserId: number | undefined,
    supplements?: ReadonlyMap<bigint, WorkOrderSupplement>,
  ): Promise<ProductionPlanView> {
    const productionPlanId = BigInt(plan.productionPlanId);
    const locked = await lockPlan(tx, plan.productionPlanId);
    assertPlanVersion(locked, version);
    // ⛔ 400 이다 — 409 는 If-Match 저장 충돌이 쓴다(계약 `statusCode` 설명).
    const transition = this.documentState.assertTransition(STATUS_COLUMN, 'plan-confirm', locked.status_code, HttpStatus.BAD_REQUEST);
    // 저장한 뒤 ERP 가 BOM 판을 바꿨을 수 있다 — 확정 직전에 다시 본다. 확정된 계획은 위 전이가 이미 막았다.
    const { bom_id: bomId } = await tx.production_plan.findUniqueOrThrow({ where: { production_plan_id: productionPlanId }, select: { bom_id: true } });
    await assertDefaultBom(tx, bomId, plan.itemId);
    // 계획 제안 확정은 공정마다 완제품 위치를 본문으로 받아 이미 같은 판정으로 검증했다 — 직접 확정만 여기서 막는다.
    if (supplements === undefined && plan.fg.kind === 'LINK_FAILED') {
      throw one(field('erpStorageLocationCode', plan.fg.reason, fgLinkMessage(plan.fg)));
    }

    // 작성 → 확정은 합계를 바꾸지 않는다 — 오더 수량이 줄어 이미 넘은 계획이 확정되는 것을 막는다.
    await assertWithinOrder(tx, locked.production_order_id, new Prisma.Decimal(0));

    const created = await tx.work_order.createManyAndReturn({
      data: workOrderRows(plan, workOrderNos, appUserId, supplements),
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
  }
}

export function isDuplicateWorkOrderNo(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const target = (error.meta ?? {}).target;
  return Array.isArray(target) && target.includes('work_order_no');
}

async function equipmentLinesOf(client: Prisma.TransactionClient, lineIds: (bigint | null)[]): Promise<Map<bigint, PlanLine>> {
  const ids = [...new Set(lineIds.filter((id) => id !== null))];
  const lines = await Promise.all(ids.map((id) => planLine(client, id)));
  return new Map(ids.map((id, index) => [id, lines[index]]));
}

/** 계획의 라인과 그 라인의 기본 위치 셋 — 4M 에서 W/O 마다 고르지 않게 미리 채운다. */
async function planLine(client: Prisma.TransactionClient, lineId: bigint | null): Promise<PlanLine> {
  const row = lineId === null ? null : await client.production_line.findUnique({
    where: { production_line_id: lineId },
    select: { default_wip_location_id: true, default_fg_location_id: true, default_scrap_location_id: true },
  });
  return {
    productionLineId: lineId,
    defaultWipLocationId: row?.default_wip_location_id ?? null,
    defaultFgLocationId: row?.default_fg_location_id ?? null,
    defaultScrapLocationId: row?.default_scrap_location_id ?? null,
  };
}

/** 근무일 하루 — 가장 이른 활성 교대 시작부터 24시간. 교대가 없으면 08:00 부터다. */
async function planWindow(client: Prisma.TransactionClient, plantId: bigint, planDate: Date): Promise<PlanWindow> {
  const [plant, firstShift] = await Promise.all([
    client.plant.findUniqueOrThrow({ where: { plant_id: plantId }, select: { timezone_code: true } }),
    client.shift.findFirst({ where: { plant_id: plantId, is_active: true }, orderBy: { start_time: 'asc' }, select: { start_time: true } }),
  ]);
  const dayStart = firstShift === null ? DEFAULT_DAY_START : timeOfColumn(firstShift.start_time);
  return dayWindow(planDate.toISOString().slice(0, 10), dayStart, plant.timezone_code);
}

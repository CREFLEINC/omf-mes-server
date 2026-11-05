import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';

import { ConflictException, ContractException, ERROR_CODE } from '../../common/errors';
import { IdempotencyConflictCode, IdempotencyService } from '../../common/idempotency';
import { idempotencyContextOf } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanConfirmService, isDuplicateWorkOrderNo } from '../production-plan/plan-confirm.service';
import { assertWithinOrder, isPlanCancelled, precheckWithinOrder } from '../production-plan/plan-quantity';
import { Proposal, ProposalBasis, buildProposals } from './proposal-builder';
import { ProposalConfirmBody, ResolvedPlan, quantityDelta, resolveConfirm } from './proposal-confirm-check';
import { readProposalFacts } from './proposal-reader';
import { ProposalView, proposalView } from './proposal-view';

/** 계약 `ProductionPlanProposalConfirmResult`. */
export interface ProposalConfirmResult {
  productionOrderId: number;
  outcome: 'CONFIRMED' | 'ALREADY_PROCESSED';
  plans: {
    proposalPlanKey?: string;
    productionPlanId: number;
    planNo: string;
    statusCode: string;
    versionNo: number;
    workOrders: { workOrderId: number; workOrderNo: string; routingOperationId: number }[];
  }[];
}

const DRAFT = 'DRAFT';
const CANCELLED = 'CANCELLED';
const PRODUCTION_PLAN = 'PRODUCTION_PLAN';
const WORK_ORDER = 'WORK_ORDER';
/** 계획 여럿의 확정 전개를 한 트랜잭션에 담는다 — 기본 5초로는 공정이 많은 묶음이 넘칠 수 있다(입고·출고 서비스와 같은 값). */
const TRANSACTION_OPTIONS = { timeout: 15_000, maxWait: 5_000 };
/** 계획번호·W/O 번호 채번 재시도 상한(`plan-confirm.service.ts` 와 같다). */
const NUMBER_RETRY = 3;
const BASIS_LABEL: Record<keyof ProposalBasis, string> = {
  productionOrder: 'ERP W/O 가 바뀌었습니다(수량·상태·계획 시작일).',
  plans: '이 ERP W/O 의 계획이 바뀌었습니다 — 다른 사람이나 다른 화면이 계획을 등록·수정·확정했습니다.',
  bom: '품목의 ERP 기본 BOM 이 바뀌었습니다.',
  routing: '품목의 Routing·공정이 바뀌었습니다.',
  resources: '자원 기준정보(기본 매핑·라인·설비·금형·교대)가 바뀌었습니다.',
};

interface Numbers {
  planNos: string[];
  workOrderNos: string[];
}

type Checked = { already: true } | { already: false; proposal: Proposal; resolved: ResolvedPlan[] };

/**
 * 계획 제안 — 조회는 계산만 하고(저장·채번·상태 변경·멱등 기록 없음), 확정은 사람이 고른 ERP W/O 하나를 한 트랜잭션으로 저장한다.
 * 조회와 확정은 같은 읽기(`readProposalFacts`)·같은 계산(`buildProposals`)을 쓴다 — 확정은 그것을 잠근 트랜잭션에서 다시 돌려 basis 를 견준다.
 */
@Injectable()
export class PlanProposalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly idempotency: IdempotencyService,
    private readonly confirms: PlanConfirmService,
  ) {}

  /** 범위 밖·없는 id 는 제안하지 않고 따로 돌려준다 — 둘을 가르지 않는다. 입력 순서대로, 같은 id 는 한 번. */
  async propose(productionOrderIds: readonly number[], scope: bigint[] | null): Promise<{ items: ProposalView[]; notFoundProductionOrderIds: number[] }> {
    const ids = [...new Set(productionOrderIds)].map((id) => BigInt(id));
    const visible = await this.prisma.production_order.findMany({
      where: { production_order_id: { in: ids }, ...(scope === null ? {} : { plant_id: { in: scope } }) },
      select: { production_order_id: true },
    });
    const found = new Set(visible.map((row) => row.production_order_id));
    const proposals = buildProposals(await readProposalFacts(this.prisma, [...found]), new Date());
    return {
      items: ids.filter((id) => found.has(id)).map((id) => proposalView(proposals.get(id) as Proposal)),
      notFoundProductionOrderIds: ids.filter((id) => !found.has(id)).map(Number),
    };
  }

  /**
   * ① 같은 키 재전송은 처음 응답을 재생한다(채번 «전») ② 잠그지 않고 한 번 판정해 거부될 요청이 번호를 쓰지 않게 한다
   * ③ 번호를 트랜잭션 밖에서 뽑는다 ④ 멱등 트랜잭션 안에서 ERP W/O 를 잠그고 다시 판정한 뒤 저장한다. 롤백되면 뽑은 번호는 결번이다.
   */
  async confirm(
    request: Request,
    productionOrderId: number,
    body: ProposalConfirmBody,
    appUserId: number | undefined,
    conflictCode: IdempotencyConflictCode,
  ): Promise<ProposalConfirmResult> {
    const context = idempotencyContextOf(request, HttpStatus.OK, conflictCode);
    const replay = await this.idempotency.replayExisting<ProposalConfirmResult>(context);
    if (replay !== undefined) return replay.body;

    const orderId = BigInt(productionOrderId);
    for (let attempt = 0; ; attempt += 1) {
      const precheck = await this.check(this.prisma, orderId, body);
      if (!precheck.already) {
        const { delta, field } = quantityDelta(precheck.resolved);
        await precheckWithinOrder(this.prisma, orderId, delta, field);
      }
      const numbers = precheck.already ? { planNos: [], workOrderNos: [] } : await this.drawNumbers(precheck.proposal, precheck.resolved);
      try {
        const outcome = await this.idempotency.run(context, (tx) => this.confirmLocked(tx, orderId, body, numbers, appUserId), TRANSACTION_OPTIONS);
        return outcome.body;
      } catch (error) {
        if (!isDuplicateNo(error)) throw error;
        if (attempt >= NUMBER_RETRY) {
          throw new ConflictException('user', '계획번호·MES W/O 번호를 매기지 못했습니다. 다시 시도해 주세요.', { code: 'DUPLICATE_KEY' });
        }
      }
    }
  }

  private async confirmLocked(
    tx: Prisma.TransactionClient,
    orderId: bigint,
    body: ProposalConfirmBody,
    numbers: Numbers,
    appUserId: number | undefined,
  ): Promise<ProposalConfirmResult> {
    // ⛔ 잠금 순서는 «계획 → ERP W/O» 다 — 수정·확정(`lockPlan` → `assertWithinOrder`)과 같아야 교착하지 않는다.
    // 작성중 계획을 id 순으로 먼저 잠그고 ERP W/O 를 잠근다. 그 사이 새로 생긴 계획은 basis.plans 가 409 로 잡는다.
    await tx.$queryRaw`SELECT 1 FROM planning.production_plan
      WHERE production_order_id = ${orderId} AND status_code <> 'CONFIRMED' ORDER BY production_plan_id FOR UPDATE`;
    await tx.$queryRaw`SELECT 1 FROM planning.production_order WHERE production_order_id = ${orderId} FOR UPDATE`;
    const checked = await this.check(tx, orderId, body);
    if (checked.already) return alreadyProcessed(tx, orderId);
    const needed = checked.resolved.reduce((sum, plan) => sum + plan.operationCount, 0);
    const newPlans = checked.resolved.filter((plan) => plan.proposal.saved === undefined).length;
    // 미리 판정과 잠근 판정 사이에 기준이 바뀌었으면 basis 가 이미 409 를 냈다 — 여기 오면 번호 수가 맞는다.
    if (numbers.workOrderNos.length !== needed || numbers.planNos.length !== newPlans) {
      throw new ConflictException('user', '확정하는 사이 계획이 바뀌었습니다. 다시 시도해 주세요.', { code: 'INVALID_STATE' });
    }

    // 모든 계획의 수정을 먼저 반영하고 합계를 한 번 본 뒤 확정한다 — 계획마다 저장·확정을 번갈아 하면 확정의 합계 검사가
    // 아직 고치지 않은 계획을 옛 수량으로 세어, 본문 순서에 따라 같은 요청이 400 이 된다.
    const planNos = [...numbers.planNos];
    const saved: { plan: ResolvedPlan; productionPlanId: bigint; version: number }[] = [];
    for (const plan of checked.resolved) saved.push({ plan, ...(await this.savePlan(tx, checked.proposal, plan, planNos, appUserId)) });
    await assertWithinOrder(tx, orderId, new Prisma.Decimal(0), quantityDelta(checked.resolved).field);

    const workOrderNos = [...numbers.workOrderNos];
    const plans: ProposalConfirmResult['plans'] = [];
    for (const { plan, productionPlanId, version } of saved) {
      const materials = await this.confirms.materials(tx, Number(productionPlanId));
      const confirmed = await this.confirms.confirmIn(tx, materials, version, workOrderNos.splice(0, plan.operationCount), appUserId, plan.supplements);
      plans.push({ proposalPlanKey: plan.body.proposalPlanKey, ...(await planResult(tx, productionPlanId, confirmed.versionNo)) });
    }
    return { productionOrderId: Number(orderId), outcome: 'CONFIRMED', plans };
  }

  /** 새 계획은 작성중으로 등록하고, 작성중 계획은 본문 값으로 고친다 — 다음 확정이 둘을 같은 길로 확정한다. */
  private async savePlan(
    tx: Prisma.TransactionClient,
    proposal: Proposal,
    plan: ResolvedPlan,
    planNos: string[],
    appUserId: number | undefined,
  ): Promise<{ productionPlanId: bigint; version: number }> {
    const values = {
      plan_date: new Date(`${plan.body.planDate}T00:00:00.000Z`),
      planned_qty: plan.body.plannedQty,
      bom_id: BigInt(plan.body.bomId),
      routing_id: BigInt(plan.body.routingId),
      planned_line_id: plan.body.plannedLineId === null ? null : BigInt(plan.body.plannedLineId),
      ...(plan.body.remarks === undefined ? {} : { remarks: plan.body.remarks }),
      updated_by: appUserId ?? null,
    };
    const saved = plan.proposal.saved;
    if (saved === undefined) {
      const created = await tx.production_plan.create({
        data: {
          ...values,
          production_order_id: proposal.order.production_order_id,
          plan_no: planNos.shift() as string,
          uom_id: proposal.order.uom_id,
          status_code: DRAFT,
          created_by: appUserId ?? null,
        },
        select: { production_plan_id: true, version_no: true },
      });
      return { productionPlanId: created.production_plan_id, version: created.version_no };
    }
    const updated = await tx.production_plan.updateMany({
      where: { production_plan_id: saved.production_plan_id, version_no: saved.version_no, status_code: DRAFT },
      data: { ...values, version_no: { increment: 1 } },
    });
    // basis.plans 가 판을 이미 견줬다 — 잠금 밖 경합의 마지막 그물이다.
    assertUpdated(updated.count, 'user', { code: 'VERSION_CONFLICT' });
    return { productionPlanId: saved.production_plan_id, version: saved.version_no + 1 };
  }

  /**
   * 취소 400 → 이미 처리됨 → basis 409 → 본문 검증 400 순. 같은 판정을 잠그지 않고(채번 전) 한 번, 잠근 트랜잭션에서 한 번 한다.
   */
  private async check(client: Prisma.TransactionClient, orderId: bigint, body: ProposalConfirmBody): Promise<Checked> {
    const facts = await readProposalFacts(client, [orderId]);
    const proposal = buildProposals(facts, new Date()).get(orderId);
    if (proposal === undefined) throw new NotFoundException('없는 ERP W/O 입니다.');
    if (proposal.order.status_code === CANCELLED) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '취소된 ERP W/O 는 계획하지 않습니다.' }]);
    }
    if (proposal.kind === 'KEEP_CONFIRMED') return { already: true };
    assertSameBasis(proposal, body.basis);
    return { already: false, proposal, resolved: await resolveConfirm(client, proposal, facts, body) };
  }

  private async drawNumbers(proposal: Proposal, resolved: readonly ResolvedPlan[]): Promise<Numbers> {
    const planNos: string[] = [];
    for (const plan of resolved) {
      if (plan.proposal.saved === undefined) planNos.push(await this.numbering.next(PRODUCTION_PLAN, proposal.order.plant_id, plan.body.planDate));
    }
    const count = resolved.reduce((sum, plan) => sum + plan.operationCount, 0);
    // W/O 번호의 공장 축은 `plan-confirm.service.ts` 와 같이 비운다 — 두 경로가 같은 카운터를 써야 번호가 겹치지 않는다.
    const workOrderNos = count === 0 ? [] : await this.numbering.nextMany(WORK_ORDER, null, new Date().toISOString().slice(0, 10), count);
    return { planNos, workOrderNos };
  }
}

/** 하나라도 다르면 저장하지 않는다 — 바뀐 기준과 지금 제안을 함께 낸다(화면이 다시 조회하지 않게). */
function assertSameBasis(proposal: Proposal, sent: ProposalBasis): void {
  const changed = (Object.keys(BASIS_LABEL) as (keyof ProposalBasis)[]).filter((key) => proposal.basis[key] !== sent[key]);
  if (changed.length === 0) return;
  throw new ConflictException('user', '검토한 뒤 계획 제안의 기준이 바뀌어 확정하지 않았습니다. 바뀐 제안을 검토한 뒤 다시 확정하세요.', {
    code: 'PROPOSAL_CHANGED',
    proposalChanges: changed.map((basis) => ({
      basis,
      message: basis === 'productionOrder' ? `${BASIS_LABEL[basis]} 지금 수량 ${proposal.order.order_qty.toString()}.` : BASIS_LABEL[basis],
    })),
    currentProposal: proposalView(proposal),
  });
}

/** 확정 계획량이 이미 오더 수량을 채웠다 — 지금의 확정 계획(W/O 가 모두 취소된 것 빼고)과 그 W/O 를 돌려준다. */
async function alreadyProcessed(tx: Prisma.TransactionClient, orderId: bigint): Promise<ProposalConfirmResult> {
  const plans = await tx.production_plan.findMany({
    where: { production_order_id: orderId, status_code: 'CONFIRMED' },
    orderBy: { production_plan_id: 'asc' },
    select: { production_plan_id: true, version_no: true, work_order: { select: { status_code: true } } },
  });
  const live = plans.filter((plan) => !isPlanCancelled(plan.work_order.map((workOrder) => workOrder.status_code)));
  return {
    productionOrderId: Number(orderId),
    outcome: 'ALREADY_PROCESSED',
    plans: await Promise.all(live.map((plan) => planResult(tx, plan.production_plan_id, plan.version_no))),
  };
}

async function planResult(tx: Prisma.TransactionClient, productionPlanId: bigint, versionNo: number) {
  const plan = await tx.production_plan.findUniqueOrThrow({
    where: { production_plan_id: productionPlanId },
    select: {
      plan_no: true,
      status_code: true,
      work_order: {
        orderBy: { routing_operation: { operation_seq: 'asc' } },
        select: { work_order_id: true, work_order_no: true, routing_operation_id: true },
      },
    },
  });
  return {
    productionPlanId: Number(productionPlanId),
    planNo: plan.plan_no,
    statusCode: plan.status_code,
    versionNo,
    workOrders: plan.work_order.map((workOrder) => ({
      workOrderId: Number(workOrder.work_order_id),
      workOrderNo: workOrder.work_order_no,
      routingOperationId: Number(workOrder.routing_operation_id),
    })),
  };
}

function isDuplicateNo(error: unknown): boolean {
  if (isDuplicateWorkOrderNo(error)) return true;
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const target = (error.meta ?? {}).target;
  return Array.isArray(target) && target.includes('plan_no');
}

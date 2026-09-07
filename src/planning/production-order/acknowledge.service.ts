import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field, one } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PrismaService } from '../../prisma/prisma.service';

/** 계약 `WorkOrderAdjustment` — required 둘. */
export interface WorkOrderAdjustment {
  workOrderId: number;
  versionNo: number;
  orderQty?: number;
  plannedStartAt?: string;
  plannedEndAt?: string;
}

/** 계약 `ProductionOrderAcknowledge` — required 하나(`decisionCode` enum 2값). */
export interface ProductionOrderAcknowledge {
  decisionCode: string;
  reason?: string;
  workOrderAdjustments?: WorkOrderAdjustment[];
}

const PROCEED = 'PROCEED';
/** 값 목록이 어디에도 없다(코드 그룹 0건) — 서버가 상수로 짓고 판정에 쓰지 않는다(§2-3). */
const ACK_TYPE = 'PO_CHANGE';
const ACK_STATUS = 'ACKNOWLEDGED';
/** 계약 `ProductionConflictResponse.code` enum 5값 중 하나. */
const VERSION_CONFLICT = 'VERSION_CONFLICT';

/** ⑤ 영향 W/O — 직접 칸이 없어 계획을 거쳐 모은다. `closed_at` 이 판정에 든다. */
export interface ImpactedWorkOrder {
  work_order_id: bigint;
  closed_at: Date | null;
}

/**
 * 본문 400 — **다섯 갈래**다. 넷은 계약 description(ⓐ 강행인데 조정을 실었다 ⓑ 이 P/O 의
 * 영향 W/O 가 아니다 ⓒ 같은 `workOrderId` 가 두 번 ⓓ 고칠 칸을 하나도 안 담았다)이고,
 * 다섯째는 컬럼 주석 `production.production_order_acknowledgement.reason` 이 준다 —
 * 「강행이면 필요하다 — 값에 따라 갈리는 규칙이라 CHECK 가 아니라 서버가 건다」.
 * 여섯째 자리(마감 W/O)는 400 이되 `STATE_LOCKED` 다 — 계약이 침묵하지만
 * `trg_work_order_closed_immutable` 이 그 UPDATE 를 예외로 던져 500 이 되기 때문이다.
 * 선례 `material-issue-request.service.ts:155` 「취소·마감된 작업지시입니다」.
 */
export function acknowledgeBodyErrors(
  body: ProductionOrderAcknowledge,
  impacted: readonly ImpactedWorkOrder[],
): ErrorItem[] {
  const errors: ErrorItem[] = [];
  const adjustments = body.workOrderAdjustments ?? [];
  if (body.decisionCode === PROCEED) {
    if (adjustments.length > 0) {
      errors.push(field('workOrderAdjustments', ERROR_CODE.INVALID, '강행은 작업지시 조정을 함께 보내지 않습니다.'));
    }
    if ((body.reason ?? '').trim() === '') {
      errors.push(field('reason', ERROR_CODE.REQUIRED, '강행이면 사유가 필요합니다.'));
    }
  }
  const closedOf = new Map(impacted.map((row) => [Number(row.work_order_id), row.closed_at !== null]));
  const seen = new Set<number>();
  for (const [index, adjustment] of adjustments.entries()) {
    const at = `workOrderAdjustments[${index}]`;
    const closed = closedOf.get(adjustment.workOrderId);
    if (closed === undefined) {
      errors.push(field(`${at}.workOrderId`, ERROR_CODE.INVALID, '이 생산오더의 영향 작업지시가 아닙니다.'));
    } else if (closed) {
      errors.push(field(`${at}.workOrderId`, ERROR_CODE.STATE_LOCKED, '마감된 작업지시입니다.'));
    }
    if (seen.has(adjustment.workOrderId)) {
      errors.push(field(`${at}.workOrderId`, ERROR_CODE.UNIQUE_VIOLATION, '같은 작업지시가 두 번 왔습니다.'));
    }
    seen.add(adjustment.workOrderId);
    if (adjustment.orderQty === undefined && adjustment.plannedStartAt === undefined && adjustment.plannedEndAt === undefined) {
      errors.push(field(at, ERROR_CODE.REQUIRED, 'orderQty·plannedStartAt·plannedEndAt 중 하나는 있어야 합니다.'));
    }
  }
  return errors;
}

/**
 * `POST …:acknowledge` — 관리자의 판정 한 번 + W/O 조정이 **한 트랜잭션**이다(§5-5).
 * ⛔ `production_order.status_code`·`version_no` 를 옮기지 않는다 — P/O 상태는 ERP 수신이
 *    옮기고 이 오퍼레이션은 판정만 적는다(`plan-api.md` 830행). If-Match 토큰이 그대로 산다.
 * ⛔ 취소 반영(W/O `:cancel`)은 이 본문에 없다 · P/O 가 `CANCELLED` 여도 400 을 안 낸다.
 */
@Injectable()
export class AcknowledgeService {
  constructor(private readonly prisma: PrismaService) {}

  async acknowledge(
    productionOrderId: number,
    version: number,
    body: ProductionOrderAcknowledge,
    appUserId: number,
  ): Promise<void> {
    await this.prisma.$transaction((tx) => this.commit(tx, productionOrderId, version, body, appUserId));
  }

  private async commit(
    tx: Prisma.TransactionClient,
    productionOrderId: number,
    version: number,
    body: ProductionOrderAcknowledge,
    appUserId: number,
  ): Promise<void> {
    const [locked] = await tx.$queryRaw<{ version_no: number; last_change_received_at: Date | null }[]>(Prisma.sql`
      SELECT version_no, last_change_received_at FROM planning.production_order
       WHERE production_order_id = ${BigInt(productionOrderId)} FOR UPDATE`);
    if (locked === undefined) throw new NotFoundException('없는 생산오더입니다.');
    // 원인이 `user` 가 아니라 `erpSync` 다 — 계약이 「409 가 나면 「ERP 가 다시 보냈다」」로 못 박았다.
    assertUpdated(locked.version_no === version ? 1 : 0, 'erpSync', {
      code: VERSION_CONFLICT,
      currentVersion: String(locked.version_no),
    });
    // 확인할 변경이 없다 — `received_at` NOT NULL 에 넣을 값이 없고 「오늘」로 잡는 것은 조용한 도출이다.
    const receivedAt = locked.last_change_received_at;
    if (receivedAt === null) throw one(field('productionOrderId', ERROR_CODE.STATE_LOCKED, '확인할 변경이 없습니다.'));

    const impacted = await tx.work_order.findMany({
      where: { production_plan: { production_order_id: BigInt(productionOrderId) } },
      select: { work_order_id: true, closed_at: true },
    });
    // 400 검사가 전부 트랜잭션 «안»이다 — 영향 W/O 판정이 DB 를 읽는다.
    const errors = acknowledgeBodyErrors(body, impacted);
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    const adjustments = body.workOrderAdjustments ?? [];
    for (const adjustment of adjustments) {
      const updated = await tx.work_order.updateMany({
        where: { work_order_id: BigInt(adjustment.workOrderId), version_no: adjustment.versionNo },
        data: {
          ...(adjustment.orderQty === undefined ? {} : { order_qty: adjustment.orderQty }),
          ...(adjustment.plannedStartAt === undefined ? {} : { planned_start_at: new Date(adjustment.plannedStartAt) }),
          ...(adjustment.plannedEndAt === undefined ? {} : { planned_end_at: new Date(adjustment.plannedEndAt) }),
          updated_by: BigInt(appUserId),
          version_no: { increment: 1 },
        },
      });
      // 토큰이 둘이라 원인이 갈린다 — 본문 `versionNo` 가 어긋난 것은 사용자 축이다.
      assertUpdated(updated.count, 'user', { code: VERSION_CONFLICT });
    }

    await this.markMismatch(tx, impacted, body.decisionCode, adjustments);
    await this.upsertAcknowledgement(tx, productionOrderId, receivedAt, body, appUserId);
  }

  /**
   * 계약 `WorkOrder.poMismatch` — 「서버가 두 자리에서 세운다 — ⓐ 관리자가 「기존 유지(강행)」를
   * 고를 때 ⓑ 「변경 반영」을 골랐는데 그 W/O 를 workOrderAdjustments 로 조정하지 않았을 때」.
   * ⛔ 마감 W/O 는 대상에서 뺀다 — `trg_work_order_closed_immutable`(baseline
   *    `migration.sql:3009-3011`)이 마감 행의 **모든** UPDATE 를 예외로 던져, 마감 W/O 가
   *    하나만 섞여도 요청 전체가 500 이 된다. 취소 W/O 는 그대로 둔다(트리거가 없다).
   */
  private async markMismatch(
    tx: Prisma.TransactionClient,
    impacted: readonly ImpactedWorkOrder[],
    decisionCode: string,
    adjustments: readonly WorkOrderAdjustment[],
  ): Promise<void> {
    const adjusted = new Set(adjustments.map((adjustment) => adjustment.workOrderId));
    const targets = impacted
      .filter((row) => row.closed_at === null && (decisionCode === PROCEED || !adjusted.has(Number(row.work_order_id))))
      .map((row) => row.work_order_id);
    if (targets.length === 0) return;
    await tx.work_order.updateMany({ where: { work_order_id: { in: targets } }, data: { po_mismatch: true } });
  }

  /**
   * 확인 행은 **upsert** 다 — 수신기가 없어 채울 행 자체가 없다(§2-3). 수신기가 서고 «같은»
   * `acknowledgement_type_code` 를 쓰기로 정해지면 그때 저절로 UPDATE 가 된다(R-9).
   * `upstream_version`·`integration_message_id`·`details` 는 수신기 몫이라 안 건드린다.
   */
  private async upsertAcknowledgement(
    tx: Prisma.TransactionClient,
    productionOrderId: number,
    receivedAt: Date,
    body: ProductionOrderAcknowledge,
    appUserId: number,
  ): Promise<void> {
    const key = { production_order_id: BigInt(productionOrderId), acknowledgement_type_code: ACK_TYPE, received_at: receivedAt };
    // `ck_production_order_ack_decision` 이 시각·사용자·판정 셋을 함께 요구한다.
    const decided = {
      status_code: ACK_STATUS,
      acknowledged_at: new Date(),
      acknowledged_by: BigInt(appUserId),
      acknowledge_decision_code: body.decisionCode,
      reason: body.reason ?? null,
    };
    await tx.production_order_acknowledgement.upsert({
      where: { production_order_id_acknowledgement_type_code_received_at: key },
      create: { ...key, ...decided },
      update: decided,
    });
  }
}

import { assertEquipmentOccupancy, lockEquipmentOccupancy } from './equipment-occupancy';
import { HttpStatus, Injectable } from '@nestjs/common';

import { DocumentStateService } from '../../core/document-state';
import { LotRegistryService, nextMesLotNos, PRODUCTION_LOT_TYPE, Tx, WIP_LOT_TYPE } from '../../core/lot';
import { MaterialIssueReleaser } from '../../core/material-issue/release-request';
import { NumberingService } from '../../core/numbering';
import { PickingHandoverNotifier, PickingPlan, planPicking, writePicking } from '../../core/picking';
import { isLastOperation } from '../../core/work-order';
import { PrismaService } from '../../prisma/prisma.service';
import { ISSUE_REGISTERED, MaterialIssueLine } from './material-issue';
import { PqcRequestPlan, preparePqcRequest, writePqcRequest } from './work-order-pqc-request';
import { MaterialUomConfirmation, saveEnteredConversions } from './release-materials';
import { ReleasePlan, operationSettings, releasePlan } from './release-plan';
import { WaitingResult, writeWaitingRequests } from './release-waiting';
import { WorkOrderHandoverNotifier } from './work-order-handover';
import { assertVersion, lockWorkOrder } from './work-order-write.service';

/** 계약 `WorkOrderRelease` — required 는 `lotSize` 하나이고 서버 기본값이 없다(R-17). */
export interface WorkOrderRelease {
  lotSize: number;
  /** ⚠ 받되 **저장하지 않는다** — 담을 칸이 없고 `remarks` 에 덧붙이지도 않는다(§4-5). */
  handoverNote?: string;
  /** BOM 단위와 재고 단위가 다른 자재마다 하나 — 단위가 같은 자재는 받지 않아도 된다. */
  materialUomConfirmations?: MaterialUomConfirmation[];
}

const STATUS_COLUMN = 'production.work_order.status_code';
const RELEASE_ACTION = 'work-order-release';

/** 출고요청 한 건과 그 피킹 배정 — 트랜잭션을 열기 전에 다 정한다. */
interface IssuePlan {
  issueRequestNo: string;
  lines: MaterialIssueLine[];
  picking: PickingPlan;
}

/**
 * 확정·배포 + 생산LOT 선발행 + 자재 출고요청 자동 발행 + 피킹 지시 생성(P-12) — 계약이
 * ⌜한 트랜잭션⌝ 이라 적었다. 순서는 §4-1 그대로다: 검증·읽기·채번은 트랜잭션 «밖»에서
 * 끝내고, 여기서는 상태·슬롯·요청·지시를 한 트랜잭션에 쓴다. 중간에 끊기면 전체를 되돌린다(B-8).
 */
@Injectable()
export class WorkOrderReleaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentState: DocumentStateService,
    private readonly numbering: NumberingService,
    private readonly lots: LotRegistryService,
    private readonly pickingNotices: PickingHandoverNotifier,
    private readonly workOrderNotices: WorkOrderHandoverNotifier,
  ) {
    this.issueReleaser = new MaterialIssueReleaser(documentState, pickingNotices);
  }

  /** 대기 요청 즉시 배포 — 00:00 러너와 같은 함수다. 쓰는 의존이 이 서비스의 것과 같아 여기서 짓는다. */
  private readonly issueReleaser: MaterialIssueReleaser;

  /**
   * 생산 창고 공장(피처 003)이면 만든 대기 요청과 미배정 자재를 돌려준다. 아니면 `null` — 지금 방식이다.
   * `appUserId` 가 `null` 이면 추적 시스템 연동의 자동 배포다 — 사람이 없어 기록자를 비운다(사용자 2026-11-16).
   * 단위 확인도 할 사람이 없어 품목·공통 환산을 그대로 쓴다. `correlationId` 는 배포 요청의 Idempotency-Key 다.
   */
  async release(
    workOrderId: number,
    version: number,
    body: WorkOrderRelease,
    appUserId: number | null,
    correlationId: string | null = null,
  ): Promise<WaitingResult | null> {
    const plan = await releasePlan(this.prisma, this.numbering, workOrderId, body.lotSize, {
      confirmations: body.materialUomConfirmations,
      automatic: appUserId === null,
    });
    const issue = plan.issueRequestNo === null ? null : await this.issuePlan(plan, plan.issueRequestNo);
    /* PQC 대상 품목이면 PQC 의뢰도 이 배포가 만든다 — 채번·기준 조회는 트랜잭션 밖이다. */
    const pqc = await preparePqcRequest(this.prisma, this.numbering, {
      itemId: plan.row.item_id,
      orderQty: plan.row.order_qty,
      businessDate: plan.businessDate,
    });
    return this.prisma.$transaction((tx) =>
      this.commit(tx, workOrderId, version, plan, issue, pqc, appUserId, correlationId),
    );
  }

  private async issuePlan(plan: ReleasePlan, issueRequestNo: string): Promise<IssuePlan> {
    const lines = plan.materials.lines;
    const picking = await planPicking(this.prisma, this.numbering, {
      plantId: plan.plan.production_order.plant_id,
      demands: lines.map((line) => ({
        lineNo: line.line_no,
        itemId: line.item_id,
        uomId: line.uom_id,
        qty: line.requested_qty,
      })),
      periodDate: plan.businessDate,
      assignedWorkerId: plan.row.responsible_worker_id,
    });
    return { issueRequestNo, lines, picking };
  }

  private async commit(
    tx: Tx,
    workOrderId: number,
    version: number,
    plan: ReleasePlan,
    issue: IssuePlan | null,
    pqc: PqcRequestPlan | null,
    appUserId: number | null,
    correlationId: string | null,
  ): Promise<WaitingResult | null> {
    await lockEquipmentOccupancy(tx);
    const locked = await lockWorkOrder(tx, workOrderId);
    // ⭐ 버전 대조가 전이 검사보다 «먼저»다(`document-cancel.service.ts` 선례).
    assertVersion(locked, version);
    // ⛔ 400 이다 — 409 는 If-Match 저장 충돌이 쓴다(§1-6).
    const transition = this.documentState.assertTransition(
      STATUS_COLUMN,
      RELEASE_ACTION,
      locked.status_code,
      HttpStatus.BAD_REQUEST,
    );

    await assertEquipmentOccupancy(tx, workOrderId, true);

    // 출고요청보다 먼저 — 같은 트랜잭션이라 배포가 실패하면 넣은 환산도 남지 않는다.
    await saveEnteredConversions(tx, plan.materials.entered, {
      workOrderId,
      plantToday: plan.plantToday,
      actorId: appUserId,
      correlationId,
    });

    await tx.work_order.update({
      where: { work_order_id: BigInt(workOrderId) },
      data: {
        status_code: transition.to,
        released_at: new Date(),
        version_no: { increment: 1 },
        updated_by: appUserId,
        operation_settings_snapshot: operationSettings(plan.row.routing_operation),
      },
    });

    const plantId = Number(plan.plan.production_order.plant_id);
    const lotNos = await nextMesLotNos(tx, plantId, plan.businessDate, plan.qtys.length);
    // 마지막이 아닌 공정의 산출은 반제품이다 — 다음 공정에 투입된다(피처 016 R-1). 이미 발행된 슬롯은 바꾸지 않는다.
    const last = await isLastOperation(tx, plan.row.routing_operation);
    await this.lots.preIssueWithin(
      tx,
      {
        workOrderId: BigInt(workOrderId),
        plantId,
        itemId: Number(plan.row.item_id),
        uomId: Number(plan.row.uom_id),
        bomId: Number(plan.plan.bom_id),
        bomVersion: plan.plan.bom.bom_version,
        lotTypeCode: last ? PRODUCTION_LOT_TYPE : WIP_LOT_TYPE,
        lotNos,
        qtys: plan.qtys,
      },
      appUserId,
    );

    if (pqc !== null) {
      await writePqcRequest(
        tx,
        { workOrderId, itemId: plan.row.item_id, uomId: plan.row.uom_id, plan: pqc },
        appUserId,
      );
    }

    if (issue !== null) {
      await this.issueRequest(tx, workOrderId, issue, appUserId);
    }
    const waiting =
      plan.waiting === null
        ? null
        : await writeWaitingRequests(
            tx,
            {
              workOrderId: BigInt(workOrderId),
              waiting: plan.waiting,
              lines: plan.materials.lines,
              appUserId,
            },
            this.issueReleaser,
          );
    // 자동 흐름의 W/O 는 사람이 인계받지 않는다 — 추적 시스템이 목록에서 가져간다(사용자 2026-11-16).
    if (!plan.plan.created_automatically) await this.workOrderNotices.released(tx, BigInt(workOrderId));
    return waiting;
  }

  private async issueRequest(
    tx: Tx,
    workOrderId: number,
    issue: IssuePlan,
    appUserId: number | null,
  ): Promise<void> {
    const header = await tx.material_issue_request.create({
      data: {
        issue_request_no: issue.issueRequestNo,
        work_order_id: BigInt(workOrderId),
        destination_location_id: null,
        status_code: ISSUE_REGISTERED,
        requested_by: appUserId,
        created_by: appUserId,
        // `required_at`·`reason_code` 는 비운다 — 받는 칸이 없고, 사유 4값에 「BOM 자동
        // 발행」이 없어 값을 지어내지 않는다(둘 다 nullable).
      },
      select: { material_issue_request_id: true },
    });
    await tx.material_issue_request_line.createMany({
      data: issue.lines.map((line) => ({
        ...line,
        material_issue_request_id: header.material_issue_request_id,
      })),
    });
    // 방금 만든 라인의 id 를 되읽어 피킹에 물린다 — `createMany` 는 id 를 안 돌려준다(P-16).
    const requestLines = await tx.material_issue_request_line.findMany({
      where: { material_issue_request_id: header.material_issue_request_id },
      select: { material_issue_request_line_id: true, line_no: true },
    });
    const pickings = await writePicking(
      tx,
      issue.picking,
      {
        materialIssueRequestId: header.material_issue_request_id,
        issueRequestNo: issue.issueRequestNo,
        requestLineIds: new Map(
          requestLines.map((line) => [line.line_no, line.material_issue_request_line_id]),
        ),
      },
      appUserId,
    );
    await this.pickingNotices.notify(tx, pickings, { workOrderId: BigInt(workOrderId), requiredAt: null });
  }
}

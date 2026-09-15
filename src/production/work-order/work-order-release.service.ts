import { HttpStatus, Injectable } from '@nestjs/common';

import { DocumentStateService } from '../../core/document-state';
import { LotRegistryService, nextMesLotNos, Tx } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PickingPlan, planPicking, writePicking } from '../../core/picking';
import { PrismaService } from '../../prisma/prisma.service';
import { ISSUE_REGISTERED, MaterialIssueLine, materialRequirements } from './material-issue';
import { ReleasePlan, operationSettings, releasePlan } from './release-plan';
import { assertVersion, lockWorkOrder } from './work-order-write.service';

/** 계약 `WorkOrderRelease` — required 는 `lotSize` 하나이고 서버 기본값이 없다(R-17). */
export interface WorkOrderRelease {
  lotSize: number;
  /** ⚠ 받되 **저장하지 않는다** — 담을 칸이 없고 `remarks` 에 덧붙이지도 않는다(§4-5). */
  handoverNote?: string;
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
  ) {}

  async release(
    workOrderId: number,
    version: number,
    body: WorkOrderRelease,
    appUserId: number,
  ): Promise<void> {
    const plan = await releasePlan(this.prisma, this.numbering, workOrderId, body.lotSize);
    const issue = plan.issueRequestNo === null ? null : await this.issuePlan(plan, plan.issueRequestNo);
    await this.prisma.$transaction((tx) => this.commit(tx, workOrderId, version, plan, issue, appUserId));
  }

  private async issuePlan(plan: ReleasePlan, issueRequestNo: string): Promise<IssuePlan> {
    const lines = materialRequirements(plan.components, plan.row.order_qty, plan.plan.bom.base_qty);
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
    appUserId: number,
  ): Promise<void> {
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
    await this.lots.preIssueWithin(
      tx,
      {
        workOrderId: BigInt(workOrderId),
        plantId,
        itemId: Number(plan.row.item_id),
        uomId: Number(plan.row.uom_id),
        bomId: Number(plan.plan.bom_id),
        bomVersion: plan.plan.bom.bom_version,
        lotNos,
        qtys: plan.qtys,
      },
      appUserId,
    );

    const destination = plan.row.default_wip_location_id;
    if (issue !== null && destination !== null) {
      await this.issueRequest(tx, workOrderId, issue, destination, appUserId);
    }
  }

  private async issueRequest(
    tx: Tx,
    workOrderId: number,
    issue: IssuePlan,
    destinationLocationId: bigint,
    appUserId: number,
  ): Promise<void> {
    const header = await tx.material_issue_request.create({
      data: {
        issue_request_no: issue.issueRequestNo,
        work_order_id: BigInt(workOrderId),
        destination_location_id: destinationLocationId,
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
    await writePicking(
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
  }
}

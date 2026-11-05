import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { DocumentStateService } from '../document-state';
import { PickingHandoverNotifier, allocateStock, writePicking } from '../picking';
import { recordRequestAudit } from './request-lifecycle';

const STATUS_COLUMN = 'logistics.material_issue_request.status_code';
const RELEASE_ACTION = 'material-issue-request-release';
const WAITING = 'WAITING';

/**
 * 대기 요청 배포(피처 003 · research R-8) — W/O 배포의 즉시 배포와 00:00 러너가 같은 함수를 탄다.
 * 요청을 잠그고, 대기가 아니면 아무것도 하지 않는다(「한 번만」은 이 가드가 지킨다). 출발 창고에서만 배정해
 * 피킹 지시를 쓰고 T2 를 알린 뒤 배포 상태로 옮긴다. 재고가 모자라면 집을 수 있는 만큼만 지시에 담는다.
 *
 * ⛔ 채번은 하지 않는다 — 트랜잭션 안에서 부르면 한 요청이 커넥션을 둘 쥔다. 출발 창고가 하나라 지시는 많아야
 *    한 장이고, 그 번호를 호출자가 밖에서 받아 넘긴다. 못 쓴 번호는 결번이다.
 * ⛔ 실패 기록(`release_error_text`)은 호출자가 별도 트랜잭션으로 한다 — 이 트랜잭션은 되돌려지므로.
 */
@Injectable()
export class MaterialIssueReleaser {
  constructor(
    private readonly documentState: DocumentStateService,
    private readonly pickingNotices: PickingHandoverNotifier,
  ) {}

  /**
   * 배포했으면 참, 대기가 아니어서 건너뛰었으면 거짓. `appUserId` 는 00:00 러너면 `null`(사람이 없다).
   * `zaloNotBefore` 는 러너가 현장 새벽에 배포할 때만 준다 — T2 의 Zalo 를 07:00 에 보낸다(FR-021a).
   */
  async release(
    tx: Prisma.TransactionClient,
    requestId: bigint,
    pickingOrderNo: string,
    appUserId: number | null,
    options: { zaloNotBefore?: Date; now?: Date } = {},
  ): Promise<boolean> {
    const [locked] = await tx.$queryRaw<{ status_code: string }[]>`
      SELECT status_code FROM logistics.material_issue_request
       WHERE material_issue_request_id = ${requestId} FOR UPDATE`;
    if (locked?.status_code !== WAITING) return false;
    const transition = this.documentState.assertTransition(
      STATUS_COLUMN,
      RELEASE_ACTION,
      locked.status_code,
      HttpStatus.CONFLICT,
    );

    const request = await tx.material_issue_request.findUniqueOrThrow({
      where: { material_issue_request_id: requestId },
      select: {
        issue_request_no: true,
        work_order_id: true,
        source_warehouse: { select: { warehouse_id: true, plant_id: true, is_active: true } },
        work_order: { select: { responsible_worker_id: true } },
        material_issue_request_line: {
          select: { material_issue_request_line_id: true, line_no: true, item_id: true, uom_id: true, requested_qty: true },
          orderBy: { line_no: 'asc' },
        },
      },
    });
    const source = request.source_warehouse;
    if (source === null) throw new Error(`출발 창고가 없는 요청은 대기가 될 수 없다: ${requestId}`);
    // 재고 부족은 집을 수 있는 만큼만 담고 배포한다(US3-4). 창고를 쓰지 않게 된 것은 다르다 — 배포 실패로 남긴다(FR-022).
    if (!source.is_active) throw new Error('출발 창고가 사용 중지되어 배포할 수 없습니다.');

    const lines = request.material_issue_request_line;
    const allocation = await allocateStock(tx, {
      plantId: source.plant_id,
      warehouseId: source.warehouse_id,
      demands: lines
        .filter((line) => line.requested_qty.gt(0))
        .map((line) => ({ lineNo: line.line_no, itemId: line.item_id, uomId: line.uom_id, qty: line.requested_qty })),
    });
    const pickings = await writePicking(
      tx,
      {
        ...allocation,
        orderNos: allocation.orders.length === 0 ? [] : [pickingOrderNo],
        // 창고 보충 요청은 W/O 책임 작업자가 없다 — 담당 없이 낸다.
        assignedWorkerId: request.work_order?.responsible_worker_id ?? null,
      },
      {
        materialIssueRequestId: requestId,
        issueRequestNo: request.issue_request_no,
        requestLineIds: new Map(lines.map((line) => [line.line_no, line.material_issue_request_line_id])),
      },
      appUserId,
    );
    await this.pickingNotices.notify(tx, pickings, {
      workOrderId: request.work_order_id,
      issueRequest: { id: requestId, no: request.issue_request_no },
      requiredAt: null,
      ...(options.zaloNotBefore === undefined ? {} : { zaloNotBefore: options.zaloNotBefore }),
    });

    // 러너는 회차 시각을 넘긴다 — 실패 기록(release_attempted_at)과 같은 시계다.
    const now = options.now ?? new Date();
    await tx.material_issue_request.update({
      where: { material_issue_request_id: requestId },
      data: {
        status_code: transition.to,
        released_at: now,
        release_attempted_at: now,
        release_error_text: null,
        updated_at: now,
        updated_by: appUserId,
        version_no: { increment: 1 },
      },
    });
    await recordRequestAudit(tx, { requestId, action: 'RELEASED', actorId: appUserId, at: now });
    return true;
  }
}

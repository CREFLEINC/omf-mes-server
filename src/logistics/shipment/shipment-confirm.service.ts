import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { DocumentStateService } from '../../core/document-state';
import { IF_SHIPMENT_PGI, OutboxService, outboxMessageKey } from '../../core/outbox';
import { PrismaService } from '../../prisma/prisma.service';
import { ShipmentQueryService } from './shipment-query.service';
import { ShipmentDetailView } from './shipment-view';

/**
 * 출하 확정(`POST /logistics/shipments/{shipmentId}:confirm`) — 미확정 → 확정 + **ERP 송신 적재**.
 * 계약 「⭐ 이 시점에 ERP 송신 적재가 걸린다 — 재고는 앞 단계(출하 처리)에서 이미 차감됐다」.
 * ⛔ 재고를 다시 차감하지 않는다 — 원장을 0줄 지난다.
 * ⛔ 확정 취소 경로가 없다 — 계약 「되돌릴 수 없다」. 그래서 아웃박스 키가 2세그먼트다.
 */

type Tx = Prisma.TransactionClient;

const STATUS_COLUMN = 'logistics.shipment.status_code';
const CONFIRM_ACTION = 'shipment-confirm';
const CANCELLED = 'CANCELLED';
const CONFIRMED = 'CONFIRMED';
/** ⛔ 유형 접두가 필수다 — 없으면 다른 축의 결재가 취소 품의를 대신한다(I-5.md §6-2 · 같은 규약). */
const CANCEL_APPROVAL_TYPE = 'SHIPMENT_CANCEL';
const SHIPMENT_TARGET = 'SHIPMENT';
const PENDING = 'PENDING';
const INVALID_STATE = 'INVALID_STATE';
const ALREADY_CONFIRMED = 'ALREADY_CONFIRMED';
const CANCEL_IN_PROGRESS = 'CANCEL_IN_PROGRESS';
const VERSION_CONFLICT = 'VERSION_CONFLICT';

interface LockedShipment {
  shipment_id: bigint;
  shipment_no: string;
  shipment_request_id: bigint;
  warehouse_id: bigint;
  shipped_at: Date | null;
  status_code: string;
  version_no: number;
}

@Injectable()
export class ShipmentConfirmService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentState: DocumentStateService,
    private readonly outbox: OutboxService,
    private readonly queries: ShipmentQueryService,
  ) {}

  async confirm(
    shipmentId: number,
    version: number,
    appUserId: number,
  ): Promise<{ versionNo: number; shipment: ShipmentDetailView }> {
    await this.prisma.$transaction((tx) => this.commit(tx, shipmentId, version, appUserId));
    const { view, versionNo } = await this.queries.get(shipmentId);
    return { versionNo, shipment: view };
  }

  private async commit(tx: Tx, shipmentId: number, version: number, appUserId: number): Promise<void> {
    const locked = await lockShipment(tx, shipmentId);
    if (locked === undefined) throw new NotFoundException('없는 출하입니다.');

    // ⭐⭐ **409 의 순위를 코드로 못 박는다**(계획서 §4-6) — 순서가 없으면 리뷰가 뒤집을 수 있다.
    //    상태 둘이 판 번호보다 «앞»이다: 이미 확정·취소된 출하에 낡은 If-Match 가 오면 화면이 띄울
    //    문구는 「다른 사람이 먼저 저장했다」가 아니라 「이미 확정됐다」다.
    if (locked.status_code === CANCELLED) {
      throw new ConflictException('user', '취소된 출하는 확정할 수 없습니다.', { code: INVALID_STATE });
    }
    if (locked.status_code === CONFIRMED) {
      throw new ConflictException('user', '이미 확정된 출하입니다.', { code: ALREADY_CONFIRMED });
    }
    // ⭐ J-7 — 시드 SHIPMENT_STATUS 3값에 CANCEL_REQUESTED 가 «없어» 상태로는 못 가린다. 열린 결재가 유일한 원천이다.
    const openCancel = await tx.approval_request.findFirst({
      where: {
        target_type_code: SHIPMENT_TARGET,
        target_id: locked.shipment_id,
        approval_type_code: CANCEL_APPROVAL_TYPE,
        status_code: PENDING,
      },
      select: { approval_request_id: true },
    });
    if (openCancel !== null) {
      throw new ConflictException('user', '취소 결재가 진행 중이라 확정할 수 없습니다.', { code: CANCEL_IN_PROGRESS });
    }
    // 판 번호 — 행을 잠근 뒤 «한 번» 본다. ⛔ 잠금 아래에서 조건부 UPDATE 로 한 번 더 보지 않는다 —
    //   그 두 번째 검사는 도달할 수 없어 반증 불가한 단언이 된다(이 이슈의 되풀이 병).
    assertUpdated(locked.version_no === version ? 1 : 0, 'user', {
      code: VERSION_CONFLICT,
      currentVersion: String(locked.version_no),
    });

    const transition = this.documentState.assertTransition(STATUS_COLUMN, CONFIRM_ACTION, locked.status_code);
    await tx.shipment.update({
      where: { shipment_id: locked.shipment_id },
      data: {
        status_code: transition.to,
        confirmed_at: new Date(),
        confirmed_by: BigInt(appUserId),
        updated_by: BigInt(appUserId),
        version_no: { increment: 1 },
      },
    });

    // ⭐ 적재는 본 트랜잭션의 «꼬리»다(I-6 과 같다) — 단독 트랜잭션이면 「확정됐는데 적재가 안 된」 창이 열린다.
    const queued = await this.outbox.enqueue(tx, {
      interfaceCode: IF_SHIPMENT_PGI,
      messageKey: outboxMessageKey(IF_SHIPMENT_PGI, locked.shipment_no),
      targetTypeCode: SHIPMENT_TARGET,
      targetId: locked.shipment_id,
      payload: await pgiPayload(tx, locked),
    });
    // ⛔ 흡수가 오면 «조용히 지나지 않는다» — 이미 확정된 출하는 위 상태 검사가 막았고 `shipment_no`
    //    는 유일하다. 그런데도 적재가 있으면 상태 잠금이 뚫린 것이다(`issue-posting.ts` 의 alreadyPosted 와 같은 처리).
    if (queued.alreadyQueued) {
      throw new Error(`출하 확정 적재가 이미 있다 — 상태 잠금을 지나쳤다: ${locked.shipment_no}`);
    }
  }
}

/** ⛔ 두 확정이 경합하면 둘째가 첫째의 커밋을 기다렸다가 CONFIRMED 를 본다 — 그래서 잠근다. */
async function lockShipment(tx: Tx, shipmentId: number): Promise<LockedShipment | undefined> {
  const rows = await tx.$queryRaw<LockedShipment[]>`
    SELECT shipment_id, shipment_no, shipment_request_id, warehouse_id, shipped_at, status_code, version_no
      FROM logistics.shipment
     WHERE shipment_id = ${BigInt(shipmentId)}
       FOR UPDATE`;
  return rows[0];
}

/**
 * ⭐ **평탄 객체**다(계획서 §4-2) — I-6 의 `{header, sendItems}` 포장은 W/O 마감 전용 모양(`erpSendItems`
 * 축)이다. ⛔ 서버가 값을 해석하지 않는다 — 수신 쪽 인터페이스 정의가 0행이라 모양은 이 한 곳이 정한다.
 */
async function pgiPayload(tx: Tx, shipment: LockedShipment): Promise<Prisma.InputJsonValue> {
  const lines = await tx.shipment_line.findMany({
    where: { shipment_id: shipment.shipment_id },
    orderBy: { line_no: 'asc' },
    include: { shipment_lot_allocation: { orderBy: { shipment_lot_allocation_id: 'asc' } } },
  });
  return {
    shipmentNo: shipment.shipment_no,
    shipmentRequestId: Number(shipment.shipment_request_id),
    warehouseId: Number(shipment.warehouse_id),
    shippedAt: shipment.shipped_at === null ? null : shipment.shipped_at.toISOString(),
    lines: lines.map((line) => ({
      itemId: Number(line.item_id),
      shippedQty: Number(line.shipped_qty),
      uomId: Number(line.uom_id),
      allocations: line.shipment_lot_allocation.map((allocation) => ({
        lotId: Number(allocation.lot_id),
        allocatedQty: Number(allocation.allocated_qty),
      })),
    })),
  };
}

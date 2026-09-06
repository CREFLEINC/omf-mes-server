import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { assertCodeValues } from '../../common/master';
import { DocumentStateService } from '../../core/document-state';
import { InventoryPostingService } from '../../core/inventory-posting';
// ⛔ `index.ts` 가 재수출하지 않는다 — 코어를 한 줄도 안 고친다(피킹 선례).
import { lockBalancesInOrder } from '../../core/inventory-posting/balance-lock';
import { PrismaService } from '../../prisma/prisma.service';
import { PutawayOrigin, postPutaway } from './putaway-posting';
import { PutawayTaskView, TASK_INCLUDE, taskView } from './putaway-task-view';

type Tx = Prisma.TransactionClient;

const STATE_COLUMN = 'logistics.putaway_task.status_code';
const TEMPORARY_REASON_GROUP = 'PUTAWAY_TASK_TEMPORARY_REASON';
/** 시드 `LOGISTICS_DOCUMENT_STATUS` 값 그대로다 — 상수를 새로 짓지 않는다. */
const BLOCKED_RECEIPT = ['CANCEL_REQUESTED', 'CANCELLED'];

/** 계약 `PutawayTaskComplete` + `…CompleteTemporary` — required 3 은 같고 뒤 셋이 갈린다. */
export interface PutawayTaskComplete {
  actualLocationId: number; confirmedNoRule?: boolean;
  reasonCode?: string | null; remarks?: string | null;
  businessDate: string; occurredAt: string;
}

export interface PutawayCompleteContext {
  workerNo?: string;
  /** **선택**이다 — 없으면 대조하지 않는다(계약 `IfMatchVersionOptional` · C-9). */
  version?: number;
  appUserId: number;
}

export type PutawayMode = 'NORMAL' | 'TEMPORARY';

/** 지시 한 행 + 입고 셋(공장·목적 창고·취소 여부) + 입고가 남긴 원장 라인의 도착 끝점. */
interface LockedTask {
  putaway_task_id: bigint; putaway_task_no: string; item_id: bigint; lot_id: bigint;
  task_qty: Prisma.Decimal; uom_id: bigint; from_location_id: bigint;
  recommended_location_id: bigint | null; status_code: string; version_no: number;
  plant_id: bigint; warehouse_id: bigint; receipt_status_code: string;
  to_warehouse_id: bigint | null; to_location_id: bigint | null;
  to_quality_status_code: string | null; to_inventory_status_code: string | null;
  ownership_type_code: string | null; owner_partner_id: bigint | null; handling_unit_id: bigint | null;
}

/**
 * 적치 완료(`:complete`)와 임시 위치 적재(`:complete-temporary`) — **한 함수의 모드 분기**다.
 * 열한 단계 중 아홉이 글자 그대로 같아, 쪼개면 원장 쌓기·끝점 복제·전이·UPDATE 가 두 벌이
 * 되고 한쪽만 고치는 사고가 그 자리에서 난다. 갈리는 곳은 셋 — 사유 · 전이 액션 · 권장 판정.
 */
@Injectable()
export class PutawayCompleteService {
  constructor(
    private readonly prisma: PrismaService, private readonly posting: InventoryPostingService,
    private readonly documentState: DocumentStateService,
  ) {}

  async complete(
    putawayTaskId: number, body: PutawayTaskComplete, context: PutawayCompleteContext, mode: PutawayMode,
  ): Promise<PutawayTaskView> {
    await assertWorkerNo(this.prisma, context.workerNo);
    if (mode === 'TEMPORARY') {
      // 코드값 대조는 트랜잭션 «밖»이다 — 잠글 필요가 없는 마스터 조회다(LOT 완료 선례).
      const value = body.reasonCode;
      await assertCodeValues(this.prisma, [{ field: 'reasonCode', value, groupCode: TEMPORARY_REASON_GROUP }]);
      assertReason(body);
    }
    return this.prisma.$transaction((tx) => this.commit(tx, putawayTaskId, body, context, mode));
  }

  private async commit(
    tx: Tx, putawayTaskId: number, body: PutawayTaskComplete, context: PutawayCompleteContext,
    mode: PutawayMode,
  ): Promise<PutawayTaskView> {
    const task = await lockTask(tx, putawayTaskId);
    // ⭐ 상태를 If-Match «앞»에 본다 — 재로드로 안 풀리는 사실을 먼저 알린다(LOT 완료 선례).
    const action = mode === 'TEMPORARY' ? 'putaway-complete-temporary' : 'putaway-complete';
    const transition = this.documentState.assertTransition(
      STATE_COLUMN, action, task.status_code, HttpStatus.BAD_REQUEST,
    );
    if (context.version !== undefined && task.version_no !== context.version) {
      throw new ConflictException('user', '다른 사용자가 먼저 저장했습니다. 다시 불러온 뒤 저장하세요.');
    }
    // 잔액으로만 거르면 «같은 LOT 의 재입고»가 잔액을 채워 남의 물건을 조용히 옮긴다.
    if (BLOCKED_RECEIPT.includes(task.receipt_status_code)) {
      throw one(field('putawayTaskId', ERROR_CODE.STATE_LOCKED, '취소된 입고의 적치 지시입니다.'));
    }
    await assertLocation(tx, body.actualLocationId, task.warehouse_id);
    if (mode === 'NORMAL') assertRecommended(task, body);
    const origin = originOf(task);
    await assertBalance(tx, task, origin, body.actualLocationId);
    const lineId = await postPutaway(tx, this.posting, {
      businessDate: body.businessDate, occurredAt: new Date(body.occurredAt),
      plantId: Number(task.plant_id), putawayTaskId, putawayTaskNo: task.putaway_task_no,
      itemId: Number(task.item_id), lotId: Number(task.lot_id),
      qty: task.task_qty, uomId: Number(task.uom_id), origin,
      toWarehouseId: Number(task.warehouse_id), toLocationId: body.actualLocationId,
      createdBy: context.appUserId,
    });
    const row = await tx.putaway_task.update({
      where: { putaway_task_id: task.putaway_task_id },
      data: {
        actual_location_id: BigInt(body.actualLocationId), status_code: transition.to,
        // ⛔ 서버 시각이 아니다 — 오프라인 큐가 몇 시간 뒤에 닿는다(C-1 · LOT 완료 선례).
        completed_at: new Date(body.occurredAt), inventory_transaction_line_id: lineId,
        ...(mode === 'TEMPORARY'
          ? { reason_code: body.reasonCode ?? null, remarks: body.remarks ?? null }
          : {}),
        updated_by: BigInt(context.appUserId), version_no: { increment: 1 },
      },
      include: TASK_INCLUDE,
    });
    // ⛔ `setEtag` 를 부르지 않는다 — 계약이 두 200 에 응답 헤더를 선언하지 않았다.
    return taskView(row);
  }
}

/** ⛔ `FOR UPDATE OF t` — 지시 «만» 잠근다(`lockLot` 선례). 판정에 드는 나머지는 조인해 온다. */
async function lockTask(tx: Tx, putawayTaskId: number): Promise<LockedTask> {
  const rows = await tx.$queryRaw<LockedTask[]>`
    SELECT t.putaway_task_id, t.putaway_task_no, t.item_id, t.lot_id, t.task_qty, t.uom_id,
           t.from_location_id, t.recommended_location_id, t.status_code, t.version_no,
           r.plant_id, r.warehouse_id, r.status_code AS receipt_status_code,
           il.to_warehouse_id, il.to_location_id, il.to_quality_status_code,
           il.to_inventory_status_code, il.ownership_type_code, il.owner_partner_id,
           il.handling_unit_id
      FROM logistics.putaway_task t
      JOIN logistics.goods_receipt_line l ON l.goods_receipt_line_id = t.goods_receipt_line_id
      JOIN logistics.goods_receipt r ON r.goods_receipt_id = l.goods_receipt_id
      LEFT JOIN inventory.inventory_transaction_line il
             ON il.inventory_transaction_line_id = l.inventory_transaction_line_id
     WHERE t.putaway_task_id = ${BigInt(putawayTaskId)}
       FOR UPDATE OF t`;
  // 계약이 404 를 선언하지 않았으나 «경로 자원 자신»이라 상세 GET 과 같아야 한다.
  if (rows.length === 0) throw new NotFoundException('없는 적치 지시입니다.');
  return rows[0];
}

/**
 * 위치 그물 셋 — 존재 · 활성 · **목적 창고 안**(임시 적재도 같다).
 * ⛔ `location_type_code` 는 안 본다 — 고객이 늘리는 값이라 `TEMP` 로 가르면 판정이 무너진다.
 */
async function assertLocation(tx: Tx, actualLocationId: number, warehouseId: bigint): Promise<void> {
  const location = await tx.location.findUnique({
    where: { location_id: BigInt(actualLocationId) },
    select: { warehouse_id: true, is_active: true },
  });
  if (location === null || !location.is_active || location.warehouse_id !== warehouseId) {
    throw one(field('actualLocationId', ERROR_CODE.INVALID, '이 창고의 사용 가능한 위치가 아닙니다.'));
  }
}

/**
 * 권장 2×2 — ⓐ 권장=실제 통과 · ⓑ 권장≠실제 400 · ⓒ 권장 없음+플래그 참 통과 · ⓓ 그 밖 400.
 * ⛔ **권장이 있으면 `confirmedNoRule` 을 읽지 않는다** — 위치가 맞는 적치를 여분 플래그
 * 하나로 막으면 현장이 선다. ⛔ 권장을 다시 계산하지 않는다(입고가 낸 값을 읽기만 한다).
 */
function assertRecommended(task: LockedTask, body: PutawayTaskComplete): void {
  const recommended = task.recommended_location_id;
  if (recommended !== null) {
    if (recommended === BigInt(body.actualLocationId)) return;
    throw one(field('actualLocationId', ERROR_CODE.INVALID, `권장 위치 ${recommended} 이 아닙니다.`));
  }
  if (body.confirmedNoRule !== true) {
    throw one(field('confirmedNoRule', ERROR_CODE.REQUIRED, '권장 위치가 없는 품목은 확인이 필요합니다.'));
  }
}

/**
 * 출발 끝점은 **입고 원장 라인의 복제**다. ⛔ 비었거나 출발 위치가 어긋나면 400 이 아니라
 * **던진다** — 도달 불가한 우리 결함이고, 400 을 주면 화면이 무한 재시도를 돈다.
 */
function originOf(task: LockedTask): PutawayOrigin {
  const { to_warehouse_id: wh, to_location_id: loc, to_quality_status_code: quality } = task;
  const inventory = task.to_inventory_status_code;
  const ownership = task.ownership_type_code;
  if (wh === null || loc === null || quality === null || inventory === null || ownership === null) {
    throw new Error(`입고 원장 라인의 도착 끝점이 비었다: ${task.putaway_task_no}`);
  }
  if (loc !== task.from_location_id) {
    throw new Error(`적치 출발 위치가 입고 도착과 다르다: ${task.putaway_task_no}`);
  }
  return {
    warehouseId: Number(wh), locationId: Number(loc), qualityStatusCode: quality,
    inventoryStatusCode: inventory, ownershipTypeCode: ownership,
    ownerPartnerId: id(task.owner_partner_id), handlingUnitId: id(task.handling_unit_id),
  };
}

const id = (value: bigint | null): number | null => (value === null ? null : Number(value));

/**
 * ⭐ 하한 판정은 **호출 도메인 몫**이다 — 코어 `post()` 는 잠글 뿐 판정하지 않고 트리거에
 * 맡기면 500 이 샌다(출고·피킹 처방). ⛔ `on_hand_qty` 만 보지 않는다 — 트리거 첫 갈래가
 * 「on_hand < reserved+picked+blocked」도 막는다. 출발·도착을 **한 문장에** 잠근다(교착 방지).
 */
async function assertBalance(
  tx: Tx, task: LockedTask, origin: PutawayOrigin, actualLocationId: number,
): Promise<void> {
  const warehouse = await tx.warehouse.findUniqueOrThrow({
    where: { warehouse_id: BigInt(origin.warehouseId) },
    select: { business_unit_id: true, plant_id: true, plant: { select: { legal_entity_id: true } } },
  });
  const axis = {
    legalEntityId: warehouse.plant.legal_entity_id, businessUnitId: warehouse.business_unit_id,
    plantId: warehouse.plant_id, warehouseId: BigInt(origin.warehouseId), itemId: task.item_id,
    lotKey: task.lot_id,
  };
  const rows = await lockBalancesInOrder(tx, [
    { ...axis, locationId: BigInt(origin.locationId) },
    { ...axis, locationId: BigInt(actualLocationId) },
  ]);
  // 유일 인덱스 11칸 중 나머지 넷으로 좁힌다 — 같은 위치에 품질·소유가 다른 행이 설 수 있다.
  const from = rows.find(
    (row) =>
      row.locationId === BigInt(origin.locationId) &&
      row.quality_status_code === origin.qualityStatusCode &&
      row.inventory_status_code === origin.inventoryStatusCode &&
      row.ownership_type_code === origin.ownershipTypeCode &&
      id(row.owner_partner_id) === origin.ownerPartnerId,
  );
  // 본문 칸이 아니라 화면 전체의 사실이다(scope 'screen') — 출고의 두 문형을 그대로 쓴다.
  const short = (message: string): ContractException =>
    new ContractException(HttpStatus.BAD_REQUEST, [
      { scope: 'screen', code: ERROR_CODE.NEGATIVE_BALANCE, message },
    ]);
  if (from === undefined) throw short('이 위치에 그 LOT 의 재고가 없습니다.');
  if ((from.available_qty ?? new Prisma.Decimal(0)).lessThan(task.task_qty)) {
    throw short('보유 수량보다 많이 옮길 수 없습니다.');
  }
}

/**
 * ⚠ 사번을 **읽고 버린다** — 지시에 행위자 칸이 없다(`assigned_worker_id` 는 «배정» 축).
 * 계약이 required 로 못박았고 헤더는 계약 검증 가드가 안 본다. 없는 사번은 가른다.
 */
async function assertWorkerNo(prisma: PrismaService, workerNo: string | undefined): Promise<void> {
  if (workerNo === undefined || workerNo.trim() === '') {
    throw one(field('X-Worker-No', ERROR_CODE.REQUIRED, '작업자 사번 헤더가 필요합니다.'));
  }
  if ((await prisma.worker.count({ where: { worker_no: workerNo } })) === 0) {
    throw one(field('X-Worker-No', ERROR_CODE.INVALID, '없는 작업자 사번입니다.'));
  }
}

/** 계약 「사유 코드와 비고 중 적어도 하나는 있어야 한다」 — 화면의 필수 표시와 다른 축이다. */
function assertReason(body: PutawayTaskComplete): void {
  const has = (v: string | null | undefined): boolean => typeof v === 'string' && v.trim() !== '';
  if (!has(body.reasonCode) && !has(body.remarks)) {
    throw one(field('reasonCode', ERROR_CODE.REQUIRED, '사유 코드와 비고 중 하나는 있어야 합니다.'));
  }
}

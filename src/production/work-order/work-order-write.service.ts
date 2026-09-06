import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { optional } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';

/** 계약 `WorkOrderCreate` 11칸 — required 넷. */
export interface WorkOrderCreate {
  productionPlanId?: number | null;
  routingOperationId: number;
  itemId: number;
  orderQty: number;
  uomId: number;
  workOrderTypeCode?: string;
  priorityNo?: number;
  plannedStartAt?: string;
  plannedEndAt?: string;
  dueDate?: string;
  remarks?: string;
}

/** 계약 `WorkOrderUpdate` 13칸 — 여덟이 nullable(명시적 null = 해제)이고 다섯은 생략=유지만. */
export interface WorkOrderUpdate {
  orderQty?: number;
  priorityNo?: number;
  plannedStartAt?: string | null;
  plannedEndAt?: string | null;
  plannedEquipmentId?: number | null;
  plannedMoldId?: number | null;
  plannedShiftId?: number | null;
  productionLineId?: number | null;
  responsibleWorkerId?: number | null;
  defaultWipLocationId?: number;
  defaultFgLocationId?: number;
  defaultScrapLocationId?: number;
  remarks?: string | null;
}

/** 채번 문서 유형 — `DEFAULT_PREFIX` 의 `WO`. */
const WORK_ORDER = 'WORK_ORDER';
/** 태어나는 상태. ⛔ 전이표 밖이다 — `from` 이 없는 자리는 표에 담을 수 없다(§3-1). */
const INITIAL_STATUS = 'PLANNED';
/** 계약 ⌜보내지 않으면 서버가 NORMAL(양산)로 채운다⌝. */
const DEFAULT_TYPE = 'NORMAL';
/** 물리 `priority_no` 의 기본값과 같은 값 — 아래 주석과 같은 이유로 명시한다. */
const DEFAULT_PRIORITY = 100;
/** If-Match 어긋남의 계약 `code`(`ProductionConflictResponse.code` required). */
export const VERSION_CONFLICT = 'VERSION_CONFLICT';

/** 잠근 W/O 에서 판정에 쓰는 칸만. */
export interface LockedWorkOrder {
  status_code: string;
  released_at: Date | null;
  version_no: number;
}

/**
 * ⛔ `SELECT … FOR UPDATE` 로 잠근다 — 읽고 판정하고 쓰는 사이에 다른 요청이 같은 행을
 * 옮기면 전이 판정이 옛 상태를 본다(`document-cancel.service.ts` 선례).
 */
export async function lockWorkOrder(
  tx: Prisma.TransactionClient,
  workOrderId: number,
): Promise<LockedWorkOrder> {
  const rows = await tx.$queryRaw<LockedWorkOrder[]>`
    SELECT status_code, released_at, version_no
      FROM production.work_order
     WHERE work_order_id = ${BigInt(workOrderId)}
       FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('없는 작업지시입니다.');
  return rows[0];
}

/** If-Match 가 없으면(선택 자리) 대조를 건너뛴다 — 큐에 쌓인 요청은 토큰을 싣지 않는다(C-9). */
export function assertVersion(locked: LockedWorkOrder, version: number | undefined): void {
  if (version !== undefined && locked.version_no !== version) {
    assertUpdated(0, 'user', { code: VERSION_CONFLICT });
  }
}

/**
 * W/O 발행·수정. 전이 다섯은 `work-order-transition.service.ts` 가 진다 — 이쪽은
 * 상태를 옮기지 않는다(계약이 `PUT` 본문에 `statusCode` 칸을 두지 않은 것이 그 뜻이다).
 */
@Injectable()
export class WorkOrderWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
  ) {}

  /**
   * ⛔ 계획을 비운 긴급 발행은 **아직 열지 않는다** — 내부 P/O 의 `plant_id`·
   * `business_unit_id`(둘 다 NOT NULL)를 풀 값이 요청에도 물리에도 없다. 「공장이
   * 하나뿐이면 그것」은 조용한 도출이라 거부한다(I-6 R-6 · 문의 040).
   */
  async create(body: WorkOrderCreate, appUserId: number | undefined): Promise<number> {
    if (body.productionPlanId === undefined || body.productionPlanId === null) {
      throw one(
        field(
          'productionPlanId',
          ERROR_CODE.REQUIRED,
          '긴급 발행 경로는 공장 컨텍스트 확정(문의 040) 뒤 연다.',
        ),
      );
    }

    // ⛔ `$transaction` «밖»이다 — 안에서 부르면 커넥션을 둘 쥔다(`numbering.service.ts:51-53`).
    //    없는 계획·품목은 FK 그물이 400 으로 잡고 그때 번호 하나가 결번으로 남는다(I-2 R-2).
    const workOrderNo = await this.numbering.next(WORK_ORDER, null, today());
    const created = await this.prisma.work_order.create({
      data: {
        work_order_no: workOrderNo,
        production_plan_id: BigInt(body.productionPlanId),
        routing_operation_id: BigInt(body.routingOperationId),
        item_id: BigInt(body.itemId),
        order_qty: body.orderQty,
        uom_id: BigInt(body.uomId),
        // ⛔ `@default` 에 기대지 않고 값을 «명시»한다 — 정적 기본값은 `prisma generate` 를
        //    다시 돌려야 반영돼, 스키마만 고친 환경에서 옛 값이 조용히 들어간다.
        work_order_type_code: body.workOrderTypeCode ?? DEFAULT_TYPE,
        priority_no: body.priorityNo ?? DEFAULT_PRIORITY,
        planned_start_at: body.plannedStartAt ?? null,
        planned_end_at: body.plannedEndAt ?? null,
        status_code: INITIAL_STATUS,
        remarks: body.remarks ?? null,
        created_by: appUserId ?? null,
        updated_by: appUserId ?? null,
        // ⚠ `dueDate` 는 «버린다» — 계약이 그 값을 서버가 함께 만드는 내부 P/O 의 칸에
        //   싣는다고 적었는데(040 보류) 계획을 받은 경로에는 담을 칸이 없다(「알려둘 것」).
      },
      select: { work_order_id: true },
    });
    return Number(created.work_order_id);
  }

  /**
   * 계약 ⌜배포 전에만 고친다⌝ — 자물쇠는 `released_at IS NULL` 이다. 상태 문자열로 가르지
   * 않는다: 목록 질의 셋이 같은 축을 쓰고(⌜상태 코드 문자열을 몰라도 판정된다⌝), 값을
   * 나열하면 `CONFIRMED` 를 지나지 않는 전이표와 이중으로 얽힌다(§7-2).
   */
  async update(
    workOrderId: number,
    version: number,
    body: WorkOrderUpdate,
    appUserId: number | undefined,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockWorkOrder(tx, workOrderId);
      assertVersion(locked, version);
      if (locked.released_at !== null) {
        throw one(
          field('statusCode', ERROR_CODE.STATE_LOCKED, '배포된 작업지시는 고칠 수 없습니다.'),
        );
      }

      await tx.work_order.update({
        where: { work_order_id: BigInt(workOrderId) },
        data: {
          ...workOrderUpdateData(body),
          updated_by: appUserId ?? null,
          version_no: { increment: 1 },
        },
      });
    });
  }
}

/**
 * `undefined`(본문에 없었다) 와 `null`(비우라고 보냈다) 를 가른다 — 계약이 여덟 칸에
 * ⌜명시적 null = 해제 · 필드 생략 = 기존 값 유지⌝ 를 적었다. 순수 함수라 목 없이 검사한다.
 */
export function workOrderUpdateData(body: WorkOrderUpdate): Record<string, unknown> {
  return {
    ...optional('order_qty', body.orderQty),
    ...optional('priority_no', body.priorityNo),
    ...optional('planned_start_at', at(body.plannedStartAt)),
    ...optional('planned_end_at', at(body.plannedEndAt)),
    ...optional('planned_equipment_id', id(body.plannedEquipmentId)),
    ...optional('planned_mold_id', id(body.plannedMoldId)),
    ...optional('planned_shift_id', id(body.plannedShiftId)),
    ...optional('production_line_id', id(body.productionLineId)),
    ...optional('responsible_worker_id', id(body.responsibleWorkerId)),
    ...optional('default_wip_location_id', id(body.defaultWipLocationId)),
    ...optional('default_fg_location_id', id(body.defaultFgLocationId)),
    ...optional('default_scrap_location_id', id(body.defaultScrapLocationId)),
    ...optional('remarks', body.remarks),
  };
}

const id = (value: number | null | undefined): bigint | null | undefined =>
  value === undefined || value === null ? (value as null | undefined) : BigInt(value);
const at = (value: string | null | undefined): Date | null | undefined =>
  value === undefined || value === null ? (value as null | undefined) : new Date(value);

/** 채번 기간 키 — W/O 는 영업일 칸이 없다. 서버·컨테이너 TZ 가 UTC 로 고정이다. */
const today = (): string => new Date().toISOString().slice(0, 10);

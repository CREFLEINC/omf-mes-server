import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkOrderResourcePlanView, workOrderResourcePlanView } from './work-order-view';

/**
 * 4M 계획 배정 추가·해제 — 계약 `POST`/`DELETE …/{workOrderId}/resource-plans`.
 * 자원 유형마다 N 행을 받고 `uq_work_order_resource_plan` 이 같은 자원의 중복을 막는다.
 */

/** 계약 enum 3값 ↔ 물리 네 칸(§2-2). ⛔ `SHIFT` 는 계약 enum 에 없어 이 경로로 안 채워진다. */
export const TARGET_COLUMN = {
  EQUIPMENT: 'equipment_id',
  WORKER: 'worker_id',
  MOLD: 'mold_id',
} as const;

export interface WorkOrderResourcePlanCreate { resourceTypeCode: keyof typeof TARGET_COLUMN; resourceId: number }

@Injectable()
export class WorkOrderResourcePlanService {
  constructor(private readonly prisma: PrismaService) {}

  /** 201 · 중복 배정은 409 · 없는 W/O 는 404 · 없는 `resourceId` 는 FK 그물이 400 으로 낸다. */
  async add(workOrderId: number, body: WorkOrderResourcePlanCreate, actorId?: number): Promise<WorkOrderResourcePlanView> {
    const exists = await this.prisma.work_order.findUnique({
      where: { work_order_id: workOrderId },
      select: { work_order_id: true },
    });
    if (!exists) throw new NotFoundException('없는 작업지시입니다.');

    const target = { [TARGET_COLUMN[body.resourceTypeCode]]: BigInt(body.resourceId) };
    const where = { work_order_id: workOrderId, resource_type_code: body.resourceTypeCode, ...target };
    // 손검사가 먼저다 — 식 유일 인덱스의 `P2002.meta.target` 이 이름을 어떻게 담는지 Prisma
    // 버전에 달려 있어 문구가 흔들린다. 인덱스는 경합의 «마지막 그물»로만 쓴다.
    if (await this.prisma.work_order_resource_assignment.findFirst({ where, select: { work_order_id: true } })) {
      throw this.duplicate();
    }

    try {
      const row = await this.prisma.work_order_resource_assignment.create({
        data: {
          work_order_id: workOrderId,
          resource_type_code: body.resourceTypeCode,
          ...target,
          // 정적 기본값은 `prisma generate` 에 기대는 값이라 명시한다.
          assignment_status_code: 'PLANNED',
          ...(actorId === undefined ? {} : { created_by: actorId }),
        },
      });
      return workOrderResourcePlanView(row);
    } catch (error) {
      // 손검사와 INSERT 사이에 낀 동시 요청 — 같은 409 로 흡수한다.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw this.duplicate();
      throw error;
    }
  }

  /**
   * 204 · 없으면 404(두 번째 호출도 404). 배정 id 가 다른 W/O 의 것이면 짝이 안 맞아 404 다.
   * ⛔ 배포 뒤 해제를 막지 않는다 — 계약에 그 문장이 없다(없는 자물쇠를 더하지 않는다).
   */
  async remove(workOrderId: number, workOrderResourcePlanId: number): Promise<void> {
    const removed = await this.prisma.work_order_resource_assignment.deleteMany({
      where: { work_order_resource_assignment_id: workOrderResourcePlanId, work_order_id: workOrderId },
    });
    if (removed.count === 0) throw new NotFoundException('없는 자원 배정입니다.');
  }

  /** ⚠ 이 자리의 409 봉투만 `ErrorResponse` 다 — 다른 여섯은 `ProductionConflictResponse` 다(계약 실측). */
  private duplicate(): ContractException {
    return new ContractException(HttpStatus.CONFLICT, [
      {
        scope: 'field',
        field: 'resourceId',
        code: ERROR_CODE.UNIQUE_VIOLATION,
        uniqueScope: ['workOrderId', 'resourceTypeCode', 'resourceId'],
        message: '이미 배정된 자원입니다.',
      },
    ]);
  }
}

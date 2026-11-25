import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { Editability, Referrer, assertNotBlank, countReferences, optional } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { crossesMidnight, shiftTimeOf } from '../../core/calendar/shift-crossing';
import { plantScopeFor } from '../../planning/production-order/production-order-scope';
import { PrismaService } from '../../prisma/prisma.service';

/** 교대를 FK 로 가리키는 자리. 하나라도 있으면 코드를 바꾸지 못한다(공유계약 B-4). */
export const SHIFT_REFERRERS: readonly Referrer[] = [
  ['production.work_order', 'planned_shift_id'],
  ['production.work_order_resource_assignment', 'shift_id'],
  ['production.work_session', 'shift_id'],
  ['production.production_result', 'shift_id'],
];

/** 계약 `Shift` — 조회 API(`GET /mdm/shifts`)와 같은 모양이다. */
export interface ShiftView {
  shiftId: number;
  plantId: number;
  shiftCode: string;
  shiftName: string;
  startTime: string;
  endTime: string;
  crossesMidnight: boolean;
  isActive: boolean;
}

export interface ShiftCreate {
  plantId: number;
  shiftCode: string;
  shiftName: string;
  startTime: string;
  endTime: string;
}

export interface ShiftUpdate {
  shiftCode?: string;
  shiftName: string;
  startTime: string;
  endTime: string;
}

export interface ShiftDetail {
  shift: ShiftView;
  editability: Editability;
  versionNo: number;
}

type ShiftRow = Prisma.shiftGetPayload<object>;
type Tx = Prisma.TransactionClient;

/** 교대 관리(W-06-26 · omf-all-around#318). 공장별 주간·야간 시간을 화면에서 등록한다 — 시드에 값을 넣지 않는다. */
@Injectable()
export class ShiftService {
  constructor(private readonly prisma: PrismaService) {}

  async get(shiftId: number): Promise<ShiftDetail> {
    const row = await this.prisma.shift.findUnique({ where: { shift_id: shiftId } });
    if (!row) throw new NotFoundException('없는 교대입니다.');
    const referenceCount = await countReferences(this.prisma, SHIFT_REFERRERS, row.shift_id);
    return {
      shift: shiftView(row),
      editability: {
        codeEditable: referenceCount === 0,
        reason: referenceCount === 0 ? 'EDITABLE' : 'REFERENCED',
        referenceCount,
      },
      versionNo: row.version_no,
    };
  }

  async create(tx: Tx, actorUserId: number | undefined, input: ShiftCreate): Promise<ShiftView> {
    assertTexts(input);
    assertDistinctTimes(input.startTime, input.endTime);
    const plant = await tx.plant.findUnique({ where: { plant_id: input.plantId }, select: { plant_id: true } });
    if (plant === null) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [field('plantId', ERROR_CODE.INVALID, '없는 공장입니다.')]);
    }
    await assertPlantInScope(tx, actorUserId, input.plantId);
    const row = await tx.shift.create({
      data: {
        plant_id: input.plantId,
        shift_code: input.shiftCode.trim(),
        shift_name: input.shiftName.trim(),
        ...timeColumns(input.startTime, input.endTime),
        ...(actorUserId === undefined ? {} : { created_by: actorUserId, updated_by: actorUserId }),
      },
    });
    return shiftView(row);
  }

  /**
   * ⚠ `runVersioned` 는 멱등 트랜잭션을 업무 콜백에 넘기지 않는다(작업 캘린더와 같은 결) — 범위 확인과 저장을 자기 트랜잭션으로 묶는다.
   */
  async update(actorUserId: number | undefined, shiftId: number, version: number, input: ShiftUpdate): Promise<ShiftDetail> {
    assertTexts({ shiftCode: input.shiftCode, shiftName: input.shiftName });
    assertDistinctTimes(input.startTime, input.endTime);
    await this.prisma.$transaction(async (tx) => {
      const current = await this.writable(tx, actorUserId, shiftId);
      if (input.shiftCode !== undefined && input.shiftCode.trim() !== current.shift_code) {
        const referenceCount = await countReferences(tx, SHIFT_REFERRERS, current.shift_id);
        if (referenceCount > 0) {
          throw new ContractException(HttpStatus.BAD_REQUEST, [
            field('shiftCode', ERROR_CODE.INVALID, `이미 작업·실적에 쓰인 교대라 코드를 바꿀 수 없습니다(${referenceCount}건).`),
          ]);
        }
      }
      const updated = await tx.shift.updateMany({
        // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
        where: { shift_id: shiftId, version_no: version },
        data: {
          shift_name: input.shiftName.trim(),
          ...optional('shift_code', input.shiftCode?.trim()),
          ...timeColumns(input.startTime, input.endTime),
          ...auditColumns(actorUserId),
        },
      });
      assertUpdated(updated.count);
    });
    return this.get(shiftId);
  }

  async deactivate(actorUserId: number | undefined, shiftId: number, version: number): Promise<ShiftDetail> {
    await this.prisma.$transaction(async (tx) => {
      await this.writable(tx, actorUserId, shiftId);
      const updated = await tx.shift.updateMany({
        where: { shift_id: shiftId, version_no: version },
        data: { is_active: false, ...auditColumns(actorUserId) },
      });
      assertUpdated(updated.count);
    });
    return this.get(shiftId);
  }

  /** 사용 중지한 교대를 다시 쓴다 — 같은 공장·코드는 새로 등록할 수 없으므로 되살리는 길이다. 이미 사용 중이면 그대로 둔다. */
  async activate(actorUserId: number | undefined, shiftId: number, version: number): Promise<ShiftDetail> {
    await this.prisma.$transaction(async (tx) => {
      await this.writable(tx, actorUserId, shiftId);
      const updated = await tx.shift.updateMany({
        where: { shift_id: shiftId, version_no: version },
        data: { is_active: true, ...auditColumns(actorUserId) },
      });
      assertUpdated(updated.count);
    });
    return this.get(shiftId);
  }

  /** 있는 교대이고 그 공장이 요청자 데이터 범위 안인가. 없으면 404, 범위 밖이면 403. */
  private async writable(tx: Tx, actorUserId: number | undefined, shiftId: number): Promise<ShiftRow> {
    const row = await tx.shift.findUnique({ where: { shift_id: shiftId } });
    if (!row) throw new NotFoundException('없는 교대입니다.');
    await assertPlantInScope(tx, actorUserId, Number(row.plant_id));
    return row;
  }
}

export function shiftView(row: ShiftRow): ShiftView {
  return {
    shiftId: Number(row.shift_id),
    plantId: Number(row.plant_id),
    shiftCode: row.shift_code,
    shiftName: row.shift_name,
    startTime: shiftTimeOf(row.start_time),
    endTime: shiftTimeOf(row.end_time),
    crossesMidnight: row.crosses_midnight,
    isActive: row.is_active,
  };
}

async function assertPlantInScope(tx: Tx, actorUserId: number | undefined, plantId: number): Promise<void> {
  // 세션 없는 호출은 인증 가드가 이미 막았다 — 여기 오는 요청자는 늘 있다.
  if (actorUserId !== undefined) await plantScopeFor(tx, actorUserId, plantId);
}

function assertTexts(input: { shiftCode?: string; shiftName: string }): void {
  assertNotBlank([
    ...(input.shiftCode === undefined ? [] : [['shiftCode', input.shiftCode] as const]),
    ['shiftName', input.shiftName] as const,
  ]);
}

/**
 * 시작과 종료가 같은 시각이면 0시간 교대인지 24시간 교대인지 정할 수 없다 — 받지 않는다(화면도 고르지 못하게 막는다).
 */
function assertDistinctTimes(startTime: string, endTime: string): void {
  if (startTime === endTime) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      field('endTime', ERROR_CODE.INVALID, '종료 시간은 시작 시간과 같을 수 없습니다.'),
    ]);
  }
}

/**
 * 자정 넘김 플래그는 시각으로 정한다(끝 ≤ 시작) — 화면이 따로 보내면 시각과 어긋난 행이 생긴다.
 * 판정·계획 창이 쓰는 `crossesMidnight` 와 같은 함수다.
 */
function timeColumns(startTime: string, endTime: string): {
  start_time: Date;
  end_time: Date;
  crosses_midnight: boolean;
} {
  return {
    start_time: new Date(`1970-01-01T${startTime}Z`),
    end_time: new Date(`1970-01-01T${endTime}Z`),
    crosses_midnight: crossesMidnight(startTime, endTime),
  };
}

function auditColumns(actorUserId: number | undefined): Record<string, unknown> {
  return {
    version_no: { increment: 1 },
    updated_at: new Date(),
    ...(actorUserId === undefined ? {} : { updated_by: actorUserId }),
  };
}

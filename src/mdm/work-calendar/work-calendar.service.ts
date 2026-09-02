import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { Editability, ReferenceQuery, Referrer, assertCodeValues, countReferences, optional, referencePage, referenceWhere, toDateString } from '../../common/master';

/** 캘린더를 FK 로 가리키는 자리. e2e 가 `pg_constraint` 로 대조한다. */
export const WORK_CALENDAR_REFERRERS: readonly Referrer[] = [
  ['mdm.work_calendar_application', 'work_calendar_id'],
  ['mdm.work_calendar_day', 'work_calendar_id'],
];

/** 계약 `WorkCalendar` 와 동형 — 네 칸뿐이다. 공장 축이 없다. */
interface CalendarView {
  workCalendarId: number;
  calendarCode: string;
  calendarName: string;
  isActive: boolean;
}

/** 계약 `WorkCalendarDay`. 부분 가동일 때만 시각을 쓴다. */
interface DayView {
  calendarDate: string;
  dayTypeCode: string;
  startTime: string | null;
  endTime: string | null;
  reasonCode: string | null;
  remarks: string | null;
}

export interface DayInput {
  calendarDate: string;
  dayTypeCode: string;
  startTime?: string | null;
  endTime?: string | null;
  reasonCode?: string | null;
  remarks?: string | null;
}

/** 계약 `WorkCalendarApplication` — 대상 하나가 어느 캘린더를 따르는가. */
interface ApplicationView {
  targetTypeCode: string;
  targetId: number;
  targetName: string;
  workCalendarId: number;
  calendarCode: string;
}

export interface ApplicationQuery {
  workCalendarId?: number;
  targetTypeCode?: string;
  plantId?: number;
  page?: number;
  size?: number;
}

interface ResolutionStep {
  levelCode: 'EQUIPMENT_GROUP' | 'PLANT';
  targetId: number;
  targetName: string;
  hasApplication: boolean;
}

export interface EffectiveCalendar {
  equipmentId: number;
  equipmentName: string;
  steps: ResolutionStep[];
  workCalendarId: number | null;
  calendarCode: string | null;
  resolvedFromLevelCode: string | null;
}

type CalendarRow = Prisma.work_calendarGetPayload<object>;

const PLANT = 'PLANT';
const EQUIPMENT_GROUP = 'EQUIPMENT_GROUP';
/** 부분 가동일 때만 시각을 쓴다 — 계약이 그렇게 적었다. */
const PARTIAL = 'PARTIAL';

@Injectable()
export class WorkCalendarService {
  constructor(private readonly prisma: PrismaService) {}

  // ── 캘린더 ──────────────────────────────────────────────────────────────

  async list(query: ReferenceQuery): Promise<PagedResponse<CalendarView>> {
    const page = referencePage(query);
    const where = referenceWhere(query, { code: 'calendar_code', name: 'calendar_name' });
    const [rows, total] = await Promise.all([
      this.prisma.work_calendar.findMany({
        where,
        orderBy: { calendar_code: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.work_calendar.count({ where }),
    ]);
    return pagedResponse(rows.map(view), total, page);
  }

  async get(workCalendarId: number): Promise<{
    workCalendar: CalendarView;
    editability: Editability;
    applicationCount: number;
    versionNo: number;
  }> {
    const row = await this.prisma.work_calendar.findUnique({
      where: { work_calendar_id: workCalendarId },
    });
    if (!row) throw new NotFoundException('없는 작업 캘린더입니다.');

    const [referenceCount, applicationCount] = await Promise.all([
      countReferences(this.prisma, WORK_CALENDAR_REFERRERS, row.work_calendar_id),
      // 「이 캘린더를 따르는 공장·설비 그룹 수」(계약).
      this.prisma.work_calendar_application.count({
        where: { work_calendar_id: row.work_calendar_id },
      }),
    ]);
    return {
      workCalendar: view(row),
      editability: {
        codeEditable: referenceCount === 0,
        reason: referenceCount === 0 ? 'EDITABLE' : 'REFERENCED',
        referenceCount,
      },
      applicationCount,
      versionNo: row.version_no,
    };
  }

  async create(input: { calendarCode: string; calendarName: string }): Promise<CalendarView> {
    return view(
      await this.prisma.work_calendar.create({
        data: { calendar_code: input.calendarCode, calendar_name: input.calendarName },
      }),
    );
  }

  async update(
    workCalendarId: number,
    version: number,
    input: { calendarCode?: string; calendarName: string },
  ): Promise<Awaited<ReturnType<WorkCalendarService['get']>>> {
    const updated = await this.prisma.work_calendar.updateMany({
      // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
      where: { work_calendar_id: workCalendarId, version_no: version },
      data: {
        calendar_name: input.calendarName,
        ...optional('calendar_code', input.calendarCode),
        version_no: { increment: 1 },
      },
    });
    await this.assertExists(workCalendarId, updated.count);
    return this.get(workCalendarId);
  }

  async deactivate(
    workCalendarId: number,
    version: number,
  ): Promise<Awaited<ReturnType<WorkCalendarService['get']>>> {
    const updated = await this.prisma.work_calendar.updateMany({
      where: { work_calendar_id: workCalendarId, version_no: version },
      data: { is_active: false, version_no: { increment: 1 } },
    });
    await this.assertExists(workCalendarId, updated.count);
    return this.get(workCalendarId);
  }

  // ── 날짜 ────────────────────────────────────────────────────────────────

  /** 「기간을 반드시 지정해 부른다 — 한 해가 365행이라 전량을 내리지 않는다」(L-3). */
  async listDays(workCalendarId: number, from: string, to: string): Promise<DayView[]> {
    await this.assertCalendarExists(workCalendarId);
    const rows = await this.prisma.work_calendar_day.findMany({
      where: {
        work_calendar_id: workCalendarId,
        calendar_date: { gte: new Date(from), lte: new Date(to) },
      },
      orderBy: { calendar_date: 'asc' },
    });
    return rows.map(dayView);
  }

  /**
   * 「보낸 날짜만 덮어쓴다 — 보내지 않은 날은 그대로 둔다」(계약).
   *
   * ⛔ 통째 교체가 «아니다». 「이 날 적용」·「요일 일괄」·「기간 일괄」이 모두 이 경로를
   * 쓰고, 화면이 바뀔 날짜를 미리 펼쳐 보인 뒤 그 목록을 보낸다. 통째로 갈면 화면이
   * 보여 준 것보다 훨씬 많은 날이 지워진다.
   */
  async replaceDays(
    workCalendarId: number,
    days: DayInput[],
    appUserId?: number,
  ): Promise<number> {
    await this.assertCalendarExists(workCalendarId);
    await this.assertDays(days);

    await this.prisma.$transaction(async (tx) => {
      for (const day of days) {
        const data = {
          day_type_code: day.dayTypeCode,
          work_start_time: toTime(day.startTime),
          work_end_time: toTime(day.endTime),
          reason_code: day.reasonCode ?? null,
          remarks: day.remarks ?? null,
        };
        await tx.work_calendar_day.upsert({
          where: {
            work_calendar_id_calendar_date: {
              work_calendar_id: workCalendarId,
              calendar_date: new Date(day.calendarDate),
            },
          },
          create: {
            work_calendar_id: workCalendarId,
            calendar_date: new Date(day.calendarDate),
            ...data,
            ...(appUserId === undefined ? {} : { created_by: appUserId }),
          },
          update: data,
        });
      }
    });

    // 계약 응답은 「덮어쓴 날짜 수」 하나다(`WorkCalendarDayUpdateResult`).
    return days.length;
  }

  // ── 적용 ────────────────────────────────────────────────────────────────

  async listApplications(query: ApplicationQuery): Promise<PagedResponse<ApplicationView>> {
    const page = referencePage(query);
    const where: Record<string, unknown> = {
      ...optional('work_calendar_id', query.workCalendarId),
      ...optional('target_type_code', query.targetTypeCode),
    };
    const [rows, total] = await Promise.all([
      this.prisma.work_calendar_application.findMany({
        where,
        include: { work_calendar: { select: { calendar_code: true } } },
        orderBy: [{ target_type_code: 'asc' }, { target_id: 'asc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.work_calendar_application.count({ where }),
    ]);

    const items = await Promise.all(
      rows.map(async (row) => ({
        targetTypeCode: row.target_type_code,
        targetId: Number(row.target_id),
        targetName: await this.targetName(row.target_type_code, Number(row.target_id)),
        workCalendarId: Number(row.work_calendar_id),
        calendarCode: row.work_calendar.calendar_code,
      })),
    );
    // plantId 는 대상 표가 갈려 질의로 못 건다 — 이름을 푼 뒤에 거른다.
    const filtered =
      query.plantId === undefined
        ? items
        : await this.filterByPlant(items, query.plantId);
    return pagedResponse(filtered, query.plantId === undefined ? total : filtered.length, page);
  }

  /**
   * 「대상 하나의 적용을 정한다. 공장 기본을 바꾸면 옛 지정 해제와 새 지정을 서버가
   * 한 트랜잭션으로 처리한다 — 화면이 두 번 부르지 않는다」(계약 · A-6).
   *
   * `workCalendarId` 가 비면 해제다(204). 그 대상은 상위 층을 따르게 된다.
   */
  async applyCalendar(
    targetTypeCode: string,
    targetId: number,
    workCalendarId: number | null,
    appUserId?: number,
  ): Promise<ApplicationView | null> {
    await this.assertTarget(targetTypeCode, targetId);
    if (workCalendarId !== null) await this.assertCalendarExists(workCalendarId);

    return this.prisma.$transaction(async (tx) => {
      // 대상 하나에 지정은 하나다 — 옛 것을 지우고 새 것을 넣는 것이 한 트랜잭션이다.
      await tx.work_calendar_application.deleteMany({
        where: { target_type_code: targetTypeCode, target_id: targetId },
      });
      if (workCalendarId === null) return null;

      const created = await tx.work_calendar_application.create({
        data: {
          work_calendar_id: workCalendarId,
          target_type_code: targetTypeCode,
          target_id: targetId,
          // 계약이 적용 시작일을 받지 않는다 — 「지금부터」로 읽는다.
          effective_from: new Date(),
          ...(appUserId === undefined ? {} : { created_by: appUserId }),
        },
        include: { work_calendar: { select: { calendar_code: true } } },
      });
      return {
        targetTypeCode,
        targetId,
        targetName: await this.targetName(targetTypeCode, targetId),
        workCalendarId,
        calendarCode: created.work_calendar.calendar_code,
      };
    });
  }

  /**
   * 「이 설비가 결국 어느 캘린더를 따르는가와 그렇게 정해진 경로」(계약 · B-17).
   * 가까운 층부터 훑고, 지정이 있는 층에서 멈춘다. 훑은 층을 모두 담아 화면이 그린다.
   */
  async effective(equipmentId: number): Promise<EffectiveCalendar> {
    const equipment = await this.prisma.equipment.findUnique({
      where: { equipment_id: equipmentId },
      select: { equipment_name: true, plant_id: true, production_line_id: true },
    });
    if (!equipment) throw new NotFoundException('없는 설비입니다.');

    const steps: ResolutionStep[] = [];
    let resolved: { workCalendarId: number; calendarCode: string; level: string } | null = null;

    const seen = new Set<number>();
    let groupId =
      equipment.production_line_id === null ? null : Number(equipment.production_line_id);
    while (groupId !== null && !seen.has(groupId)) {
      seen.add(groupId);
      const group: { line_name: string; parent_line_id: bigint | null } | null =
        await this.prisma.production_line.findUnique({
          where: { production_line_id: groupId },
          select: { line_name: true, parent_line_id: true },
        });
      if (group === null) break;
      const application = await this.applicationOf(EQUIPMENT_GROUP, groupId);
      steps.push({
        levelCode: EQUIPMENT_GROUP,
        targetId: groupId,
        targetName: group.line_name,
        hasApplication: application !== null,
      });
      if (application !== null && resolved === null) {
        resolved = { ...application, level: EQUIPMENT_GROUP };
        break;
      }
      groupId = group.parent_line_id === null ? null : Number(group.parent_line_id);
    }

    if (resolved === null) {
      const plantId = Number(equipment.plant_id);
      const plant = await this.prisma.plant.findUnique({
        where: { plant_id: plantId },
        select: { plant_name: true },
      });
      const application = await this.applicationOf(PLANT, plantId);
      steps.push({
        levelCode: PLANT,
        targetId: plantId,
        targetName: plant?.plant_name ?? '',
        hasApplication: application !== null,
      });
      if (application !== null) resolved = { ...application, level: PLANT };
    }

    return {
      equipmentId,
      equipmentName: equipment.equipment_name,
      steps,
      workCalendarId: resolved?.workCalendarId ?? null,
      calendarCode: resolved?.calendarCode ?? null,
      // 「null 이면 어느 층에도 지정이 없어 따르는 캘린더가 없다」(계약).
      resolvedFromLevelCode: resolved?.level ?? null,
    };
  }

  // ── 공통 ────────────────────────────────────────────────────────────────

  private async applicationOf(
    targetTypeCode: string,
    targetId: number,
  ): Promise<{ workCalendarId: number; calendarCode: string } | null> {
    const row = await this.prisma.work_calendar_application.findFirst({
      where: { target_type_code: targetTypeCode, target_id: targetId },
      include: { work_calendar: { select: { calendar_code: true } } },
    });
    return row === null
      ? null
      : {
          workCalendarId: Number(row.work_calendar_id),
          calendarCode: row.work_calendar.calendar_code,
        };
  }

  private async targetName(targetTypeCode: string, targetId: number): Promise<string> {
    if (targetTypeCode === PLANT) {
      const plant = await this.prisma.plant.findUnique({
        where: { plant_id: targetId },
        select: { plant_name: true },
      });
      return plant?.plant_name ?? '';
    }
    const line = await this.prisma.production_line.findUnique({
      where: { production_line_id: targetId },
      select: { line_name: true },
    });
    return line?.line_name ?? '';
  }

  private async filterByPlant(
    items: ApplicationView[],
    plantId: number,
  ): Promise<ApplicationView[]> {
    const groupIds = items
      .filter((item) => item.targetTypeCode === EQUIPMENT_GROUP)
      .map((item) => item.targetId);
    const inPlant = new Set(
      (
        await this.prisma.production_line.findMany({
          where: { plant_id: plantId, production_line_id: { in: groupIds } },
          select: { production_line_id: true },
        })
      ).map((row) => Number(row.production_line_id)),
    );
    return items.filter((item) =>
      item.targetTypeCode === PLANT ? item.targetId === plantId : inPlant.has(item.targetId),
    );
  }

  /** 「PLANT → mdm.plant · EQUIPMENT_GROUP → mdm.production_line」(계약). */
  private async assertTarget(targetTypeCode: string, targetId: number): Promise<void> {
    const exists =
      targetTypeCode === PLANT
        ? await this.prisma.plant.findUnique({
            where: { plant_id: targetId },
            select: { plant_id: true },
          })
        : await this.prisma.production_line.findUnique({
            where: { production_line_id: targetId },
            select: { production_line_id: true },
          });
    if (exists) return;
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      {
        scope: 'field',
        field: 'targetId',
        code: ERROR_CODE.INVALID,
        message: '없는 대상입니다.',
      },
    ]);
  }

  private async assertDays(days: DayInput[]): Promise<void> {
    const errors: ErrorItem[] = [];
    const seen = new Map<string, number>();
    days.forEach((day, index) => {
      const first = seen.get(day.calendarDate);
      if (first === undefined) seen.set(day.calendarDate, index);
      else {
        errors.push({
          scope: 'field',
          field: `days[${index}].calendarDate`,
          code: ERROR_CODE.UNIQUE_VIOLATION,
          uniqueScope: ['calendarDate'],
          message: `${first + 1}번째 줄과 같은 날짜입니다.`,
        });
      }

      // ⛔ 「부분 가동은 반일 근무를 담는다 — 휴무로 처리하면 조업시간이 통째로 빠져
      // 가동률이 틀린다」(계약). 시각이 없으면 반일이 몇 시간인지 아무도 모른다.
      if (day.dayTypeCode === PARTIAL && (day.startTime == null || day.endTime == null)) {
        errors.push({
          scope: 'field',
          field: `days[${index}].${day.startTime == null ? 'startTime' : 'endTime'}`,
          code: ERROR_CODE.REQUIRED,
          message: '부분 가동일은 시작·종료 시각이 필요합니다.',
        });
      }
      if (day.dayTypeCode !== PARTIAL && (day.startTime != null || day.endTime != null)) {
        errors.push({
          scope: 'field',
          field: `days[${index}].startTime`,
          code: ERROR_CODE.PAIR,
          message: '부분 가동이 아닌 날에는 시각을 두지 않습니다.',
        });
      }
    });
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    await assertCodeValues(
      this.prisma,
      days.flatMap((day, index) =>
        day.reasonCode == null
          ? []
          : [
              {
                field: `days[${index}].reasonCode`,
                value: day.reasonCode,
                groupCode: 'WORK_CALENDAR_DAY_REASON',
              },
            ],
      ),
    );
  }

  private async assertCalendarExists(workCalendarId: number): Promise<void> {
    const exists = await this.prisma.work_calendar.findUnique({
      where: { work_calendar_id: workCalendarId },
      select: { work_calendar_id: true },
    });
    if (!exists) throw new NotFoundException('없는 작업 캘린더입니다.');
  }

  /** 0행이 「없다」인지 「낡았다」인지 가른다 — 화면이 받는 상태 코드가 갈린다. */
  private async assertExists(workCalendarId: number, count: number): Promise<void> {
    if (count > 0) return;
    await this.assertCalendarExists(workCalendarId);
    assertUpdated(0);
  }
}

/** `@db.Time` 은 시각만 담는다 — 날짜 부분은 뜻이 없어 고정한다. */
function toTime(value: string | null | undefined): Date | null {
  return value == null ? null : new Date(`1970-01-01T${value}Z`);
}

function fromTime(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(11, 19);
}

function dayView(row: Prisma.work_calendar_dayGetPayload<object>): DayView {
  return {
    calendarDate: toDateString(row.calendar_date) as string,
    dayTypeCode: row.day_type_code,
    startTime: fromTime(row.work_start_time),
    endTime: fromTime(row.work_end_time),
    reasonCode: row.reason_code,
    remarks: row.remarks,
  };
}

function view(row: CalendarRow): CalendarView {
  return {
    workCalendarId: Number(row.work_calendar_id),
    calendarCode: row.calendar_code,
    calendarName: row.calendar_name,
    isActive: row.is_active,
  };
}

import { DEFAULT_DAY_START, timeOfColumn, workDayOf } from '../../planning/production-plan/plan-window';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 4M 의 교대·작업자 추천 — `resource-recommendation.ts` 의 응답에 붙는다. 저장하지 않는다. 고르는 것은 현장이다.
 * 교대: 공장의 활성 교대 전부 — 같은 설비가 같은 근무일에 이미 쓰는 교대를 뒤로 보낸다.
 * 작업자: 이력 기반(같은 설비 → 같은 라인 → 같은 공정을 맡았던 사람) 다음 그 공정의 유효 자격자.
 * 조 편성 기준정보는 아직 없다 — 고객 자료를 받은 뒤 세운다.
 */

export interface ShiftRecommendation {
  shiftId: number;
  shiftCode: string;
  shiftName: string;
  startTime: string;
  endTime: string;
  /** 이 W/O 의 설비가 같은 근무일 이 교대에 다른 W/O 로 잡혀 있다. */
  busy: boolean;
}

export type WorkerRecommendationSource = 'EQUIPMENT' | 'LINE' | 'PROCESS' | 'QUALIFIED';

export interface WorkerRecommendation {
  workerId: number;
  workerNo: string;
  workerName: string;
  source: WorkerRecommendationSource;
  /** 같은 근무일·같은 교대(교대가 없으면 겹치는 계획 시간)에 다른 W/O 의 책임자다. */
  busy: boolean;
}

/** 추천 작업자 수 — 화면이 한눈에 고를 만큼. */
export const WORKER_LIMIT = 5;
/** 출처마다 이만큼의 최근 W/O 만 본다. */
const RECENT_LIMIT = 50;
const PROCESS_OPERATION = 'PROCESS_OPERATION';
/** 이 상태의 W/O 는 설비·사람을 붙잡고 있지 않다. */
const RELEASED_STATUSES = ['CANCELLED', 'CLOSED'];
const DAY_MS = 24 * 60 * 60 * 1000;

/** 추천에 쓰는 이 W/O 의 칸. */
export interface CrewTarget {
  workOrderId: bigint;
  plantId: bigint;
  processId: bigint;
  plannedEquipmentId: bigint | null;
  productionLineId: bigint | null;
  plannedShiftId: bigint | null;
  plannedStartAt: Date | null;
  plannedEndAt: Date | null;
}

interface Rival {
  planned_shift_id: bigint | null;
  planned_start_at: Date | null;
  planned_end_at: Date | null;
}

/** 근무일을 가르는 기준 — 같은 근무일이면 그 생산이 시작한 날이 같다. */
export interface DayRule {
  dayStart: string;
  timezone: string;
}

/** 비어 있는 교대가 먼저, 그다음 시작 시각 순(주간 → 야간). */
export function orderShifts<T extends { startTime: string; busy: boolean }>(shifts: readonly T[]): T[] {
  return [...shifts].sort((a, b) => Number(a.busy) - Number(b.busy) || a.startTime.localeCompare(b.startTime));
}

/** 같은 설비를 쓰는 다른 W/O 중 이 W/O 와 같은 근무일인 것의 교대. 이 W/O 에 설비나 시작 시각이 없으면 아무 교대도 막지 않는다. */
export function busyShiftIds(target: Pick<CrewTarget, 'plannedEquipmentId' | 'plannedStartAt'>, rivals: readonly Rival[], rule: DayRule): Set<bigint> {
  const result = new Set<bigint>();
  if (target.plannedEquipmentId === null || target.plannedStartAt === null) return result;
  const day = workDayOf(target.plannedStartAt, rule.dayStart, rule.timezone);
  for (const rival of rivals) {
    if (rival.planned_shift_id === null || rival.planned_start_at === null) continue;
    if (workDayOf(rival.planned_start_at, rule.dayStart, rule.timezone) === day) result.add(rival.planned_shift_id);
  }
  return result;
}

/**
 * 작업자가 다른 W/O 를 맡고 있는가. 이 W/O 에 교대가 있으면 같은 교대·같은 근무일로, 없으면 겹치는 계획 시간 `[start, end)` 로 본다.
 */
export function isWorkerBusy(target: Pick<CrewTarget, 'plannedShiftId' | 'plannedStartAt' | 'plannedEndAt'>, others: readonly Rival[], rule: DayRule): boolean {
  const { plannedShiftId: shiftId, plannedStartAt: start, plannedEndAt: end } = target;
  if (start === null) return false;
  if (shiftId !== null) {
    const day = workDayOf(start, rule.dayStart, rule.timezone);
    return others.some(
      (other) => other.planned_shift_id === shiftId && other.planned_start_at !== null && workDayOf(other.planned_start_at, rule.dayStart, rule.timezone) === day,
    );
  }
  if (end === null) return false;
  return others.some((other) => other.planned_start_at !== null && other.planned_end_at !== null && start < other.planned_end_at && other.planned_start_at < end);
}

/** 출처 순서를 지켜 중복 없이 고른다. `eligible` 에 없는 사람(다른 공장·비활성)은 건너뛴다. */
export function pickWorkers(
  sources: readonly { source: WorkerRecommendationSource; workerIds: readonly bigint[] }[],
  eligible: ReadonlySet<bigint>,
  limit = WORKER_LIMIT,
): { workerId: bigint; source: WorkerRecommendationSource }[] {
  const seen = new Set<bigint>();
  const result: { workerId: bigint; source: WorkerRecommendationSource }[] = [];
  for (const { source, workerIds } of sources) {
    for (const workerId of workerIds) {
      if (result.length >= limit) return result;
      if (seen.has(workerId) || !eligible.has(workerId)) continue;
      seen.add(workerId);
      result.push({ workerId, source });
    }
  }
  return result;
}

export async function recommendCrew(
  prisma: PrismaService,
  target: CrewTarget,
): Promise<{ shifts: ShiftRecommendation[]; workers: WorkerRecommendation[] }> {
  const [plant, shifts] = await Promise.all([
    prisma.plant.findUniqueOrThrow({ where: { plant_id: target.plantId }, select: { timezone_code: true } }),
    prisma.shift.findMany({
      where: { plant_id: target.plantId, is_active: true },
      orderBy: [{ start_time: 'asc' }, { shift_id: 'asc' }],
      select: { shift_id: true, shift_code: true, shift_name: true, start_time: true, end_time: true },
    }),
  ]);
  // 근무일은 가장 이른 활성 교대 시작부터다 — 계획 창(`plan-window.ts`)과 같은 기준.
  const rule: DayRule = { dayStart: shifts.length === 0 ? DEFAULT_DAY_START : timeOfColumn(shifts[0].start_time), timezone: plant.timezone_code };
  const near = nearWindow(target.plannedStartAt);
  const notThis = { work_order_id: { not: target.workOrderId }, status_code: { notIn: RELEASED_STATUSES } };

  const equipmentRivals =
    target.plannedEquipmentId === null || near === undefined
      ? []
      : await prisma.work_order.findMany({
          where: { ...notThis, planned_equipment_id: target.plannedEquipmentId, planned_shift_id: { not: null }, planned_start_at: near },
          select: { planned_shift_id: true, planned_start_at: true, planned_end_at: true },
        });
  const busyShifts = busyShiftIds(target, equipmentRivals, rule);

  const workers = await recommendWorkers(prisma, target, rule, near);
  return {
    shifts: orderShifts(
      shifts.map((shift) => ({
        shiftId: Number(shift.shift_id),
        shiftCode: shift.shift_code,
        shiftName: shift.shift_name,
        startTime: timeOfColumn(shift.start_time),
        endTime: timeOfColumn(shift.end_time),
        busy: busyShifts.has(shift.shift_id),
      })),
    ),
    workers,
  };
}

async function recommendWorkers(
  prisma: PrismaService,
  target: CrewTarget,
  rule: DayRule,
  near: { gte: Date; lt: Date } | undefined,
): Promise<WorkerRecommendation[]> {
  const samePlant = { OR: [{ production_plan: { production_order: { plant_id: target.plantId } } }, { production_line: { plant_id: target.plantId } }] };
  const recent = (where: object) =>
    prisma.work_order
      .findMany({
        where: { AND: [samePlant, where], work_order_id: { not: target.workOrderId }, responsible_worker_id: { not: null } },
        orderBy: [{ planned_start_at: { sort: 'desc', nulls: 'last' } }, { work_order_id: 'desc' }],
        take: RECENT_LIMIT,
        select: { responsible_worker_id: true },
      })
      .then((rows) => rows.map((row) => row.responsible_worker_id as bigint));
  const today = utcToday(new Date());
  const [byEquipment, byLine, byProcess, qualified] = await Promise.all([
    target.plannedEquipmentId === null ? [] : recent({ planned_equipment_id: target.plannedEquipmentId }),
    target.productionLineId === null ? [] : recent({ production_line_id: target.productionLineId }),
    recent({ routing_operation: { process_id: target.processId } }),
    // 4M 점검의 자격 판정(`validation.ts` 자격)과 같은 유효 조건 — 공정 미지정 자격은 치지 않는다.
    prisma.worker_qualification
      .findMany({
        where: {
          qualification_type_code: PROCESS_OPERATION,
          process_id: target.processId,
          valid_from: { lte: today },
          OR: [{ valid_to: null }, { valid_to: { gte: today } }],
          worker: { plant_id: target.plantId, is_active: true },
        },
        orderBy: { worker_id: 'asc' },
        take: RECENT_LIMIT,
        select: { worker_id: true },
      })
      .then((rows) => rows.map((row) => row.worker_id)),
  ]);

  const candidateIds = [...new Set([...byEquipment, ...byLine, ...byProcess, ...qualified])];
  const people =
    candidateIds.length === 0
      ? []
      : await prisma.worker.findMany({
          where: { worker_id: { in: candidateIds }, plant_id: target.plantId, is_active: true },
          select: { worker_id: true, worker_no: true, worker_name: true },
        });
  const picked = pickWorkers(
    [
      { source: 'EQUIPMENT', workerIds: byEquipment },
      { source: 'LINE', workerIds: byLine },
      { source: 'PROCESS', workerIds: byProcess },
      { source: 'QUALIFIED', workerIds: qualified },
    ],
    new Set(people.map((person) => person.worker_id)),
  );
  if (picked.length === 0) return [];

  const others =
    near === undefined
      ? []
      : await prisma.work_order.findMany({
          where: {
            work_order_id: { not: target.workOrderId },
            status_code: { not: 'CANCELLED' },
            responsible_worker_id: { in: picked.map((item) => item.workerId) },
            planned_start_at: near,
          },
          select: { responsible_worker_id: true, planned_shift_id: true, planned_start_at: true, planned_end_at: true },
        });
  const byPerson = new Map(people.map((person) => [person.worker_id, person]));
  return picked.map(({ workerId, source }) => {
    const person = byPerson.get(workerId) as (typeof people)[number];
    return {
      workerId: Number(workerId),
      workerNo: person.worker_no,
      workerName: person.worker_name,
      source,
      busy: isWorkerBusy(target, others.filter((other) => other.responsible_worker_id === workerId), rule),
    };
  });
}

/** 같은 근무일·겹침 후보만 읽는다 — 이 W/O 시작 앞뒤 이틀이면 근무일 경계와 긴 W/O 를 모두 덮는다. */
function nearWindow(start: Date | null): { gte: Date; lt: Date } | undefined {
  if (start === null) return undefined;
  return { gte: new Date(start.getTime() - 2 * DAY_MS), lt: new Date(start.getTime() + 2 * DAY_MS) };
}

/** `@db.Date` 는 UTC 자정으로 돌아온다 — 「오늘」도 UTC 날짜로 잡는다(4M 점검 자격과 같은 태도). */
const utcToday = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

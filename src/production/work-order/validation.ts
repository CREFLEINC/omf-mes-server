import { NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * 4M 배정 유효성 점검 — 계약 `GET /production/work-orders/{workOrderId}/validation`.
 *
 * ⛔ 규칙은 **여섯뿐**이다(I-6.md §7-4 · 화면 `W-02-03` §4-C 표 그대로). 특히 **근무조 겹침
 * 규칙은 없다** — 표에 없는 것을 지어내지 않는다. `code` 여섯은 계약이 값 목록을 주지 않아
 * (`example: "값"`) 우리가 짓는다. 저장하지 않는다(GET) — 상태 전이가 아니다.
 * ⚠ 자원은 **두 축의 합집합**이다 — `work_order.planned_*` 세 칸(화면의 단일 배정 UI)과
 * `work_order_resource_assignment` 의 `EQUIPMENT`·`MOLD`·`WORKER` 행(계약이 세운 N 배정).
 * 한쪽만 보면 화면이 배정한 자원이 점검에서 빠진다. 같은 자원은 `(유형, id)` 로 접고,
 * `field` 는 어느 축에서 왔든 요청 칸 이름 그대로다(계약 `field` 의 뜻).
 */

export type ValidationSeverity = 'BLOCK' | 'WARN';
export interface ValidationFinding { severity: ValidationSeverity; field: string; code: string; message: string }
export interface ValidationReport { passed: boolean; findings: ValidationFinding[] }
export interface ValidationSummary { passed: boolean; blockCount: number; warnCount: number }

export interface Usable { status_code: string; is_active: boolean }
export interface EquipmentFacts extends Usable { equipment_id: bigint; calibration_required: boolean; calibration_due_date: Date | null }
export interface MoldFacts extends Usable { mold_id: bigint; guaranteed_shot_count: bigint | null; current_shot_count: bigint }
export interface PlanWindow { planned_start_at: Date | null; planned_end_at: Date | null }
export interface RivalWindow extends PlanWindow { planned_equipment_id: bigint | null }

/** 설비·금형이 「쓸 수 있는」 유일한 값 — `transitions.ts` 의 두 축이 `IN_SERVICE`→`DISPOSED` 다. */
const IN_SERVICE = 'IN_SERVICE';
/** `QUALIFICATION_TYPE` 시드 4값 중 공정 작업 자격. */
const PROCESS_OPERATION = 'PROCESS_OPERATION';

/** 마스터에 없는 id 도 못 쓰는 자원으로 본다 — FK 상 없을 수 없지만 조용히 통과시키지 않는다. */
const unusable = (fact: Usable | undefined): boolean => fact === undefined || fact.status_code !== IN_SERVICE || !fact.is_active;

/** #1 설비 가동 상태. */
export function checkEquipment(ids: bigint[], facts: Map<bigint, EquipmentFacts>): ValidationFinding[] {
  return ids
    .filter((id) => unusable(facts.get(id)))
    .map((id) => finding('BLOCK', 'EQUIPMENT_NOT_IN_SERVICE', 'plannedEquipmentId', `설비(${id})가 가동 상태가 아닙니다.`));
}

/** #2 금형 상태. */
export function checkMold(ids: bigint[], facts: Map<bigint, MoldFacts>): ValidationFinding[] {
  return ids
    .filter((id) => unusable(facts.get(id)))
    .map((id) => finding('BLOCK', 'MOLD_NOT_IN_SERVICE', 'plannedMoldId', `금형(${id})이 가동 상태가 아닙니다.`));
}

/** #3 설비 교정 만료 — 「오늘」은 UTC 날짜다(`@db.Date` · 타임존 캐스팅 금지 · CLAUDE.md). */
export function checkCalibration(ids: bigint[], facts: Map<bigint, EquipmentFacts>, today: Date): ValidationFinding[] {
  return ids
    .filter((id) => {
      const fact = facts.get(id);
      // 마스터에 없는 설비는 #1 이 이미 BLOCK 을 냈다 — 같은 자원에 두 번 적지 않는다.
      if (fact === undefined || !fact.calibration_required) return false;
      return fact.calibration_due_date === null || fact.calibration_due_date < today;
    })
    .map((id) => finding('WARN', 'EQUIPMENT_CALIBRATION_EXPIRED', 'plannedEquipmentId', `설비(${id})의 교정 기한이 지났습니다.`));
}

/** #4 작업자 자격 — 그 공정의 유효한 `PROCESS_OPERATION` 자격이 0행이면 WARN. */
export function checkQualification(ids: bigint[], qualified: Set<bigint>): ValidationFinding[] {
  return ids
    .filter((id) => !qualified.has(id))
    .map((id) => finding('WARN', 'WORKER_QUALIFICATION_EXPIRED', 'responsibleWorkerId', `작업자(${id})에게 유효한 공정 자격이 없습니다.`));
}

/** #5 금형 수명 — `guaranteed_shot_count` 가 NULL 이면 판정하지 않는다(보증 타수를 모른다). */
export function checkMoldLife(ids: bigint[], facts: Map<bigint, MoldFacts>): ValidationFinding[] {
  return ids
    .filter((id) => {
      const fact = facts.get(id);
      return fact?.guaranteed_shot_count != null && fact.current_shot_count >= fact.guaranteed_shot_count;
    })
    .map((id) => finding('WARN', 'MOLD_LIFE_EXCEEDED', 'plannedMoldId', `금형(${id})이 보증 타수를 넘었습니다.`));
}

/**
 * #6 설비 중복 배정 — 반열림 구간 `[start, end)` 겹침. 자기 W/O 든 상대 W/O 든 두 시각이 다
 * 있어야 판정한다(도출하지 않는 쪽).
 * ⛔ 상대를 상태로 거르지 않는다 — 계약도 화면도 제외를 적지 않았다(취소·마감 W/O 도 잡힌다).
 */
export function checkDoubleBooked(ids: bigint[], self: PlanWindow, rivals: RivalWindow[]): ValidationFinding[] {
  const { planned_start_at: start, planned_end_at: end } = self;
  if (start === null || end === null) return [];

  const overlaps = (rival: RivalWindow, id: bigint): boolean =>
    rival.planned_equipment_id === id &&
    rival.planned_start_at !== null &&
    rival.planned_end_at !== null &&
    start < rival.planned_end_at &&
    rival.planned_start_at < end;

  return ids
    .filter((id) => rivals.some((rival) => overlaps(rival, id)))
    .map((id) => finding('WARN', 'EQUIPMENT_DOUBLE_BOOKED', 'plannedEquipmentId', `설비(${id})가 같은 시간대의 다른 작업지시에 배정돼 있습니다.`));
}

/** 목록 `withValidation`·상세가 쓰는 요약 — 같은 report 를 세고 `findings` 만 버린다(PR ② `releasable` ⓒ). */
export function summarize(report: ValidationReport): ValidationSummary {
  const blockCount = report.findings.filter((item) => item.severity === 'BLOCK').length;
  return { passed: report.passed, blockCount, warnCount: report.findings.length - blockCount };
}

/** 없는 W/O 는 404 다(계약 선언). 403 은 권한 가드가 이미 본다. */
export async function validateWorkOrder(prisma: PrismaService, workOrderId: number): Promise<ValidationReport> {
  const row = await prisma.work_order.findUnique({
    where: { work_order_id: workOrderId },
    select: {
      planned_equipment_id: true, planned_mold_id: true, responsible_worker_id: true,
      planned_start_at: true, planned_end_at: true,
      routing_operation: { select: { process_id: true } },
    },
  });
  if (!row) throw new NotFoundException('없는 작업지시입니다.');

  const assignments = await prisma.work_order_resource_assignment.findMany({
    where: { work_order_id: workOrderId },
    select: { resource_type_code: true, equipment_id: true, mold_id: true, worker_id: true },
  });
  const union = (single: bigint | null, type: string, pick: (item: (typeof assignments)[number]) => bigint | null): bigint[] => [
    ...new Set([single, ...assignments.filter((item) => item.resource_type_code === type).map(pick)].filter((id) => id !== null)),
  ];

  const equipmentIds = union(row.planned_equipment_id, 'EQUIPMENT', (item) => item.equipment_id);
  const moldIds = union(row.planned_mold_id, 'MOLD', (item) => item.mold_id);
  const workerIds = union(row.responsible_worker_id, 'WORKER', (item) => item.worker_id);
  const today = utcToday(new Date());

  const [equipments, molds, qualified, rivals] = await Promise.all([
    when(equipmentIds, () => prisma.equipment.findMany({
      where: { equipment_id: { in: equipmentIds } },
      select: { equipment_id: true, status_code: true, is_active: true, calibration_required: true, calibration_due_date: true },
    })),
    when(moldIds, () => prisma.mold.findMany({
      where: { mold_id: { in: moldIds } },
      select: { mold_id: true, status_code: true, is_active: true, guaranteed_shot_count: true, current_shot_count: true },
    })),
    when(workerIds, () => prisma.worker_qualification.findMany({
      where: {
        worker_id: { in: workerIds },
        qualification_type_code: PROCESS_OPERATION,
        // ⛔ `process_id IS NULL` 인 자격 행은 이 공정 자격으로 «치지 않는다» — 「공정 미지정 =
        //    전 공정」은 어느 문서도 적지 않은 뜻이라 지어내지 않는다(README §2 기준 4).
        process_id: row.routing_operation.process_id,
        valid_from: { lte: today },
        OR: [{ valid_to: null }, { valid_to: { gte: today } }],
      },
      select: { worker_id: true },
    })),
    // 겹침 판정 자체는 순수 함수가 한다 — 여기서는 후보만 좁힌다(같은 산수를 두 곳에 두지 않는다).
    when(equipmentIds, () => prisma.work_order.findMany({
      where: {
        work_order_id: { not: BigInt(workOrderId) },
        planned_equipment_id: { in: equipmentIds },
        planned_start_at: { not: null },
        planned_end_at: { not: null },
      },
      select: { planned_equipment_id: true, planned_start_at: true, planned_end_at: true },
    })),
  ]);

  const byEquipment = new Map(equipments.map((item) => [item.equipment_id, item]));
  const byMold = new Map(molds.map((item) => [item.mold_id, item]));
  const findings = [
    ...checkEquipment(equipmentIds, byEquipment),
    ...checkMold(moldIds, byMold),
    ...checkCalibration(equipmentIds, byEquipment, today),
    ...checkQualification(workerIds, new Set(qualified.map((item) => item.worker_id))),
    ...checkMoldLife(moldIds, byMold),
    ...checkDoubleBooked(equipmentIds, row, rivals),
  ];
  return { passed: findings.every((item) => item.severity !== 'BLOCK'), findings };
}

/** 배정이 없는 축은 질의하지 않는다 — `in: []` 를 던지면 빈 IN 절이 돈다. */
const when = <T>(ids: bigint[], query: () => Promise<T[]>): Promise<T[]> | T[] => (ids.length === 0 ? [] : query());

/** `@db.Date` 는 UTC 자정으로 돌아온다 — 「오늘」도 UTC 날짜로 잡는다(입고 선례와 같은 태도). */
const utcToday = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

const finding = (severity: ValidationSeverity, code: string, field: string, message: string): ValidationFinding =>
  ({ severity, field, code, message });

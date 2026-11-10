import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { DashboardAvailabilityService, DashboardPlant } from './dashboard-availability.service';
import { DetailEvent, DetailSession, sessionTimes } from './dashboard-equipment-detail-time';
import { CONFIRMED_INSPECTION_RECORD, LATEST_RESULT_RECORD } from './dashboard-nonconformance.service';
import { intersect, subtract, totalLength } from './dashboard-intervals';
import { LEAF_RESULT, dashboardScope, num } from './dashboard-scope';
import type { DefectPhenomenon } from './dashboard-sections';
import { capRate } from './dashboard-view';

type Tx = Prisma.TransactionClient;

export interface DashboardEquipmentDetailQuery {
  equipmentId: number;
}

export interface DashboardEquipmentDetail {
  equipmentId: number;
  asOf: string;
  mold: { moldCode: string; moldName: string; cavityCount: number } | null;
  workOrder: { workOrderNo: string; orderQty: number; producedQty: number; progressRate: number | null } | null;
  output: { totalQty: number; goodQty: number; ngQty: number; defectRate: number | null };
  time: {
    plannedMs: number | null;
    runningMs: number;
    stoppedMs: number;
    noWorkMs: number | null;
    availabilityRate: number | null;
  };
  standardOutput: { expectedQty: number | null; differenceQty: number | null; excludedSessionCount: number };
  defectTypes: DefectPhenomenon[];
  untypedNgQty: number;
  stopReasons: { reasonCode: string | null; reasonName: string | null; durationMs: number }[];
}

interface SessionRow {
  work_session_id: bigint;
  started_at: Date;
  ended_at: Date | null;
  work_order_id: bigint;
  work_order_no: string;
  order_qty: string;
  rework: boolean;
  cycle_sec: string | null;
  mold_code: string | null;
  mold_name: string | null;
  cavity_count: number | null;
}

const PRODUCED = Prisma.sql`pr.good_qty + pr.defect_qty + pr.hold_qty + pr.scrap_qty + pr.rework_qty`;

/**
 * 설비 상세 팝업(omf-all-around#251) — 설비 현황판과 같이 공장 «오늘»·«지금» 기준이다(조회 기간과 무관).
 * 수량은 설비 현황과 같은 규칙(정정 원본 · 재작업 W/O 실적 제외, 재작업 합격 이동 없음)이되, 실적에 설비가 비었으면 그 작업
 * 세션의 설비로 센다 — POP 은 세션을 실어도 본문 설비를 생략하곤 하고(result-defect.ts), 표준 C/T 기준 생산량이 세션으로 세므로
 * 차이의 양쪽 기준을 맞춘다. 시간·가동률은 시간가동률 카드와 같은 원천(작업 세션 − STOP~RESUME, 근무달력 계획 구간)을 설비 한 대로
 * 센다 — 계획 = 계획 구간 길이, 작업 없음 = 계획 구간 − 세션 구간, 가동률 = 계획 구간과 겹친 가동 ÷ 계획.
 */
@Injectable()
export class DashboardEquipmentDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: DashboardAvailabilityService,
  ) {}

  async read(actorUserId: number, query: DashboardEquipmentDetailQuery): Promise<DashboardEquipmentDetail> {
    const now = new Date();
    const asOf = now.getTime();
    const equipmentId = BigInt(query.equipmentId);
    return this.prisma.$transaction(
      async (tx) => {
        const equipment = await tx.equipment.findUnique({
          where: { equipment_id: equipmentId },
          select: { plant_id: true, production_line_id: true },
        });
        if (equipment === null) throw new NotFoundException('없는 설비입니다.');
        // 공장 «오늘» — 기준일을 주지 않으면 dashboardScope 가 그 공장의 오늘로 정한다. 범위 밖 공장이면 403.
        const { range, plants } = await dashboardScope(tx, { plantId: equipment.plant_id }, now, actorUserId);
        const plant = plants[0] as DashboardPlant;
        const sessions = await this.sessions(tx, equipmentId, plant, now);
        const times = sessionTimes(
          sessions.map(toDetailSession),
          await this.events(tx, sessions, now),
          plant.measured,
          asOf,
        );
        // 오늘 세션이 없는 설비도 계획 구간을 센다 — 작업 없음이 가장 필요한 경우다.
        const plan = await this.availability.equipmentPlan(
          tx,
          plant,
          { equipmentId, productionLineId: equipment.production_line_id },
          range,
        );
        const plannedMs = plan === null ? null : totalLength(plan);
        const output = await this.output(tx, equipmentId, plant);
        const defects = await this.defects(tx, equipmentId, plant);
        // 현재 작업 — 설비 현황판과 같은 규칙: 가장 늦게 시작한 세션이 끝나지 않았을 때만.
        const latest = sessions.find((row) => row.started_at <= now);
        const open = latest !== undefined && (latest.ended_at === null || latest.ended_at > now) ? latest : undefined;
        const typed = defects.reduce((sum, row) => sum + row.qty, 0);
        return {
          equipmentId: query.equipmentId,
          asOf: now.toISOString(),
          mold: await this.mold(tx, equipmentId, open),
          workOrder: open === undefined ? null : await this.workOrder(tx, open),
          output,
          time: {
            plannedMs,
            runningMs: times.runningMs,
            stoppedMs: times.stoppedMs,
            noWorkMs: plan === null ? null : totalLength(subtract(plan, times.sessionSpans)),
            availabilityRate:
              plan === null || plannedMs === null || plannedMs <= 0
                ? null
                : capRate((totalLength(intersect(times.runningSpans, plan)) / plannedMs) * 100),
          },
          standardOutput: standardOutput(sessions, times.runningBySession, output.totalQty),
          defectTypes: defects,
          untypedNgQty: Math.max(0, output.ngQty - typed),
          stopReasons: await this.stopReasons(tx, times.stoppedByReason),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /** 공장 오늘과 겹친 이 설비의 세션 — 작업지시 · 표준 C/T · 금형(세션에 고른 금형, 없으면 작업지시 계획 금형). 늦게 시작한 순. */
  private sessions(tx: Tx, equipmentId: bigint, plant: DashboardPlant, now: Date): Promise<SessionRow[]> {
    return tx.$queryRaw<SessionRow[]>(Prisma.sql`
      SELECT ws.work_session_id, ws.started_at, ws.ended_at, wo.work_order_id, wo.work_order_no, wo.order_qty::text AS order_qty,
        wo.work_order_type_code = 'REWORK' AS rework, ro.standard_cycle_time_sec::text AS cycle_sec,
        m.mold_code, m.mold_name, m.cavity_count
      FROM production.work_session ws
      JOIN production.work_order wo ON wo.work_order_id = ws.work_order_id
      LEFT JOIN planning.routing_operation ro ON ro.routing_operation_id = wo.routing_operation_id
      LEFT JOIN mdm.mold m ON m.mold_id = COALESCE(ws.mold_id, wo.planned_mold_id)
      WHERE ws.equipment_id = ${equipmentId} AND ws.started_at < ${new Date(Math.min(plant.day.end, now.getTime()))}
        AND (ws.ended_at IS NULL OR ws.ended_at > ${new Date(plant.day.start)})
      ORDER BY ws.started_at DESC, ws.work_session_id DESC`);
  }

  private async events(tx: Tx, sessions: readonly SessionRow[], now: Date): Promise<DetailEvent[]> {
    const rows = await tx.work_session_event.findMany({
      where: {
        work_session_id: { in: sessions.map((row) => row.work_session_id) },
        event_type_code: { in: ['STOP', 'RESUME'] },
        occurred_at: { lte: now },
      },
      select: { work_session_id: true, event_type_code: true, occurred_at: true, reason_code: true },
    });
    return rows.map((row) => ({
      sessionId: row.work_session_id,
      eventTypeCode: row.event_type_code,
      occurredAt: row.occurred_at.getTime(),
      reasonCode: row.reason_code,
    }));
  }

  /**
   * 진행 중 세션의 금형(세션 → 작업지시 계획 순). 없으면 최근 실적 금형 — 진행 중 작업이 있으면 «그 작업지시»의 실적에서만
   * 찾는다(다른 작업지시의 지난 금형을 보이지 않는다). 진행 중 작업이 없으면 이 설비의 가장 최근 실적 금형.
   */
  private async mold(tx: Tx, equipmentId: bigint, open: SessionRow | undefined): Promise<DashboardEquipmentDetail['mold']> {
    if (open?.mold_code != null && open.mold_name !== null) {
      return { moldCode: open.mold_code, moldName: open.mold_name, cavityCount: open.cavity_count ?? 1 };
    }
    const latest = await tx.production_result.findFirst({
      where: {
        mold_id: { not: null },
        ...(open === undefined ? { equipment_id: equipmentId } : { work_order_id: open.work_order_id }),
      },
      orderBy: [{ occurred_at: 'desc' }, { production_result_id: 'desc' }],
      select: { mold: { select: { mold_code: true, mold_name: true, cavity_count: true } } },
    });
    return latest?.mold == null
      ? null
      : { moldCode: latest.mold.mold_code, moldName: latest.mold.mold_name, cavityCount: latest.mold.cavity_count };
  }

  /** 작업지시 진도 = 그 작업지시의 누적 실적(정정 원본 제외 · 모든 설비) ÷ 지시 수량 — 조회 기간과 무관하다. */
  private async workOrder(tx: Tx, open: SessionRow): Promise<DashboardEquipmentDetail['workOrder']> {
    const [row] = await tx.$queryRaw<{ qty: string | null }[]>(Prisma.sql`
      SELECT SUM(${PRODUCED})::text AS qty FROM production.production_result pr
      WHERE pr.work_order_id = ${open.work_order_id} AND ${LEAF_RESULT}`);
    const orderQty = num(open.order_qty);
    const producedQty = num(row?.qty);
    return {
      workOrderNo: open.work_order_no,
      orderQty,
      producedQty,
      progressRate: orderQty > 0 ? capRate((producedQty / orderQty) * 100) : null,
    };
  }

  private async output(tx: Tx, equipmentId: bigint, plant: DashboardPlant): Promise<DashboardEquipmentDetail['output']> {
    const [row] = await tx.$queryRaw<{ total_qty: string | null; good_qty: string | null; ng_qty: string | null }[]>(Prisma.sql`
      SELECT SUM(${PRODUCED})::text AS total_qty, SUM(pr.good_qty)::text AS good_qty,
        SUM(pr.defect_qty + pr.scrap_qty + pr.rework_qty)::text AS ng_qty
      FROM production.production_result pr
      JOIN production.work_order wo ON wo.work_order_id = pr.work_order_id
      LEFT JOIN production.work_session ws ON ws.work_session_id = pr.work_session_id
      WHERE COALESCE(pr.equipment_id, ws.equipment_id) = ${equipmentId} AND wo.work_order_type_code <> 'REWORK'
        AND pr.occurred_at >= ${new Date(plant.day.start)} AND pr.occurred_at < ${new Date(plant.day.end)}
        AND ${LEAF_RESULT}`);
    const totalQty = num(row?.total_qty);
    const ngQty = num(row?.ng_qty);
    return { totalQty, goodQty: num(row?.good_qty), ngQty, defectRate: totalQty > 0 ? capRate((ngQty / totalQty) * 100) : null };
  }

  /**
   * 오늘 이 설비 실적에 붙은 불량 기록의 유형별 수량 — 위 수량과 같은 실적(정정 원본 실적의 기록은 빠진다)에 확정 검사 결과 ·
   * 정정본 유형별 내역 규칙을 더한다. 많은 순 전부.
   */
  private async defects(tx: Tx, equipmentId: bigint, plant: DashboardPlant): Promise<DefectPhenomenon[]> {
    const rows = await tx.$queryRaw<{ defect_code_id: bigint; defect_code: string; defect_name: string; qty: string }[]>(Prisma.sql`
      SELECT dc.defect_code_id, dc.defect_code, dc.defect_name, SUM(dr.defect_qty)::text AS qty
      FROM quality.defect_record dr
      JOIN production.production_result pr ON pr.production_result_id = dr.production_result_id
      JOIN production.work_order wo ON wo.work_order_id = pr.work_order_id
      LEFT JOIN production.work_session ws ON ws.work_session_id = pr.work_session_id
      JOIN quality.defect_code dc ON dc.defect_code_id = dr.defect_code_id
      WHERE COALESCE(pr.equipment_id, ws.equipment_id) = ${equipmentId} AND wo.work_order_type_code <> 'REWORK'
        AND pr.occurred_at >= ${new Date(plant.day.start)} AND pr.occurred_at < ${new Date(plant.day.end)}
        AND ${LEAF_RESULT} AND ${CONFIRMED_INSPECTION_RECORD} AND ${LATEST_RESULT_RECORD}
      GROUP BY dc.defect_code_id ORDER BY SUM(dr.defect_qty) DESC, dc.defect_code`);
    return rows.map((row) => ({
      defectCodeId: Number(row.defect_code_id),
      defectCode: row.defect_code,
      defectName: row.defect_name,
      qty: num(row.qty),
    }));
  }

  /** 사유명이 없으면(비활성·삭제된 코드) 코드값을 그대로 이름으로 싣는다. 긴 순. */
  private async stopReasons(
    tx: Tx,
    byReason: ReadonlyMap<string | null, number>,
  ): Promise<DashboardEquipmentDetail['stopReasons']> {
    const codes = [...byReason.keys()].filter((code): code is string => code !== null);
    const names =
      codes.length === 0
        ? []
        : await tx.code_value.findMany({
            where: { code: { in: codes }, code_group: { group_code: 'WORK_SESSION_EVENT_REASON' } },
            select: { code: true, code_name: true },
          });
    const nameOf = new Map(names.map((row) => [row.code, row.code_name]));
    return [...byReason]
      .map(([reasonCode, durationMs]) => ({
        reasonCode,
        reasonName: reasonCode === null ? null : (nameOf.get(reasonCode) ?? reasonCode),
        durationMs,
      }))
      .sort((a, b) => b.durationMs - a.durationMs || (a.reasonCode ?? '').localeCompare(b.reasonCode ?? ''));
  }
}

function toDetailSession(row: SessionRow): DetailSession {
  return { sessionId: row.work_session_id, startedAt: row.started_at.getTime(), endedAt: row.ended_at?.getTime() ?? null };
}

/**
 * 표준 C/T 기준 생산량 = Σ(세션 가동 시간 ÷ 그 작업지시 표준 C/T × 세션 금형 캐비티, 금형 없으면 1). 수량 칸과 맞추려고
 * 재작업 W/O 세션은 넣지 않는다. 표준 C/T 가 없는 세션은 빼고 건수를 센다. 하나도 못 세면 null.
 */
export function standardOutput(
  sessions: readonly Pick<SessionRow, 'work_session_id' | 'rework' | 'cycle_sec' | 'cavity_count'>[],
  runningBySession: ReadonlyMap<bigint, number>,
  actualQty: number,
): DashboardEquipmentDetail['standardOutput'] {
  let expected = 0;
  let included = 0;
  let excludedSessionCount = 0;
  for (const row of sessions) {
    const running = runningBySession.get(row.work_session_id);
    if (row.rework || running === undefined) continue;
    const cycle = num(row.cycle_sec);
    if (!(cycle > 0)) {
      excludedSessionCount += 1;
      continue;
    }
    expected += (running / 1000 / cycle) * Math.max(1, row.cavity_count ?? 1);
    included += 1;
  }
  if (included === 0) return { expectedQty: null, differenceQty: null, excludedSessionCount };
  const expectedQty = Math.floor(expected);
  return { expectedQty, differenceQty: actualQty - expectedQty, excludedSessionCount };
}

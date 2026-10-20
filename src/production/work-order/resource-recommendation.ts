import { NotFoundException } from '@nestjs/common';

import { unusable } from '../../core/work-order';
import { PrismaService } from '../../prisma/prisma.service';
import { ShiftRecommendation, WorkerRecommendation, recommendCrew } from './crew-recommendation';
import { checkDoubleBooked, rivalWindows } from './validation';

/**
 * 4M 의 설비·금형 추천(교대·작업자는 `crew-recommendation.ts`) — 계약 선행 `GET /production/work-orders/{workOrderId}/resource-recommendations`
 * (`docs/계약-선행-수정항목.md`). 저장하지 않는다. 고르는 것은 현장이다.
 * 순서: 기본 매핑 → 나머지 매핑(우선순위) → 같은 품목·공정의 최근 W/O 가 쓴 것.
 * ⛔ 후보는 W/O 의 공장 것만 낸다 — 다른 공장 설비가 배정되면 단말 권한·재고가 공장을 넘는다.
 */

export type RecommendationSource = 'DEFAULT' | 'MAPPED' | 'RECENT';

export interface EquipmentRecommendation {
  equipmentId: number;
  equipmentCode: string;
  equipmentName: string;
  productionLineId: number | null;
  source: RecommendationSource;
  inService: boolean;
  /** 같은 시간대의 다른 W/O 에 이미 배정됐다 — 4M 점검의 설비 중복 배정과 같은 판정이다. */
  busy: boolean;
}

export interface MoldRecommendation {
  moldId: number;
  moldCode: string;
  moldName: string;
  source: RecommendationSource;
  inService: boolean;
}

export interface ResourceRecommendations {
  equipments: EquipmentRecommendation[];
  molds: MoldRecommendation[];
  shifts: ShiftRecommendation[];
  workers: WorkerRecommendation[];
}

/** 최근 사용은 이만큼의 W/O 만 본다 — 오래된 배정까지 끌어오면 추천이 길어지기만 한다. */
const RECENT_LIMIT = 20;
const EMPTY: ResourceRecommendations = { equipments: [], molds: [], shifts: [], workers: [] };

interface Candidate { id: bigint; source: RecommendationSource }
interface MapRow { process_id: bigint | null; is_default: boolean; equipment_id: bigint | null; mold_id: bigint | null }

export async function recommendResources(prisma: PrismaService, workOrderId: number): Promise<ResourceRecommendations> {
  const row = await prisma.work_order.findUnique({
    where: { work_order_id: workOrderId },
    select: {
      item_id: true, planned_start_at: true, planned_end_at: true,
      planned_equipment_id: true, planned_shift_id: true, production_line_id: true,
      routing_operation: { select: { process_id: true, equipment_required: true, mold_required: true } },
      production_plan: { select: { production_order: { select: { plant_id: true } } } },
      production_line: { select: { plant_id: true } },
    },
  });
  if (!row) throw new NotFoundException('없는 MES W/O 입니다.');
  const operation = row.routing_operation;
  const plantId = row.production_plan?.production_order.plant_id ?? row.production_line?.plant_id;
  // 공장을 모르면 어느 공장 설비든 틀릴 수 있다 — 추천하지 않는다.
  if (plantId === undefined) return EMPTY;
  const samePlant = { OR: [{ production_plan: { production_order: { plant_id: plantId } } }, { production_line: { plant_id: plantId } }] };

  const [maps, recent] = await Promise.all([
    prisma.item_resource_map.findMany({
      where: { plant_id: plantId, item_id: row.item_id, is_active: true, OR: [{ process_id: operation.process_id }, { process_id: null }] },
      orderBy: [{ is_default: 'desc' }, { priority_no: 'asc' }, { item_resource_map_id: 'asc' }],
      select: { process_id: true, is_default: true, equipment_id: true, mold_id: true },
    }),
    prisma.work_order.findMany({
      where: {
        AND: [samePlant, { OR: [{ planned_equipment_id: { not: null } }, { planned_mold_id: { not: null } }] }],
        work_order_id: { not: BigInt(workOrderId) },
        item_id: row.item_id,
        routing_operation: { process_id: operation.process_id },
      },
      orderBy: { work_order_id: 'desc' },
      take: RECENT_LIMIT,
      select: { planned_equipment_id: true, planned_mold_id: true },
    }),
  ]);

  // 품목 공통 매핑은 설비·금형이 필요한 공정에서만 추천한다 — 전개와 같은 기준(첫 공정 제한은 배정에만 둔다).
  const ordered = processFirst(maps);
  const own = (map: MapRow, required: boolean): boolean => map.process_id !== null || required;
  const sourceOf = (map: MapRow): RecommendationSource => (map.is_default ? 'DEFAULT' : 'MAPPED');
  const equipmentIds = candidates(
    ordered.filter((map) => map.equipment_id !== null && own(map, operation.equipment_required)).map((map) => ({ id: map.equipment_id as bigint, source: sourceOf(map) })),
    recent.map((item) => item.planned_equipment_id),
  );
  const moldIds = candidates(
    ordered.filter((map) => map.mold_id !== null && own(map, operation.mold_required)).map((map) => ({ id: map.mold_id as bigint, source: sourceOf(map) })),
    recent.map((item) => item.planned_mold_id),
  );

  const [equipments, molds, rivals, crew] = await Promise.all([
    prisma.equipment.findMany({
      where: { plant_id: plantId, equipment_id: { in: equipmentIds.map((item) => item.id) } },
      select: { equipment_id: true, equipment_code: true, equipment_name: true, production_line_id: true, status_code: true, is_active: true },
    }),
    prisma.mold.findMany({
      where: { plant_id: plantId, mold_id: { in: moldIds.map((item) => item.id) } },
      select: { mold_id: true, mold_code: true, mold_name: true, status_code: true, is_active: true },
    }),
    rivalWindows(prisma, workOrderId, equipmentIds.map((item) => item.id)),
    recommendCrew(prisma, {
      workOrderId: BigInt(workOrderId),
      plantId,
      processId: operation.process_id,
      plannedEquipmentId: row.planned_equipment_id,
      productionLineId: row.production_line_id,
      plannedShiftId: row.planned_shift_id,
      plannedStartAt: row.planned_start_at,
      plannedEndAt: row.planned_end_at,
    }),
  ]);

  const byEquipment = new Map(equipments.map((item) => [item.equipment_id, item]));
  const byMold = new Map(molds.map((item) => [item.mold_id, item]));
  return {
    equipments: equipmentIds.flatMap(({ id, source }) => {
      const item = byEquipment.get(id);
      if (item === undefined) return [];
      return [{
        equipmentId: Number(id),
        equipmentCode: item.equipment_code,
        equipmentName: item.equipment_name,
        productionLineId: item.production_line_id === null ? null : Number(item.production_line_id),
        source,
        inService: !unusable(item),
        busy: checkDoubleBooked([id], row, rivals).length > 0,
      }];
    }),
    molds: moldIds.flatMap(({ id, source }) => {
      const item = byMold.get(id);
      if (item === undefined) return [];
      return [{ moldId: Number(id), moldCode: item.mold_code, moldName: item.mold_name, source, inService: !unusable(item) }];
    }),
    ...crew,
  };
}

/** 같은 출처(기본·매핑) 안에서는 그 공정을 지정한 매핑이 먼저다 — 전개의 자동 배정이 공정 지정을 앞세우므로 1순위를 맞춘다. */
function processFirst(maps: MapRow[]): MapRow[] {
  const rank = (map: MapRow): number => (map.is_default ? 0 : 2) + (map.process_id === null ? 1 : 0);
  return maps.map((map, index) => ({ map, index })).sort((a, b) => rank(a.map) - rank(b.map) || a.index - b.index).map(({ map }) => map);
}

/** 매핑 순서를 지키고, 최근 사용은 매핑에 없는 것만 뒤에 붙인다. */
function candidates(mapped: Candidate[], recent: (bigint | null)[]): Candidate[] {
  const seen = new Set<bigint>();
  const result: Candidate[] = [];
  for (const candidate of [...mapped, ...recent.filter((id) => id !== null).map((id) => ({ id, source: 'RECENT' as const }))]) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    result.push(candidate);
  }
  return result;
}

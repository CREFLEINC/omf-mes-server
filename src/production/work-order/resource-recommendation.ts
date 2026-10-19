import { NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { RivalWindow, checkDoubleBooked } from './validation';

/**
 * 4M 의 설비·금형 추천 — 계약 밖 `GET /production/work-orders/{workOrderId}/resource-recommendations`
 * (`docs/계약-선행-수정항목.md`). 저장하지 않는다. 고르는 것은 현장이다.
 * 순서: 기본 매핑 → 나머지 매핑(우선순위) → 같은 품목·공정의 최근 W/O 가 쓴 것.
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
}

/** 최근 사용은 이만큼의 W/O 만 본다 — 오래된 배정까지 끌어오면 추천이 길어지기만 한다. */
const RECENT_LIMIT = 20;
const IN_SERVICE = 'IN_SERVICE';

interface Candidate { id: bigint; source: RecommendationSource }

export async function recommendResources(prisma: PrismaService, workOrderId: number): Promise<ResourceRecommendations> {
  const row = await prisma.work_order.findUnique({
    where: { work_order_id: workOrderId },
    select: {
      item_id: true, planned_start_at: true, planned_end_at: true,
      routing_operation: { select: { process_id: true, equipment_required: true, mold_required: true } },
      production_plan: { select: { production_order: { select: { plant_id: true } } } },
      production_line: { select: { plant_id: true } },
    },
  });
  if (!row) throw new NotFoundException('없는 작업지시입니다.');
  const operation = row.routing_operation;
  const plantId = row.production_plan?.production_order.plant_id ?? row.production_line?.plant_id;

  const [maps, recent] = await Promise.all([
    prisma.item_resource_map.findMany({
      where: {
        item_id: row.item_id,
        is_active: true,
        ...(plantId === undefined ? {} : { plant_id: plantId }),
        OR: [{ process_id: operation.process_id }, { process_id: null }],
      },
      orderBy: [{ is_default: 'desc' }, { priority_no: 'asc' }, { item_resource_map_id: 'asc' }],
      select: { process_id: true, is_default: true, equipment_id: true, mold_id: true },
    }),
    prisma.work_order.findMany({
      where: {
        work_order_id: { not: BigInt(workOrderId) },
        item_id: row.item_id,
        routing_operation: { process_id: operation.process_id },
        OR: [{ planned_equipment_id: { not: null } }, { planned_mold_id: { not: null } }],
      },
      orderBy: { work_order_id: 'desc' },
      take: RECENT_LIMIT,
      select: { planned_equipment_id: true, planned_mold_id: true },
    }),
  ]);

  // 품목 공통 매핑은 설비·금형이 필요한 공정에서만 추천한다 — 전개의 자동 배정과 같은 규칙.
  const own = (map: (typeof maps)[number], required: boolean): boolean => map.process_id !== null || required;
  const sourceOf = (map: (typeof maps)[number]): RecommendationSource => (map.is_default ? 'DEFAULT' : 'MAPPED');
  const equipmentIds = candidates(
    maps.filter((map) => map.equipment_id !== null && own(map, operation.equipment_required)).map((map) => ({ id: map.equipment_id as bigint, source: sourceOf(map) })),
    recent.map((item) => item.planned_equipment_id),
  );
  const moldIds = candidates(
    maps.filter((map) => map.mold_id !== null && own(map, operation.mold_required)).map((map) => ({ id: map.mold_id as bigint, source: sourceOf(map) })),
    recent.map((item) => item.planned_mold_id),
  );

  const [equipments, molds, rivals] = await Promise.all([
    prisma.equipment.findMany({
      where: { equipment_id: { in: equipmentIds.map((item) => item.id) } },
      select: { equipment_id: true, equipment_code: true, equipment_name: true, production_line_id: true, status_code: true, is_active: true },
    }),
    prisma.mold.findMany({
      where: { mold_id: { in: moldIds.map((item) => item.id) } },
      select: { mold_id: true, mold_code: true, mold_name: true, status_code: true, is_active: true },
    }),
    rivalsOf(prisma, workOrderId, equipmentIds.map((item) => item.id)),
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
        inService: usable(item),
        busy: checkDoubleBooked([id], row, rivals).length > 0,
      }];
    }),
    molds: moldIds.flatMap(({ id, source }) => {
      const item = byMold.get(id);
      if (item === undefined) return [];
      return [{ moldId: Number(id), moldCode: item.mold_code, moldName: item.mold_name, source, inService: usable(item) }];
    }),
  };
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

function rivalsOf(prisma: PrismaService, workOrderId: number, equipmentIds: bigint[]): Promise<RivalWindow[]> | RivalWindow[] {
  if (equipmentIds.length === 0) return [];
  return prisma.work_order.findMany({
    where: {
      work_order_id: { not: BigInt(workOrderId) },
      planned_equipment_id: { in: equipmentIds },
      planned_start_at: { not: null },
      planned_end_at: { not: null },
    },
    select: { planned_equipment_id: true, planned_start_at: true, planned_end_at: true },
  });
}

const usable = (resource: { status_code: string; is_active: boolean }): boolean =>
  resource.status_code === IN_SERVICE && resource.is_active;

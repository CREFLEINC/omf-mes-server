import { FG_LINK_FAILURES, FgResolution, LocationFact, locationFinding } from '../../core/erp-warehouse/fg-location';
import { unusable } from '../../core/work-order';

/**
 * 공정 W/O 의 라인·설비·금형·기본 위치가 확정될 수 있는가 — 제안의 사유와 확정의 400 이 이 한 판정을 쓴다.
 * 갈리면 「확정 가능」으로 보인 제안이 그대로 확정해도 400 이 난다.
 */
export const RESOURCE_CODES = [
  'WORK_ORDER_LINE_REQUIRED',
  'LINE_PLANT_MISMATCH',
  'RESOURCE_PLANT_MISMATCH',
  'EQUIPMENT_NOT_IN_SERVICE',
  'EQUIPMENT_LINE_MISMATCH',
  'MOLD_NOT_IN_SERVICE',
  'WORK_ORDER_LOCATION_REQUIRED',
  'LOCATION_INVALID',
  ...FG_LINK_FAILURES,
  'FG_LOCATION_OUTSIDE_WAREHOUSE',
] as const;
export type ResourceCode = (typeof RESOURCE_CODES)[number];

export interface ResourceRefs {
  lines: ReadonlyMap<bigint, { plant_id: bigint; is_active: boolean }>;
  equipments: ReadonlyMap<bigint, { plant_id: bigint; status_code: string; is_active: boolean; production_line_id: bigint | null }>;
  molds: ReadonlyMap<bigint, { plant_id: bigint; status_code: string; is_active: boolean }>;
  locations: ReadonlyMap<bigint, LocationFact>;
}

export interface WorkOrderResources {
  productionLineId: bigint | null;
  equipmentId: bigint | null;
  moldId: bigint | null;
  defaultWipLocationId: bigint | null;
  defaultFgLocationId: bigint | null;
  defaultScrapLocationId: bigint | null;
}

export interface ResourceFinding {
  code: ResourceCode;
  field: keyof WorkOrderResources | 'plannedEquipmentId' | 'plannedMoldId';
  message: string;
}

const LOCATION_FIELDS = ['defaultWipLocationId', 'defaultFgLocationId', 'defaultScrapLocationId'] as const;

/** `fg` 는 ERP W/O 의 완제품 위치 판정 — 완제품 위치 칸만 이 규칙을 따른다(`core/erp-warehouse/fg-location.ts`). */
export function resourceFindings(plantId: bigint, values: WorkOrderResources, refs: ResourceRefs, fg: FgResolution): ResourceFinding[] {
  const findings: ResourceFinding[] = [];
  const line = values.productionLineId === null ? undefined : refs.lines.get(values.productionLineId);
  if (values.productionLineId === null) {
    findings.push({ code: 'WORK_ORDER_LINE_REQUIRED', field: 'productionLineId', message: '생산 라인이 정해지지 않습니다. 라인을 고르세요.' });
  } else if (line === undefined || line.plant_id !== plantId || !line.is_active) {
    findings.push({ code: 'LINE_PLANT_MISMATCH', field: 'productionLineId', message: '이 ERP W/O 공장의 사용 중인 라인이 아닙니다. 라인을 다시 고르세요.' });
  }

  if (values.equipmentId !== null) {
    const equipment = refs.equipments.get(values.equipmentId);
    if (equipment === undefined || equipment.plant_id !== plantId) {
      findings.push({ code: 'RESOURCE_PLANT_MISMATCH', field: 'plannedEquipmentId', message: '이 공장의 설비가 아닙니다.' });
    } else if (unusable(equipment)) {
      findings.push({ code: 'EQUIPMENT_NOT_IN_SERVICE', field: 'plannedEquipmentId', message: '가동 상태가 아닌 설비입니다.' });
    } else if (equipment.production_line_id !== null && values.productionLineId !== null && equipment.production_line_id !== values.productionLineId) {
      findings.push({ code: 'EQUIPMENT_LINE_MISMATCH', field: 'plannedEquipmentId', message: '고른 라인에 속한 설비가 아닙니다. 설비나 라인을 다시 고르세요.' });
    }
  }

  if (values.moldId !== null) {
    const mold = refs.molds.get(values.moldId);
    if (mold === undefined || mold.plant_id !== plantId) {
      findings.push({ code: 'RESOURCE_PLANT_MISMATCH', field: 'plannedMoldId', message: '이 공장의 금형이 아닙니다.' });
    } else if (unusable(mold)) {
      findings.push({ code: 'MOLD_NOT_IN_SERVICE', field: 'plannedMoldId', message: '가동 상태가 아닌 금형입니다.' });
    }
  }

  for (const field of LOCATION_FIELDS) {
    const locationId = values[field];
    const rule = field === 'defaultFgLocationId' ? fg : undefined;
    // 연결이 실패한 완제품 위치는 비어 있어도 «위치를 고르세요» 가 아니라 연결 실패가 사유다 — 고를 수 있는 위치가 없다.
    if (locationId === null && rule?.kind !== 'LINK_FAILED') {
      findings.push({ code: 'WORK_ORDER_LOCATION_REQUIRED', field, message: '기본 위치가 없습니다. 위치를 고르세요.' });
      continue;
    }
    const found = locationFinding(plantId, locationId === null ? undefined : refs.locations.get(locationId), rule);
    if (found !== null) findings.push({ code: found.code, field, message: found.message });
  }
  return findings;
}

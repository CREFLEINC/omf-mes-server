import { Prisma } from '@prisma/client';

import { arrivalLocationId } from '../material-issue/production-warehouse';
import { matchErpWarehouse } from './erp-warehouse-match';

/**
 * 완제품 위치 판정 — ERP W/O 의 입고 창고(`SL_CD`) → 같은 코드의 MES 창고 → 그 창고의 입고 위치.
 * 직접 계획 확정·계획 제안(조회·확정)·MES W/O 수정이 이 한 판정을 쓴다.
 * ERP 목적지의 의미는 마지막 공정에 있고 중간 공정 값은 배포 필수 검사를 위해 같은 값을 둔다.
 * 연결이 실패하면 라인 기본값으로 대체하지 않는다 — 대체하면 MES 재고가 ERP 가 정한 창고와 어긋난다.
 */

export const FG_LINK_FAILURES = [
  'FG_WAREHOUSE_UNMAPPED',
  'FG_WAREHOUSE_INACTIVE',
  'FG_WAREHOUSE_OTHER_PLANT',
  'FG_WAREHOUSE_NOT_ALLOWED',
] as const;
export type FgLinkFailure = (typeof FG_LINK_FAILURES)[number];

export type FgSource = 'ERP_STORAGE_LOCATION' | 'LINE_DEFAULT' | 'NONE';

export interface FgPlace {
  id: bigint;
  code: string;
  name: string;
}

export type FgResolution =
  | { kind: 'ERP_STORAGE_LOCATION'; erpCode: string; warehouse: FgPlace; location: FgPlace & { isActive: boolean } }
  | { kind: 'NO_STORAGE_CODE' }
  | { kind: 'LINK_FAILED'; erpCode: string; reason: FgLinkFailure };

export interface FgTarget {
  plantId: bigint;
  /** ERP W/O 의 `SL_CD` — 비었으면 null. */
  erpCode: string | null;
}

type Db = Pick<Prisma.TransactionClient, 'warehouse' | 'location' | 'department_production_warehouse'>;

export const fgKey = (target: FgTarget): string => `${target.plantId}:${normalized(target.erpCode) ?? ''}`;
const normalized = (code: string | null): string | null => (code === null || code.trim() === '' ? null : code.trim());

/** 창고 유형이 자재면 완제품 위치로 두지 않는다 — 라인 기본 위치와 같은 규칙(`equipment-group.service.ts`). */
const MATERIAL_WAREHOUSE = 'MATERIAL';

/** 여러 ERP W/O 를 한꺼번에 푼다 — 창고는 한 번에 읽고, 입고 위치는 창고마다 한 번이다. */
export async function resolveFgLocations(db: Db, targets: readonly FgTarget[]): Promise<Map<string, FgResolution>> {
  const codes = [...new Set(targets.map((target) => normalized(target.erpCode)).filter((code): code is string => code !== null))];
  const warehouses = codes.length === 0 ? [] : await db.warehouse.findMany({
    where: { warehouse_code: { in: codes } },
    select: {
      warehouse_id: true, warehouse_code: true, warehouse_name: true, plant_id: true,
      warehouse_type_code: true, is_active: true, is_defect: true, is_external: true,
    },
  });
  const arrivals = new Map<bigint, Promise<FgPlace & { isActive: boolean }>>();
  const arrivalOf = (warehouseId: bigint): Promise<FgPlace & { isActive: boolean }> => {
    const known = arrivals.get(warehouseId);
    if (known !== undefined) return known;
    const found = arrivalLocationId(db, warehouseId).then(async (locationId) => {
      const row = await db.location.findUniqueOrThrow({
        where: { location_id: locationId },
        select: { location_id: true, location_code: true, location_name: true, is_active: true },
      });
      return { id: row.location_id, code: row.location_code, name: row.location_name, isActive: row.is_active };
    });
    arrivals.set(warehouseId, found);
    return found;
  };

  const result = new Map<string, FgResolution>();
  const matched: { key: string; erpCode: string; warehouse: (typeof warehouses)[number] }[] = [];
  for (const target of targets) {
    const erpCode = normalized(target.erpCode);
    const key = fgKey(target);
    if (erpCode === null) {
      result.set(key, { kind: 'NO_STORAGE_CODE' });
      continue;
    }
    const failed = (reason: FgLinkFailure): FgResolution => ({ kind: 'LINK_FAILED', erpCode, reason });
    const match = matchErpWarehouse(erpCode, target.plantId, warehouses);
    if (match.kind === 'UNMAPPED') result.set(key, failed('FG_WAREHOUSE_UNMAPPED'));
    else if (match.kind === 'OTHER_PLANT') result.set(key, failed('FG_WAREHOUSE_OTHER_PLANT'));
    else if (match.kind === 'INACTIVE') result.set(key, failed('FG_WAREHOUSE_INACTIVE'));
    else if (match.warehouse.warehouse_type_code === MATERIAL_WAREHOUSE || match.warehouse.is_defect || match.warehouse.is_external) {
      result.set(key, failed('FG_WAREHOUSE_NOT_ALLOWED'));
    } else matched.push({ key, erpCode, warehouse: match.warehouse });
  }
  // 입고 위치는 창고마다 한 번 — 서로 다른 창고는 함께 읽는다.
  await Promise.all(matched.map(async ({ key, erpCode, warehouse }) => {
    result.set(key, {
      kind: 'ERP_STORAGE_LOCATION',
      erpCode,
      warehouse: { id: warehouse.warehouse_id, code: warehouse.warehouse_code, name: warehouse.warehouse_name },
      location: await arrivalOf(warehouse.warehouse_id),
    });
  }));
  return result;
}

export async function resolveFgLocation(db: Db, target: FgTarget): Promise<FgResolution> {
  return (await resolveFgLocations(db, [target])).get(fgKey(target)) as FgResolution;
}

/** 새 W/O 에 넣을 완제품 위치 — ERP 입고 창고가 정해졌으면 그것, `SL_CD` 가 없으면 라인 기본값, 연결이 실패했으면 없음. */
export function fgLocationOf(fg: FgResolution, lineDefaultLocationId: bigint | null): { source: FgSource; locationId: bigint | null } {
  if (fg.kind === 'ERP_STORAGE_LOCATION') return { source: 'ERP_STORAGE_LOCATION', locationId: fg.location.id };
  if (fg.kind === 'LINK_FAILED' || lineDefaultLocationId === null) return { source: 'NONE', locationId: null };
  return { source: 'LINE_DEFAULT', locationId: lineDefaultLocationId };
}

export function fgLinkMessage(failure: Extract<FgResolution, { kind: 'LINK_FAILED' }>): string {
  const head = `ERP W/O 의 입고 창고(SL_CD ${failure.erpCode})`;
  switch (failure.reason) {
    case 'FG_WAREHOUSE_UNMAPPED':
      return `${head}와 코드가 같은 MES 창고가 없습니다 — ERP 연동 현황의 창고에서 만드세요.`;
    case 'FG_WAREHOUSE_INACTIVE':
      return `${head}의 MES 창고가 꺼져 있습니다 — 창고를 켜세요.`;
    case 'FG_WAREHOUSE_OTHER_PLANT':
      return `${head}의 MES 창고가 이 ERP W/O 와 다른 공장에 있습니다.`;
    case 'FG_WAREHOUSE_NOT_ALLOWED':
      return `${head}의 MES 창고가 자재·불량·외부 창고라 완제품 입고 창고로 쓸 수 없습니다.`;
  }
}

/** 위치 판정에 쓰는 사실 — 질의의 select 와 같이 쓴다. */
export const LOCATION_FACT_SELECT = {
  location_id: true,
  is_active: true,
  warehouse_id: true,
  warehouse: { select: { plant_id: true, warehouse_type_code: true, is_active: true, is_external: true, is_defect: true } },
} as const;
export type LocationFact = Prisma.locationGetPayload<{ select: typeof LOCATION_FACT_SELECT }>;

export type LocationFindingCode = 'LOCATION_INVALID' | 'FG_LOCATION_OUTSIDE_WAREHOUSE' | FgLinkFailure;
export interface LocationFinding {
  code: LocationFindingCode;
  message: string;
}

/**
 * W/O 기본 위치(WIP·완제품·스크랩) 하나의 판정. `fg` 를 주면 완제품 위치 규칙이다 — 입고 창고가 정해진 W/O 는 그 창고 안 위치만,
 * `SL_CD` 가 없으면 외부·불량 창고도 뺀다. 연결이 실패한 W/O 는 어떤 위치도 받지 않는다.
 */
export function locationFinding(plantId: bigint, location: LocationFact | undefined, fg?: FgResolution): LocationFinding | null {
  if (fg?.kind === 'LINK_FAILED') return { code: fg.reason, message: fgLinkMessage(fg) };
  if (
    location === undefined ||
    location.warehouse.plant_id !== plantId ||
    location.warehouse.warehouse_type_code === MATERIAL_WAREHOUSE ||
    !location.is_active ||
    !location.warehouse.is_active
  ) {
    return { code: 'LOCATION_INVALID', message: '이 공장의, 자재창고가 아닌 사용 중인 위치여야 합니다.' };
  }
  if (fg?.kind === 'ERP_STORAGE_LOCATION' && location.warehouse_id !== fg.warehouse.id) {
    return {
      code: 'FG_LOCATION_OUTSIDE_WAREHOUSE',
      message: `완제품 위치는 ERP W/O 의 입고 창고(SL_CD ${fg.erpCode}, ${fg.warehouse.name}) 안의 위치여야 합니다.`,
    };
  }
  if (fg?.kind === 'NO_STORAGE_CODE' && (location.warehouse.is_external || location.warehouse.is_defect)) {
    return { code: 'LOCATION_INVALID', message: '완제품 위치는 외부창고·불량창고의 위치로 둘 수 없습니다.' };
  }
  return null;
}

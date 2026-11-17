import { ERROR_CODE } from '../../common/errors';
import { FgPlace, FgResolution, fgLinkMessage, fgWarehouseRejection } from '../../core/erp-warehouse/fg-location';

/**
 * 완제품 입고 창고 수동 변경(계획 단위) — ERP W/O 의 입고 창고(SL_CD)와 다른 MES 창고를 사람이 알고 고른다.
 * ERP 는 SL_CD 창고로 입고하고 MES 생산입고 송신은 창고를 싣지 않으므로 MES 와 ERP 의 재고 위치가 달라진다.
 * 재검증과 확정이 이 한 판정을 쓴다. 바꾼 창고가 정해지면 그 계획의 공정 W/O 완제품 위치는 그 창고 안이어야 한다(SL_CD 규칙과 같은 모양).
 */

export const FG_OVERRIDE_LINK_FAILED = 'FG_OVERRIDE_LINK_FAILED';

export interface FgOverrideBody {
  warehouseId: number;
  erpMismatchAcknowledged: boolean;
}

export interface WarehouseRef {
  warehouse_id: bigint;
  warehouse_code: string;
  warehouse_name: string;
  plant_id: bigint;
  is_active: boolean;
  warehouse_type_code: string;
  is_defect: boolean;
  is_external: boolean;
}

export interface FgOverrideJudgment {
  /** 본문에 변경이 실렸다. */
  sent: boolean;
  /** 받아들인 창고 — 보내지 않았거나 거부했으면 null. 기록·「다름」 경고·적용 창고는 이것만 본다. */
  applied: FgPlace | null;
  /** 공정 W/O 완제품 위치를 견줄 창고 — 거부했어도 고른 창고가 있으면 그것(SL_CD 창고 밖이라는 오류가 겹치지 않게). 없으면 SL_CD 규칙. */
  locationRule: FgPlace | null;
}

/**
 * 판정한다 — 오류는 `error` 로 모은다.
 * SL_CD 가 없는 ERP W/O 는 바꿀 ERP 창고가 없어 받지 않는다 — 완제품 위치를 이 공장의 쓸 수 있는 창고에서 바로 고르면 되고,
 * 받으면 ERP 와 다르지 않은데 「다름」 기록이 남는다. SL_CD 연결이 실패한 ERP W/O 는 우회하지 않는다 — 창고 연결을 먼저 고친다.
 */
export function judgeFgOverride(
  path: string,
  body: FgOverrideBody | null | undefined,
  fg: FgResolution,
  plantId: bigint,
  warehouses: ReadonlyMap<bigint, WarehouseRef>,
  error: (field: string, code: string, message: string) => void,
): FgOverrideJudgment {
  if (body === undefined || body === null) return { sent: false, applied: null, locationRule: null };
  const rejected = { sent: true, applied: null, locationRule: null };
  const field = `${path}.fgWarehouseOverride`;
  if (fg.kind === 'NO_STORAGE_CODE') {
    error(field, ERROR_CODE.INVALID, 'ERP W/O 에 입고 창고(SL_CD)가 없어 바꿀 것이 없습니다 — 완제품 위치를 그대로 고르세요.');
    return rejected;
  }
  if (fg.kind === 'LINK_FAILED') {
    error(field, FG_OVERRIDE_LINK_FAILED, `${fgLinkMessage(fg)} 연결하지 못한 입고 창고는 다른 창고로 바꿔 넘기지 않습니다.`);
    return rejected;
  }
  let accepted = true;
  if (body.erpMismatchAcknowledged !== true) {
    accepted = false;
    error(`${field}.erpMismatchAcknowledged`, ERROR_CODE.REQUIRED, 'ERP 입고 창고와 MES 입고 창고가 달라진다는 확인에 동의해야 바꿀 수 있습니다.');
  }
  const warehouse = warehouses.get(BigInt(body.warehouseId));
  const rejection = fgWarehouseRejection(plantId, warehouse);
  if (rejection !== null) {
    accepted = false;
    error(`${field}.warehouseId`, rejection, '이 공장의 사용 중인, 자재·불량·외부 창고가 아닌 창고만 완제품 입고 창고로 고를 수 있습니다.');
  } else if (warehouse?.warehouse_id === fg.warehouse.id) {
    accepted = false;
    error(`${field}.warehouseId`, ERROR_CODE.INVALID, `ERP 입고 창고(SL_CD ${fg.erpCode})와 같은 창고입니다 — 바꾸지 않으려면 보내지 마세요.`);
  }
  const place = warehouse === undefined ? null : { id: warehouse.warehouse_id, code: warehouse.warehouse_code, name: warehouse.warehouse_name };
  return { sent: true, applied: accepted ? place : null, locationRule: place };
}

/** 재검증의 계획별 입고 창고 — ERP 원본(SL_CD)과 적용 창고, 그 창고의 입고 위치(공정 W/O 완제품 위치의 기본값). */
export interface FgWarehouseView {
  erpStorageLocationCode: string | null;
  erpWarehouseId: number | null;
  appliedWarehouseId: number | null;
  arrivalLocationId: number | null;
  overridden: boolean;
  differsFromErp: boolean;
}

/**
 * `arrivalOf` 는 창고의 입고 위치(나뉜 창고는 적치 대기, 아니면 창고 전체)를 낸다 — 없으면 null.
 * 보낸 변경을 거부했으면 적용 창고·입고 위치를 비운다 — 확정되지 않을 창고를 적용된 것처럼 보이지 않는다.
 */
export async function fgWarehouseView(
  fg: FgResolution,
  override: Pick<FgOverrideJudgment, 'sent' | 'applied'>,
  arrivalOf: (warehouseId: bigint) => Promise<bigint | null>,
): Promise<FgWarehouseView> {
  const erpWarehouse = fg.kind === 'ERP_STORAGE_LOCATION' ? fg.warehouse : null;
  const applied = override.sent ? override.applied : erpWarehouse;
  const arrival = override.applied !== null ? await arrivalOf(override.applied.id) : !override.sent && fg.kind === 'ERP_STORAGE_LOCATION' ? fg.location.id : null;
  return {
    erpStorageLocationCode: fg.kind === 'NO_STORAGE_CODE' ? null : fg.erpCode,
    erpWarehouseId: erpWarehouse === null ? null : Number(erpWarehouse.id),
    appliedWarehouseId: applied === null ? null : Number(applied.id),
    arrivalLocationId: arrival === null ? null : Number(arrival),
    overridden: override.sent,
    differsFromErp: override.applied !== null && erpWarehouse !== null && override.applied.id !== erpWarehouse.id,
  };
}

/** 사람이 알고 바꿨어도 알린다 — 확정을 막지 않는다. 거부한 변경(`applied` null)은 알리지 않는다 — 그 오류가 이미 있다. */
export function fgOverrideWarning(path: string, fg: FgResolution, override: FgPlace | null): { code: string; field: string; message: string }[] {
  if (override === null || fg.kind !== 'ERP_STORAGE_LOCATION' || override.id === fg.warehouse.id) return [];
  return [{
    code: 'FG_WAREHOUSE_DIFFERS_FROM_ERP',
    field: `${path}.fgWarehouseOverride`,
    message: `입고 창고를 ERP(SL_CD ${fg.erpCode})와 다른 ${override.code}(${override.name})로 바꿨습니다 — ERP 는 ${fg.erpCode} 로 입고합니다.`,
  }];
}

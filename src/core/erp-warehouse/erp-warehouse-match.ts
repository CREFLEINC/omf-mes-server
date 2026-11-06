/**
 * ERP 창고 코드(`SL_CD`)와 같은 코드의 MES 창고를 고른다 — 구매입고 기본값(`receipt-defaults.service.ts`)과 생산 완제품 위치
 * (`fg-location.ts`)가 같은 판정을 쓴다. 갈리면 같은 `SL_CD` 가 구매입고와 생산입고에서 다른 창고로 풀린다.
 * 명칭 유사도로 추정하지 않는다 — 코드가 정확히 같은 창고만 본다.
 */
export interface LinkableWarehouse {
  warehouse_code: string;
  plant_id: bigint;
  is_active: boolean;
}

export type ErpWarehouseMatch<T extends LinkableWarehouse> =
  | { kind: 'MATCHED'; warehouse: T }
  | { kind: 'INACTIVE'; warehouse: T }
  | { kind: 'OTHER_PLANT' }
  | { kind: 'UNMAPPED' };

/**
 * ERP 코드 하나에 MES 창고는 하나다(공장이 달라도 — `erp-warehouse-rules.ts`). 결정 전 자료가 둘이면 «입하 공장의 것»을 고른다.
 * 호출자가 넘긴 후보가 «활성만»이면 꺼진 창고는 `UNMAPPED` 로 나온다 — 구매입고가 그렇게 부른다.
 */
export function matchErpWarehouse<T extends LinkableWarehouse>(
  erpCode: string,
  plantId: bigint,
  candidates: readonly T[],
): ErpWarehouseMatch<T> {
  const sameCode = candidates.filter((row) => row.warehouse_code === erpCode);
  if (sameCode.length === 0) return { kind: 'UNMAPPED' };
  const own = sameCode.find((row) => row.plant_id === plantId);
  if (own === undefined) return { kind: 'OTHER_PLANT' };
  return own.is_active ? { kind: 'MATCHED', warehouse: own } : { kind: 'INACTIVE', warehouse: own };
}

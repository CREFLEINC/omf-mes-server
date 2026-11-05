import { ResourceRefs, WorkOrderResources, resourceFindings } from './resource-rules';

/** 제안의 사유와 확정의 400 이 이 한 판정을 쓴다 — 코드와 칸을 여기서 고정한다. */
describe('resourceFindings — 공정 W/O 의 라인·설비·금형·기본 위치', () => {
  const PLANT = 1n;
  const location = (plant: bigint, type = 'GENERAL', active = true) => ({ is_active: active, warehouse: { plant_id: plant, warehouse_type_code: type, is_active: true } });
  const refs: ResourceRefs = {
    lines: new Map([[10n, { plant_id: PLANT, is_active: true }], [11n, { plant_id: PLANT, is_active: true }], [20n, { plant_id: 2n, is_active: true }]]),
    equipments: new Map([
      [100n, { plant_id: PLANT, status_code: 'IN_SERVICE', is_active: true, production_line_id: 10n }],
      [101n, { plant_id: PLANT, status_code: 'IN_SERVICE', is_active: true, production_line_id: null }],
      [102n, { plant_id: PLANT, status_code: 'DISPOSED', is_active: true, production_line_id: 10n }],
      [103n, { plant_id: 2n, status_code: 'IN_SERVICE', is_active: true, production_line_id: null }],
    ]),
    molds: new Map([[200n, { plant_id: PLANT, status_code: 'IN_SERVICE', is_active: true }], [201n, { plant_id: PLANT, status_code: 'IN_SERVICE', is_active: false }]]),
    locations: new Map([[1n, location(PLANT)], [2n, location(PLANT, 'MATERIAL')], [3n, location(2n)], [4n, location(PLANT, 'GENERAL', false)]]),
  };
  const ok: WorkOrderResources = {
    productionLineId: 10n, equipmentId: 100n, moldId: 200n, defaultWipLocationId: 1n, defaultFgLocationId: 1n, defaultScrapLocationId: 1n,
  };
  const codes = (override: Partial<WorkOrderResources>) => resourceFindings(PLANT, { ...ok, ...override }, refs).map((finding) => [finding.field, finding.code]);

  it('맞으면 아무것도 없다 — 라인이 없는 설비는 어느 라인에도 된다', () => {
    expect(codes({})).toEqual([]);
    expect(codes({ equipmentId: 101n, productionLineId: 11n })).toEqual([]);
  });

  it('라인 — 없으면 REQUIRED, 다른 공장·없는 라인은 LINE_PLANT_MISMATCH', () => {
    expect(codes({ productionLineId: null, equipmentId: null })).toEqual([['productionLineId', 'WORK_ORDER_LINE_REQUIRED']]);
    expect(codes({ productionLineId: 20n, equipmentId: null })).toEqual([['productionLineId', 'LINE_PLANT_MISMATCH']]);
  });

  it('설비 — 다른 라인 소속·가동 아님·다른 공장', () => {
    expect(codes({ productionLineId: 11n })).toEqual([['plannedEquipmentId', 'EQUIPMENT_LINE_MISMATCH']]);
    expect(codes({ equipmentId: 102n })).toEqual([['plannedEquipmentId', 'EQUIPMENT_NOT_IN_SERVICE']]);
    expect(codes({ equipmentId: 103n })).toEqual([['plannedEquipmentId', 'RESOURCE_PLANT_MISMATCH']]);
  });

  it('금형 — 사용 중이 아니면 MOLD_NOT_IN_SERVICE', () => {
    expect(codes({ moldId: 201n })).toEqual([['plannedMoldId', 'MOLD_NOT_IN_SERVICE']]);
  });

  it('기본 위치 — 비면 REQUIRED, 자재창고·다른 공장·사용 중지는 LOCATION_INVALID', () => {
    expect(codes({ defaultWipLocationId: null, defaultFgLocationId: 2n, defaultScrapLocationId: 3n })).toEqual([
      ['defaultWipLocationId', 'WORK_ORDER_LOCATION_REQUIRED'],
      ['defaultFgLocationId', 'LOCATION_INVALID'],
      ['defaultScrapLocationId', 'LOCATION_INVALID'],
    ]);
    expect(codes({ defaultWipLocationId: 4n })).toEqual([['defaultWipLocationId', 'LOCATION_INVALID']]);
  });
});

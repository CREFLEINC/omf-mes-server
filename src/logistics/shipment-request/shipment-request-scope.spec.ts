import {
  lineInTerminalScopeSql,
  lineInTerminalScopeWhere,
  lineOutOfScopeReason,
  requestInBusinessUnit,
  requestInBusinessUnitSql,
  requestInBusinessUnitWhere,
  requestPickableByTerminalSql,
  requestPickableByTerminalWhere,
} from './shipment-request-scope';

const P1 = 1n;
const P2 = 2n;
const A = 10n;
const C = 30n;
const pda = { plantId: P1, warehouseId: null };
const pdaA = { plantId: P1, warehouseId: A };

function binder() {
  const params: unknown[] = [];
  return { params, bind: (value: unknown) => `$${params.push(value)}` };
}

describe('shipment-request-scope — 피처 012 범위 규칙 한 곳(R-2)', () => {
  describe('lineOutOfScopeReason — 줄 범위(PDA)', () => {
    it('US2-1 줄 창고의 공장이 단말 공장이면 범위 안', () => {
      expect(lineOutOfScopeReason({ warehouseId: A, warehousePlantId: P1, requestPlantId: null }, pda)).toBeNull();
    });

    it('US2-2 줄 창고가 다른 공장이면 OTHER_PLANT', () => {
      expect(lineOutOfScopeReason({ warehouseId: 20n, warehousePlantId: P2, requestPlantId: null }, pda)).toBe('OTHER_PLANT');
    });

    it('US2-6 창고가 지정된 단말은 줄 창고 = 단말 창고만 — 같은 공장 다른 창고는 OTHER_WAREHOUSE', () => {
      expect(lineOutOfScopeReason({ warehouseId: A, warehousePlantId: P1, requestPlantId: null }, pdaA)).toBeNull();
      expect(lineOutOfScopeReason({ warehouseId: C, warehousePlantId: P1, requestPlantId: null }, pdaA)).toBe('OTHER_WAREHOUSE');
      expect(lineOutOfScopeReason({ warehouseId: 20n, warehousePlantId: P2, requestPlantId: null }, pdaA)).toBe('OTHER_PLANT');
    });

    it('US6-2·FR-027 창고 없는 옛 줄은 지시서 이행 공장 = 단말 공장(창고 지정 단말도 공장만 본다)', () => {
      expect(lineOutOfScopeReason({ warehouseId: null, warehousePlantId: null, requestPlantId: P1 }, pda)).toBeNull();
      expect(lineOutOfScopeReason({ warehouseId: null, warehousePlantId: null, requestPlantId: P1 }, pdaA)).toBeNull();
      expect(lineOutOfScopeReason({ warehouseId: null, warehousePlantId: null, requestPlantId: P2 }, pda)).toBe('OTHER_PLANT');
      expect(lineOutOfScopeReason({ warehouseId: null, warehousePlantId: null, requestPlantId: null }, pda)).toBe('OTHER_PLANT');
    });
  });

  describe('requestInBusinessUnit — 사업부 범위(POP)', () => {
    const X = 100n;
    it('US3-1 지시서 사업부 = 단말 공장 사업부면 공장이 달라도 범위 안, 다른 사업부는 밖', () => {
      expect(requestInBusinessUnit({ businessUnitId: X, fulfillmentPlantId: null }, { plantId: P2, businessUnitId: X })).toBe(true);
      expect(requestInBusinessUnit({ businessUnitId: X, fulfillmentPlantId: null }, { plantId: 3n, businessUnitId: 200n })).toBe(false);
    });

    it('US6-3·FR-026 사업부 없는 옛 지시서는 이행 공장 = 단말 공장만', () => {
      expect(requestInBusinessUnit({ businessUnitId: null, fulfillmentPlantId: 9n }, { plantId: 9n, businessUnitId: null })).toBe(true);
      expect(requestInBusinessUnit({ businessUnitId: null, fulfillmentPlantId: 9n }, { plantId: P1, businessUnitId: X })).toBe(false);
    });

    it('US6-3 사업부 없는 공장의 단말은 사업부 지시서를 열지 않는다', () => {
      expect(requestInBusinessUnit({ businessUnitId: X, fulfillmentPlantId: null }, { plantId: 9n, businessUnitId: null })).toBe(false);
    });
  });

  describe('Prisma 조건', () => {
    it('FR-010 줄 범위 — 창고 있는 줄은 그 창고 공장(단말 창고), 옛 줄은 지시서 이행 공장', () => {
      expect(lineInTerminalScopeWhere(pda)).toEqual({ OR: [
        { warehouse: { plant_id: P1 } },
        { warehouse_id: null, shipment_request: { fulfillment_plant_id: P1 } },
      ] });
      expect(lineInTerminalScopeWhere(pdaA)).toEqual({ OR: [
        { warehouse: { plant_id: P1 }, warehouse_id: A },
        { warehouse_id: null, shipment_request: { fulfillment_plant_id: P1 } },
      ] });
      expect(requestPickableByTerminalWhere(pda)).toEqual({ shipment_request_line: { some: lineInTerminalScopeWhere(pda) } });
    });

    it('US3-1·US6-3 사업부 범위 — 사업부 지시서 또는 사업부 없는 옛 지시서의 이행 공장', () => {
      expect(requestInBusinessUnitWhere(P1, 100n)).toEqual({ OR: [
        { business_unit_id: 100n }, { business_unit_id: null, fulfillment_plant_id: P1 },
      ] });
      expect(requestInBusinessUnitWhere(9n, null)).toEqual({ business_unit_id: null, fulfillment_plant_id: 9n });
    });
  });

  describe('SQL 조각', () => {
    it('FR-010 줄 범위 SQL — 창고 지정 단말이면 줄 창고 조건을 더하고 값은 자리표로만 싣는다', () => {
      const plain = binder();
      expect(lineInTerminalScopeSql('l', 'sr', pda, plain.bind)).not.toContain('l.warehouse_id = $');
      expect(plain.params).toEqual([P1]);
      const assigned = binder();
      const sql = lineInTerminalScopeSql('l', 'sr', pdaA, assigned.bind);
      expect(sql).toContain('l.warehouse_id = $2::bigint');
      expect(sql).toContain('l.warehouse_id IS NULL AND sr.fulfillment_plant_id = $1::bigint');
      expect(assigned.params).toEqual([P1, A]);
    });

    it('US2-1 지시서 SQL 은 범위 안 줄이 하나라도 있는 EXISTS 다', () => {
      const { bind } = binder();
      expect(requestPickableByTerminalSql('sr', pda, bind)).toMatch(/^EXISTS \(SELECT 1 FROM logistics\.shipment_request_line scl/);
    });

    it('US3-1 사업부 SQL 은 단말 공장의 사업부와 옛 지시서 이행 공장을 같은 자리표로 본다', () => {
      const { bind, params } = binder();
      const sql = requestInBusinessUnitSql('sr', P1, bind);
      expect(sql).toContain('sr.business_unit_id = (SELECT sp.business_unit_id FROM mdm.plant sp WHERE sp.plant_id = $1::bigint)');
      expect(sql).toContain('sr.business_unit_id IS NULL AND sr.fulfillment_plant_id = $1::bigint');
      expect(params).toEqual([P1]);
    });
  });
});

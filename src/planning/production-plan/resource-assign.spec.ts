import { DefaultMap, OperationNeed, assignResources, toDefaultMap } from './resource-assign';

const injection: OperationNeed = { routingOperationId: 101n, processId: 1n, equipmentRequired: true, moldRequired: true };
const assembly: OperationNeed = { routingOperationId: 102n, processId: 2n, equipmentRequired: false, moldRequired: false };
const map = (overrides: Partial<DefaultMap>): DefaultMap => ({ processId: null, equipmentId: null, equipmentLineId: null, moldId: null, ...overrides });

describe('assignResources — 전개의 설비·금형 자동 배정(순수)', () => {
  it('품목 공통 매핑은 금형·설비가 필요한 공정에만 붙는다', () => {
    const result = assignResources([injection, assembly], [map({ equipmentId: 51n, equipmentLineId: 22n, moldId: 61n })]);

    expect(result.get(101n)).toEqual({ equipmentId: 51n, moldId: 61n, equipmentLineId: 22n });
    expect(result.get(102n)).toEqual({ equipmentId: null, moldId: null, equipmentLineId: null });
  });

  it('공정을 지정한 매핑이 품목 공통 매핑을 이기고, 필요 표시가 없어도 붙는다', () => {
    const result = assignResources(
      [injection, assembly],
      [map({ moldId: 61n }), map({ processId: 1n, moldId: 62n }), map({ processId: 2n, equipmentId: 52n })],
    );

    expect(result.get(101n)?.moldId).toBe(62n);
    expect(result.get(102n)).toEqual({ equipmentId: 52n, moldId: null, equipmentLineId: null });
  });

  it('매핑이 없으면 아무것도 배정하지 않는다', () => {
    expect(assignResources([injection], []).get(101n)).toEqual({ equipmentId: null, moldId: null, equipmentLineId: null });
  });

  it('공정 지정 매핑에 빈 칸이 있으면 그 칸만 품목 공통 매핑에서 채운다', () => {
    const result = assignResources([injection], [map({ processId: 1n, moldId: 62n }), map({ equipmentId: 51n, equipmentLineId: 22n, moldId: 61n })]);

    expect(result.get(101n)).toEqual({ equipmentId: 51n, moldId: 62n, equipmentLineId: 22n });
  });

  it('품목 공통 매핑은 필요한 첫 공정에만 준다 — 같은 설비·금형이 같은 시간대 W/O 여럿에 겹치지 않게', () => {
    const second: OperationNeed = { routingOperationId: 103n, processId: 3n, equipmentRequired: true, moldRequired: true };
    const result = assignResources([assembly, injection, second], [map({ equipmentId: 51n, moldId: 61n })]);

    expect(result.get(101n)).toMatchObject({ equipmentId: 51n, moldId: 61n });
    expect(result.get(103n)).toMatchObject({ equipmentId: null, moldId: null });
  });

  it('첫 필요 공정이 자기 매핑으로 채웠으면 품목 공통 매핑은 뒤 공정에 주지 않는다', () => {
    const second: OperationNeed = { routingOperationId: 103n, processId: 3n, equipmentRequired: true, moldRequired: true };
    const result = assignResources([injection, second], [map({ processId: 1n, equipmentId: 52n }), map({ equipmentId: 51n, moldId: 61n })]);

    expect(result.get(101n)).toMatchObject({ equipmentId: 52n, moldId: 61n });
    expect(result.get(103n)).toMatchObject({ equipmentId: null, moldId: null });
  });
});

describe('toDefaultMap — 가동 상태가 아닌 자원은 배정 후보에서 지운다', () => {
  const equipment = { equipment_id: 51n, status_code: 'IN_SERVICE', is_active: true, production_line_id: 22n };
  const mold = { mold_id: 61n, status_code: 'IN_SERVICE', is_active: true };

  it('가동 중이면 그대로 싣는다', () => {
    expect(toDefaultMap({ process_id: null, equipment, mold })).toEqual({ processId: null, equipmentId: 51n, equipmentLineId: 22n, moldId: 61n });
  });

  it('폐기·미사용 설비·금형은 비우고 설비의 라인도 비운다', () => {
    expect(toDefaultMap({ process_id: 1n, equipment: { ...equipment, status_code: 'DISPOSED' }, mold: { ...mold, is_active: false } }))
      .toEqual({ processId: 1n, equipmentId: null, equipmentLineId: null, moldId: null });
  });
});

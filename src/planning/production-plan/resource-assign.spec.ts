import { DefaultMap, OperationNeed, assignResources } from './resource-assign';

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
});

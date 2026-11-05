import { chooseRouting, defaultBomOf, masterReasonsOf } from './master-choice';

describe('master-choice — 계획이 쓸 BOM·Routing', () => {
  const ops = new Map([[11n, 2], [12n, 0]]);

  it('기본 BOM 은 하나뿐일 때만 정해진다', () => {
    expect(defaultBomOf([1n])).toBe(1n);
    expect(defaultBomOf([])).toBeNull();
    expect(defaultBomOf([1n, 2n])).toBeNull();
  });

  it('쓸 수 있는 Routing 이 하나면 그것, 여럿이면 기본 하나 — 아니면 사유', () => {
    expect(chooseRouting([{ routingId: 11n, isDefault: false }])).toEqual({ routingId: 11n });
    expect(chooseRouting([{ routingId: 11n, isDefault: false }, { routingId: 12n, isDefault: true }])).toEqual({ routingId: 12n });
    expect(chooseRouting([])).toEqual({ routingId: null, reason: 'ROUTING_REQUIRED' });
    expect(chooseRouting([{ routingId: 11n, isDefault: true }, { routingId: 12n, isDefault: true }])).toEqual({ routingId: null, reason: 'ROUTING_DEFAULT_REQUIRED' });
  });

  it('고른 Routing 에 공정이 없으면 ROUTING_OPERATION_REQUIRED — 목록과 제안이 같은 사유를 낸다', () => {
    expect(masterReasonsOf([1n], [{ routingId: 11n, isDefault: false }], ops)).toEqual([]);
    expect(masterReasonsOf([1n], [{ routingId: 12n, isDefault: false }], ops)).toEqual(['ROUTING_OPERATION_REQUIRED']);
    expect(masterReasonsOf([], [], ops)).toEqual(['BOM_DEFAULT_REQUIRED', 'ROUTING_REQUIRED']);
  });
});

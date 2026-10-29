import { BACKWARD_STAGES, FORWARD_STAGES, stageCaseSql, stageCounts } from './flow-stage';


describe('LOT 추적 단계', () => {
  it('현재 단계는 가장 멀리 간 단계부터 본다 — 아무것도 없으면 첫 단계', () => {
    expect(stageCaseSql(BACKWARD_STAGES, { PRODUCTION_RECEIVED: 'r', PACKED: 'p', SHIPPED: 's' }))
      .toBe("CASE WHEN s > 0 THEN 'SHIPPED' WHEN p > 0 THEN 'PACKED' WHEN r > 0 THEN 'PRODUCTION_RECEIVED' ELSE 'PRODUCED' END");
    expect(stageCaseSql(FORWARD_STAGES, { CONSUMED: 'c', PRODUCED: 'd', PRODUCTION_RECEIVED: 'r', PACKED: 'p', SHIPPED: 's' }))
      .toMatch(/^CASE WHEN s > 0 THEN 'SHIPPED' .* WHEN c > 0 THEN 'CONSUMED' ELSE 'RECEIVED' END$/);
  });

  it('단계별 건수는 없는 단계도 0 으로 싣는다', () => {
    expect(stageCounts(BACKWARD_STAGES, [{ stage: 'SHIPPED', count: 2n }])).toEqual({ PRODUCED: 0, PRODUCTION_RECEIVED: 0, PACKED: 0, SHIPPED: 2 });
  });
});

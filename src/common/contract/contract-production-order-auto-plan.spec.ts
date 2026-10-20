/**
 * ⭐⭐ **계약 사본에 «우리가» 먼저 적은 ERP W/O 자동 계획을 지킨다**(장부 P-67).
 *
 * 다음 `contracts:update` 가 정본에 없는 이 편집을 조용히 덮으면 `@Contract('POST
 * /planning/production-orders/{productionOrderId}:auto-plan')` 가 팬텀이 되고, 목록의 `autoPlanStatus`
 * 질의가 계약 가드에서 빠진다. 하나라도 사라지면 당기는 그 순간 여기가 빨개진다.
 *
 * ⭐ 지우는 조건 — 설계팀이 정본에 같은 규격을 실어 오면. ⛔ 빨갛다고 지우지 마라.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONTRACT = join(__dirname, '../../../contracts/production-02생산실행.json');

describe('계약 사본 — 선반영한 ERP W/O 자동 계획 (P-67)', () => {
  const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as {
    paths: Record<string, Record<string, { responses?: Record<string, unknown>; parameters?: { name?: string }[] }>>;
    components: { schemas: Record<string, { required?: string[]; properties?: Record<string, unknown>; enum?: string[] }> };
  };

  it('⛔ POST …:auto-plan 이 있고 403 을 선언한다 — 없으면 권한 가드가 안 본다', () => {
    const post = contract.paths['/planning/production-orders/{productionOrderId}:auto-plan']?.post;
    expect(Object.keys(post?.responses ?? {}).sort()).toEqual(['200', '400', '403', '404', '409']);
  });

  it('⛔ 목록 질의 autoPlanStatus 와 ProductionOrder.autoPlan 이 있다', () => {
    const names = (contract.paths['/planning/production-orders']?.get?.parameters ?? []).map((parameter) => parameter.name);
    expect(names).toContain('autoPlanStatus');
    expect(Object.keys(contract.components.schemas.ProductionOrder?.properties ?? {})).toContain('autoPlan');
  });

  it('⛔ 결과·사유 스키마의 칸이 그대로다', () => {
    expect([...(contract.components.schemas.ProductionOrderAutoPlanResult?.required ?? [])].sort()).toEqual(
      ['outcome', 'productionOrderId', 'productionPlanId', 'reasons'],
    );
    expect(contract.components.schemas.AutoPlanReason?.enum).toEqual(
      ['BOM_MISSING', 'ROUTING_MISSING', 'ROUTING_AMBIGUOUS', 'LINE_UNKNOWN', 'PLAN_NOT_CONFIRMED', 'QTY_REMAINING'],
    );
  });
});

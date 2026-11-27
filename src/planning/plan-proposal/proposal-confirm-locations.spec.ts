import { Prisma } from '@prisma/client';
import { judgeConfirm, ProposalConfirmBody } from './proposal-confirm-check';
import { Proposal } from './proposal-builder';
import { ProposalFacts } from './proposal-reader';

/** DB 없이 실제 제안 확정·재검증 공용 판정을 실행한다. */
describe('제안 확정 — 라인 WIP 자동 적용과 스크랩 선택값', () => {
  async function check(wip: bigint | null, sentWip?: number) {
    const plan = { key: 'new-1', bom: { id: 1n, code: 'SYN-BOM', version: 1 }, planDate: '2026-12-01', planDateSourceCode: 'SYSTEM' };
    const proposal = { order: { plant_id: 1n, item_id: 1n, plant: { timezone_code: 'Asia/Ho_Chi_Minh' } }, plans: [plan], drafts: [], newPlanTemplate: plan, fg: { kind: 'NO_STORAGE_CODE' } } as unknown as Proposal;
    const facts = { usableRoutings: new Map([['1:1', [{ routing_id: 1n }]]]), shifts: new Map(), operations: new Map([[1n, [{ routing_operation_id: 1n }]]]), dependencies: new Map() } as unknown as ProposalFacts;
    const body = { basis: {}, plans: [{ proposalPlanKey: 'new-1', planDate: '2026-12-01', planDateSourceCode: 'SYSTEM', plannedQty: 10, bomId: 1, routingId: 1, plannedLineId: 1, workOrders: [{ routingOperationId: 1, productionLineId: 1, defaultFgLocationId: 20, defaultWipLocationId: sentWip, plannedTimeSourceCode: 'SYSTEM' }] }] } as ProposalConfirmBody;
    const client = {
      production_line: { findMany: async () => [{ production_line_id: 1n, plant_id: 1n, is_active: true, default_wip_location_id: wip, default_scrap_location_id: null }] },
      equipment: { findMany: async () => [] }, mold: { findMany: async () => [] }, worker: { findMany: async () => [] }, warehouse: { findMany: async () => [] },
      location: { findMany: async () => [10n, 20n].map((id) => ({ location_id: id, warehouse_id: 1n, is_active: true, warehouse: { plant_id: 1n, is_active: true, warehouse_type_code: 'GENERAL', is_external: false, is_defect: false } })) },
    } as unknown as Prisma.TransactionClient;
    return judgeConfirm(client, proposal, facts, body, new Date('2026-11-18T00:00:00Z'));
  }
  it('WIP·스크랩을 보내지 않아도 라인 WIP를 적용하고 확정한다', async () => {
    const result = await check(10n);
    expect(result.errors).toEqual([]);
    expect(result.resolved[0].supplements.get(1n)).toMatchObject({ defaultWipLocationId: 10n, defaultScrapLocationId: null });
  });
  it('오래된 화면의 WIP 입력보다 현재 생산 라인의 기본값을 적용한다', async () => {
    const result = await check(10n, 999);
    expect(result.errors).toEqual([]);
    expect(result.resolved[0].supplements.get(1n)?.defaultWipLocationId).toBe(10n);
  });
  it('라인 기본 WIP가 없어도 생산품 입고 위치가 있으면 확정한다', async () => {
    const result = await check(null, 999);
    expect(result.errors).toEqual([]);
    expect(result.resolved[0].supplements.get(1n)).toMatchObject({ defaultWipLocationId: null, defaultFgLocationId: 20n });
  });
});

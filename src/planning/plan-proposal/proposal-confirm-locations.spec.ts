import { Prisma } from '@prisma/client';
import { judgeConfirm, ProposalConfirmBody } from './proposal-confirm-check';
import { Proposal } from './proposal-builder';
import { ProposalFacts } from './proposal-reader';

/** DB 없이 실제 제안 확정·재검증 공용 판정을 실행한다. */
describe('제안 확정 — 생산품 입고 위치 저장', () => {
  async function check(wip: bigint | null) {
    const plan = { key: 'new-1', bom: { id: 1n, code: 'SYN-BOM', version: 1 }, planDate: '2026-12-01', planDateSourceCode: 'SYSTEM' };
    const proposal = { order: { plant_id: 1n, item_id: 1n, plant: { timezone_code: 'Asia/Ho_Chi_Minh' } }, plans: [plan], drafts: [], newPlanTemplate: plan, fg: { kind: 'NO_STORAGE_CODE' } } as unknown as Proposal;
    const facts = { usableRoutings: new Map([['1:1', [{ routing_id: 1n }]]]), shifts: new Map(), operations: new Map([[1n, [{ routing_operation_id: 1n }]]]), dependencies: new Map() } as unknown as ProposalFacts;
    const body = { basis: {}, plans: [{ proposalPlanKey: 'new-1', planDate: '2026-12-01', planDateSourceCode: 'SYSTEM', plannedQty: 10, bomId: 1, routingId: 1, plannedLineId: 1, workOrders: [{ routingOperationId: 1, productionLineId: 1, defaultFgLocationId: 20, plannedTimeSourceCode: 'SYSTEM' }] }] } as ProposalConfirmBody;
    const client = {
      production_line: { findMany: async () => [{ production_line_id: 1n, plant_id: 1n, is_active: true, default_wip_location_id: wip, default_scrap_location_id: null }] },
      equipment: { findMany: async () => [] }, mold: { findMany: async () => [] }, worker: { findMany: async () => [] }, warehouse: { findMany: async () => [] },
      location: { findMany: async () => [10n, 20n].map((id) => ({ location_id: id, warehouse_id: 1n, is_active: true, warehouse: { plant_id: 1n, is_active: true, warehouse_type_code: 'GENERAL', is_external: false, is_defect: false } })) },
    } as unknown as Prisma.TransactionClient;
    return judgeConfirm(client, proposal, facts, body, new Date('2026-11-18T00:00:00Z'));
  }
  it.each([null, 10n])('기존 라인 WIP 설정과 무관하게 생산품 입고 위치만 확정한다 (%s)', async (legacyWip) => {
    const result = await check(legacyWip);
    expect(result.errors).toEqual([]);
    const supplement = result.resolved[0].supplements.get(1n);
    expect(supplement).toMatchObject({ defaultFgLocationId: 20n });
    expect(supplement).not.toHaveProperty('defaultWipLocationId');
  });
});

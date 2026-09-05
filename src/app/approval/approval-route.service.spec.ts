import { PrismaService } from '../../prisma/prisma.service';
import { ApprovalRouteService } from './approval-route.service';

type Args = Record<string, unknown>;

const routeRow = (id: bigint, version: number, overrides: Args = {}): Args => ({
  approval_route_id: id,
  approval_type_code: 'GOODS_ISSUE_DISPOSAL',
  business_unit_id: null,
  min_value: null,
  max_value: null,
  is_active: true,
  version_no: version,
  ...overrides,
});

/** `get()` 하나가 필요로 하는 만큼만 답하는 최소 prisma 스텁. */
function stub(overrides: { route?: Args | null; steps?: Args[]; requestCounts?: Record<string, number> }) {
  const prisma = {
    approval_route: {
      findUnique: async () => overrides.route ?? null,
    },
    approval_route_step: {
      count: async () => (overrides.steps ?? []).length,
    },
    approval_request: {
      count: async ({ where }: { where: { approval_type_code: string } }) =>
        overrides.requestCounts?.[where.approval_type_code] ?? 0,
    },
  };
  return prisma as unknown as PrismaService;
}

describe('ApprovalRouteService', () => {
  it('⚠ inProgressCount 는 유형 축 근사다 — 사업부 지정본과 공통본이 같은 수를 본다 (설계 미정 — 문의 018)', async () => {
    const specific = routeRow(1n, 1, { business_unit_id: 5 });
    const common = routeRow(2n, 1, { business_unit_id: null });
    const specificPrisma = stub({ route: specific, requestCounts: { GOODS_ISSUE_DISPOSAL: 3 } });
    const commonPrisma = stub({ route: common, requestCounts: { GOODS_ISSUE_DISPOSAL: 3 } });

    const a = await new ApprovalRouteService(specificPrisma).get(1);
    const b = await new ApprovalRouteService(commonPrisma).get(2);

    // 셀 연결 칸이 없어 approval_type_code 로만 센다 — 서로 다른 결재선인데 같은
    // 수를 본다. 되돌릴 자리: I-2 에서 approval_route_id 를 더할지는 문의 018.
    expect(a.route.inProgressCount).toBe(3);
    expect(b.route.inProgressCount).toBe(3);
  });
});

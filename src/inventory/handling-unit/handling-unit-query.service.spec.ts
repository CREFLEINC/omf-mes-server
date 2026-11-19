import { PrismaService } from '../../prisma/prisma.service';
import { HandlingUnitQueryService } from './handling-unit-query.service';

type Args = Record<string, unknown>;

/** `list()` 가 넘긴 `where` 와 발행 기록 조회 조건을 그대로 잡는 최소 스텁. */
function stub(issuedTargetIds: bigint[]) {
  const calls: { where?: Args; issueWhere?: Args } = {};
  const prisma = {
    handling_unit: {
      findMany: async ({ where }: { where: Args }) => {
        calls.where = where;
        return [];
      },
      count: async () => 0,
    },
    document_issue_log: {
      findMany: async ({ where }: { where: Args }) => {
        calls.issueWhere = where;
        return issuedTargetIds.map((target_id) => ({ target_id }));
      },
    },
  };
  return { service: new HandlingUnitQueryService(prisma as unknown as PrismaService), calls };
}

describe('HandlingUnitQueryService.list — labelIssued (omf-all-around#327)', () => {
  it('true 는 포장 라벨 발행 기록이 있는 포장만', async () => {
    const { service, calls } = stub([5n, 6n]);
    await service.list({ labelIssued: true });
    expect(calls.issueWhere).toEqual({ document_type_code: 'PACKING_LABEL', target_type_code: 'HANDLING_UNIT' });
    expect(calls.where).toMatchObject({ handling_unit_id: { in: [5n, 6n] } });
  });

  it('false 는 발행 기록이 없는 포장만', async () => {
    const { service, calls } = stub([5n]);
    await service.list({ labelIssued: false });
    expect(calls.where).toMatchObject({ handling_unit_id: { notIn: [5n] } });
  });

  it('생략하면 발행 기록을 읽지도 거르지도 않는다', async () => {
    const { service, calls } = stub([5n]);
    await service.list({});
    expect(calls.issueWhere).toBeUndefined();
    expect(calls.where).not.toHaveProperty('handling_unit_id');
  });
});

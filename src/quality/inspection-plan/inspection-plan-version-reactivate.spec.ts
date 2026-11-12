import { ContractException, ERROR_CODE } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { InspectionPlanVersionService } from './inspection-plan-version.service';

/** 버전 재사용(omf-all-around#258) — 사용 중지(OBSOLETE) → 확정. 다른 버전은 건드리지 않는다. */
function harness(statusCode: string, newer: { plan_version: number } | null = null, changed = 1) {
  const update = jest.fn().mockResolvedValue({ count: changed });
  const audit = jest.fn().mockResolvedValue(undefined);
  const tx = {
    inspection_plan_version: { updateMany: update },
    audit_event: { create: audit },
    $queryRaw: jest.fn().mockResolvedValue(newer === null ? [] : [newer]),
  };
  const prisma = {
    inspection_plan_version: {
      findFirst: jest.fn().mockResolvedValue({
        inspection_plan_version_id: 7n,
        inspection_plan_id: 3n,
        plan_version: 1,
        status_code: statusCode,
      }),
    },
    $transaction: jest.fn(async (run: (client: typeof tx) => unknown) => run(tx)),
  } as unknown as PrismaService;
  return { service: new InspectionPlanVersionService(prisma), update, audit };
}

describe('검사기준 버전 재사용', () => {
  it('사용 중지된 버전을 확정으로 돌리고 이력을 남긴다', async () => {
    const { service, update, audit } = harness('OBSOLETE');

    await expect(service.reactivate(7, 3)).resolves.toBe(7);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { inspection_plan_version_id: 7, status_code: 'OBSOLETE' },
      data: { status_code: 'CONFIRMED', version_no: { increment: 1 } },
    });
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it.each(['DRAFT', 'CONFIRMED'])('%s 버전은 재사용할 수 없다 — 400 STATE_LOCKED', async (statusCode) => {
    const { service, update } = harness(statusCode);

    const error = await service.reactivate(7, 3).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ContractException);
    expect(JSON.stringify((error as ContractException).getResponse())).toContain(ERROR_CODE.STATE_LOCKED);
    expect(update).not.toHaveBeenCalled();
  });

  /* PR #1025 리뷰 — 검사 의뢰는 가장 높은 확정 판만 쓴다. */
  it('더 새 확정 버전이 있으면 400 STATE_LOCKED 이고 그 버전 번호를 알린다', async () => {
    const { service, update } = harness('OBSOLETE', { plan_version: 2 });

    const error = await service.reactivate(7, 3).catch((caught: unknown) => caught);

    expect((error as ContractException).errors[0]).toMatchObject({ code: ERROR_CODE.STATE_LOCKED });
    expect((error as ContractException).errors[0].message).toContain('버전 2');
    expect(update).not.toHaveBeenCalled();
  });

  it('읽은 뒤 다른 요청이 먼저 상태를 바꿨으면 400 STATE_LOCKED 이고 이력을 남기지 않는다', async () => {
    const { service, audit } = harness('OBSOLETE', null, 0);

    const error = await service.reactivate(7, 3).catch((caught: unknown) => caught);

    expect((error as ContractException).errors[0]).toMatchObject({ code: ERROR_CODE.STATE_LOCKED });
    expect(audit).not.toHaveBeenCalled();
  });
});

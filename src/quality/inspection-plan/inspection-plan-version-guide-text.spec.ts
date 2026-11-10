import { ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { InspectionPlanVersionService, VersionWrite } from './inspection-plan-version.service';

jest.mock('../../common/master', () => ({
  ...jest.requireActual('../../common/master'),
  assertCodeValues: jest.fn().mockResolvedValue(undefined),
}));

/** omf-all-around#252 — 검사 기준 버전별 안내 문구(한국어 · 베트남어). */
describe('검사 기준 버전 안내 문구', () => {
  const baseRow = (over: Partial<Record<string, unknown>> = {}) =>
    ({
      inspection_plan_version_id: 13n,
      inspection_plan_id: 6n,
      plan_version: 1,
      effective_from: new Date('2026-11-10'),
      effective_to: null,
      sampling_method_code: 'FULL_INSPECTION',
      sampling_qty: null,
      sampling_ratio: null,
      aql_value: null,
      acceptance_number: null,
      rejection_number: null,
      inspection_frequency_code: 'PRODUCTION_LOT',
      frequency_interval_value: null,
      frequency_interval_uom_code: null,
      status_code: 'DRAFT',
      version_no: 1,
      guide_text_ko: null,
      guide_text_vi: null,
      ...over,
    }) as Record<string, unknown>;

  const setup = (row: Record<string, unknown>) => {
    const created: Record<string, unknown>[] = [];
    const tx = {
      inspection_plan_version: {
        updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          for (const [key, value] of Object.entries(data)) if (key !== 'version_no') row[key] = value;
          row.version_no = (row.version_no as number) + 1;
          return { count: 1 };
        }),
        findUnique: jest.fn(async () => row),
        aggregate: jest.fn(async () => ({ _max: { plan_version: row.plan_version } })),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { ...baseRow(), ...data, inspection_plan_version_id: 14n };
        }),
      },
      inspection_item_spec: { findMany: jest.fn(async () => []), create: jest.fn() },
      attachment: { findMany: jest.fn(async () => []), create: jest.fn() },
      audit_event: { create: jest.fn() },
    };
    const prisma = {
      inspection_plan_version: { findFirst: jest.fn(async () => row) },
      $queryRawUnsafe: jest.fn(async () => [{ total: 0n }]),
      $transaction: jest.fn(async (run: (client: typeof tx) => unknown) => run(tx)),
    } as unknown as PrismaService;
    return { service: new InspectionPlanVersionService(prisma), created };
  };

  const write = (over: Partial<VersionWrite>): VersionWrite => ({
    effectiveFrom: '2026-11-10',
    samplingMethodCode: 'FULL_INSPECTION',
    inspectionFrequencyCode: 'PRODUCTION_LOT',
    ...over,
  });

  const errorOf = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return undefined;
    } catch (error) {
      return error as ContractException;
    }
  };

  it('안내 문구를 고치면 앞뒤 공백을 걷어 저장하고 조회에 그대로 나온다', async () => {
    const row = baseRow();
    const { service } = setup(row);

    const result = await service.update(13, 1, write({ guideTextKo: '  장갑을 착용하세요.\n도면 확인  ', guideTextVi: 'Đeo găng tay.' }));

    expect(result.inspectionPlanVersion).toMatchObject({
      guideTextKo: '장갑을 착용하세요.\n도면 확인',
      guideTextVi: 'Đeo găng tay.',
    });
  });

  it('공백만이면 비우고(null), 생략하면 그대로 둔다', async () => {
    const row = baseRow({ guide_text_ko: '기존 문구', guide_text_vi: 'cũ' });
    const { service } = setup(row);

    const result = await service.update(13, 1, write({ guideTextKo: '   ' }));

    expect(result.inspectionPlanVersion).toMatchObject({ guideTextKo: null, guideTextVi: 'cũ' });
  });

  it('확정된 버전은 안내 문구를 고칠 수 없다(400 STATE_LOCKED)', async () => {
    const { service } = setup(baseRow({ status_code: 'CONFIRMED' }));

    const error = await errorOf(() => service.update(13, 1, write({ guideTextKo: '새 문구' })));

    expect(error).toBeInstanceOf(ContractException);
    expect(error?.getStatus()).toBe(400);
    expect(error?.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
  });

  it('1000자를 넘으면 400 INVALID 다 — 계약 검사를 거치지 않는 길(엑셀 올리기)도 막는다', async () => {
    const { service } = setup(baseRow());

    const error = await errorOf(() => service.update(13, 1, write({ guideTextVi: 'a'.repeat(1001) })));

    expect(error?.getStatus()).toBe(400);
    expect(error?.errors[0]).toMatchObject({ field: 'guideTextVi', code: 'INVALID' });
    expect(await errorOf(() => service.update(13, 1, write({ guideTextVi: 'a'.repeat(1000) })))).toBeUndefined();
  });

  it('개정하면 안내 문구가 새 버전에 복사된다', async () => {
    const { service, created } = setup(
      baseRow({ status_code: 'CONFIRMED', guide_text_ko: '장갑 착용', guide_text_vi: 'Đeo găng tay' }),
    );

    await service.newRevision(13);

    expect(created[0]).toMatchObject({ guide_text_ko: '장갑 착용', guide_text_vi: 'Đeo găng tay' });
    expect(created[0]?.plan_version).toBe(2);
  });

  it('만들 때도 안내 문구를 받는다', async () => {
    const row = baseRow();
    const { service } = setup(row);
    const prisma = (service as unknown as { prisma: Record<string, unknown> }).prisma;
    prisma.inspection_plan = { findUnique: jest.fn(async () => ({ inspection_plan_id: 6n })) };
    (prisma.inspection_plan_version as Record<string, unknown>).findFirst = jest.fn(async () => null);

    const view = await service.create({ ...write({ guideTextKo: ' 안내 ' }), inspectionPlanId: 6 });

    expect(view).toMatchObject({ guideTextKo: '안내', guideTextVi: null });
  });

  it('단말(POP)은 PQC 작업지시뿐 아니라 자기 공장 OQC 의뢰에 걸린 버전도 읽는다', async () => {
    const row = baseRow({ status_code: 'CONFIRMED' });
    const findFirst = jest.fn(async () => row);
    const prisma = {
      inspection_plan_version: { findFirst },
      shipment_request: { findMany: jest.fn(async () => [{ shipment_request_id: 31n }]) },
      $queryRawUnsafe: jest.fn(async () => [{ total: 1n }]),
    } as unknown as PrismaService;
    const service = new InspectionPlanVersionService(prisma);

    await service.get(13, { plantId: 2n, terminalId: 5n, terminalTypeCode: 'POP' });

    const where = (findFirst.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(JSON.stringify(where, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).toContain('"inspection_type_code":"OQC"');
  });
});

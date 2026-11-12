import { ContractException, ERROR_CODE } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { InspectionPlanVersionService, ItemSpecUpsert } from './inspection-plan-version.service';

/** 수치 항목 단위 필수 검사를 지나면 다음 검사에서 멈춘다 — 저장 트랜잭션은 이 스위트가 보지 않는다. */
const PASSED = new Error('passed numeric uom check');

function harness() {
  const prisma = {
    inspection_item_spec: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  const service = new InspectionPlanVersionService(prisma);
  const internals = service as unknown as Record<string, unknown>;
  internals.assertDraft = jest.fn().mockResolvedValue(undefined);
  internals.readItems = jest.fn().mockResolvedValue([]);
  internals.assertItemTargets = jest.fn().mockRejectedValue(PASSED);
  return service;
}

const item = (overrides: Partial<ItemSpecUpsert>): ItemSpecUpsert => ({
  inspectionPlanVersionId: 1,
  sequenceNo: 1,
  inspectionItemCode: 'D-1',
  inspectionItemName: '길이',
  dataTypeCode: 'NUMERIC',
  uomId: 10,
  measurementCount: 1,
  requiredFlag: true,
  automaticJudgment: true,
  ...overrides,
});

describe('검사 항목 저장 — 수치 항목은 단위 필수', () => {
  it.each([
    ['null', null],
    ['빠짐', undefined],
  ])('수치 항목의 단위가 %s 이면 그 행 uomId 를 REQUIRED 로 거절한다', async (_label, uomId) => {
    const service = harness();
    const items = [item({ sequenceNo: 1 }), item({ sequenceNo: 2, inspectionItemCode: 'D-2', uomId })];

    const error = await service.replaceItems(1, items).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ContractException);
    expect((error as ContractException).errors).toEqual([
      expect.objectContaining({ scope: 'field', field: 'items[1].uomId', code: ERROR_CODE.REQUIRED }),
    ]);
  });

  it.each(['TEXT', 'BOOLEAN'])('%s 항목은 단위 없이 지나간다', async (dataTypeCode) => {
    const service = harness();
    await expect(service.replaceItems(1, [item({ dataTypeCode, uomId: null })])).rejects.toBe(PASSED);
  });

  it('단위가 있는 수치 항목은 지나간다', async () => {
    const service = harness();
    await expect(service.replaceItems(1, [item({})])).rejects.toBe(PASSED);
  });

  it('엑셀 가져오기(allowNumericWithoutUom)는 단위 없는 수치 항목을 받는다', async () => {
    const service = harness();
    await expect(
      service.replaceItems(1, [item({ uomId: null })], undefined, { allowNumericWithoutUom: true }),
    ).rejects.toBe(PASSED);
  });

  /* omf-all-around#262 — 항목코드를 비우면 순서로 붙인다. 넣은 코드는 그대로다. */
  it('항목코드를 비우면 ITEM-{순서 3자리} 로 붙이고, 넣은 코드는 앞뒤 빈칸만 걷는다', async () => {
    const service = harness();
    const targets = (service as unknown as { assertItemTargets: jest.Mock }).assertItemTargets;

    await service
      .replaceItems(1, [item({ sequenceNo: 2, inspectionItemCode: ' ' }), item({ sequenceNo: 3, inspectionItemCode: ' D-3 ' }), item({ sequenceNo: 12, inspectionItemCode: undefined })])
      .catch(() => undefined);

    expect(targets.mock.calls[0][0].map((row: ItemSpecUpsert) => row.inspectionItemCode)).toEqual(['ITEM-002', 'D-3', 'ITEM-012']);
  });
});

import { Prisma } from '@prisma/client';

import {
  PLAN_VERSION_AUDIT_TARGET,
  changedFields,
  itemChanges,
  recordPlanVersionAudit,
} from './inspection-plan-version-audit';

describe('검사기준 버전 변경 이력', () => {
  it('바뀐 키만 남기고 무시할 키는 견주지 않는다', () => {
    const diff = changedFields(
      { inspectionPlanVersionId: 1, aqlValue: null, samplingRatio: 10, effectiveFrom: '2026-01-01' },
      { inspectionPlanVersionId: 2, aqlValue: 0.65, samplingRatio: 10, effectiveFrom: '2026-01-01' },
      ['inspectionPlanVersionId'],
    );

    expect(diff).toEqual({ before: { aqlValue: null }, after: { aqlValue: 0.65 } });
  });

  it('검사 항목은 항목코드로 짝지어 변경 · 추가 · 삭제만 담는다', () => {
    const before = [
      { inspectionItemSpecId: 1, inspectionItemCode: 'LEN', targetValue: 12.5, measurementCount: 3 },
      { inspectionItemSpecId: 2, inspectionItemCode: 'WGT', targetValue: 250, measurementCount: 1 },
      { inspectionItemSpecId: 3, inspectionItemCode: 'APP', targetValue: null, measurementCount: 1 },
    ];
    const after = [
      { inspectionItemSpecId: 1, inspectionItemCode: 'LEN', targetValue: 12.6, measurementCount: 3 },
      { inspectionItemSpecId: 3, inspectionItemCode: 'APP', targetValue: null, measurementCount: 1 },
      { inspectionItemSpecId: 9, inspectionItemCode: 'HGT', targetValue: 8, measurementCount: 3 },
    ];

    expect(itemChanges(before, after)).toEqual({
      before: {
        items: [
          { inspectionItemCode: 'LEN', targetValue: 12.5 },
          { inspectionItemCode: 'WGT', targetValue: 250, measurementCount: 1 },
        ],
      },
      after: {
        items: [
          { inspectionItemCode: 'LEN', targetValue: 12.6 },
          { inspectionItemCode: 'HGT', targetValue: 8, measurementCount: 3 },
        ],
      },
    });
  });

  it('검사 항목이 그대로면 이력을 만들지 않는다', () => {
    const items = [{ inspectionItemSpecId: 1, inspectionItemCode: 'LEN', targetValue: 1 }];

    expect(itemChanges(items, items.map((item) => ({ ...item, inspectionItemSpecId: 5 })))).toBeNull();
  });

  it('검사기준 버전 대상으로 처리자와 함께 같은 트랜잭션에 남긴다', async () => {
    const create = jest.fn().mockResolvedValue(undefined);
    const tx = { audit_event: { create } } as unknown as Prisma.TransactionClient;

    await recordPlanVersionAudit(tx, {
      versionId: 15,
      eventTypeCode: 'DELETE',
      actorId: 7,
      before: { planVersion: 3, statusCode: 'DRAFT' },
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        target_type_code: PLAN_VERSION_AUDIT_TARGET,
        target_id: 15n,
        event_type_code: 'DELETE',
        performed_by: 7n,
        before_value: { planVersion: 3, statusCode: 'DRAFT' },
        after_value: Prisma.DbNull,
      }),
    });
  });
});

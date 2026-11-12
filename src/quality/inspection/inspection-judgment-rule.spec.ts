import type { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { assertJudgmentChange, storedJudgedMeasurements } from './inspection-result-write-rules';
import { assertJudgmentChangeReason, expectedJudgment, remarksWithJudgmentChange } from './inspection-rules';

/** omf-all-around#125 — IQC 판정은 합격판정개수 기준 자동 판정과 다르면 변경 사유가 필요하다(장부 P-70). */
const qty = (rejectedQty: number, heldQty = 0) => ({ acceptedQty: 100 - rejectedQty - heldQty, rejectedQty, heldQty });

function errorOf(run: () => unknown): ContractException {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractException);
    return error as ContractException;
  }
  throw new Error('던지지 않았다');
}

describe('expectedJudgment', () => {
  it.each([
    [qty(0), 'ACCEPTED'],
    [qty(5), 'ACCEPTED'],
    [qty(6), 'REJECTED'],
    [qty(3, 2), 'HELD'],
    [qty(10, 2), 'REJECTED'],
  ])('합격판정개수 5 · %o → %s', (quantities, expected) => {
    expect(expectedJudgment(quantities, 5)).toBe(expected);
  });

  it('합격판정개수 0 이면 불합격 1 부터 불합격이다', () => {
    expect(expectedJudgment(qty(1), 0)).toBe('REJECTED');
    expect(expectedJudgment(qty(0), 0)).toBe('ACCEPTED');
  });

  it('합격판정개수가 없으면 자동 판정이 없다', () => {
    expect(expectedJudgment(qty(10), null)).toBeNull();
  });
});

describe('assertJudgmentChangeReason', () => {
  it('자동 판정과 다른데 사유가 없으면 400 judgmentChangeReason REQUIRED — 기준을 말한다', () => {
    const error = errorOf(() => assertJudgmentChangeReason(qty(10), 'ACCEPTED', 5, undefined));
    expect(error.errors[0]).toMatchObject({ field: 'judgmentChangeReason', code: 'REQUIRED' });
    expect(error.errors[0].message).toContain('합격판정개수(5)');
  });

  it('공백만인 사유는 없는 것이다', () => {
    expect(() => assertJudgmentChangeReason(qty(0, 2), 'ACCEPTED', 5, '   ')).toThrow(ContractException);
  });

  it('사유가 있으면 다듬어 돌려준다', () => {
    expect(assertJudgmentChangeReason(qty(10), 'ACCEPTED', 5, '  재확인 결과 사용 가능 ')).toBe('재확인 결과 사용 가능');
  });

  it('자동 판정과 같으면 사유를 버린다', () => {
    expect(assertJudgmentChangeReason(qty(10), 'REJECTED', 5, '무시')).toBeUndefined();
    expect(assertJudgmentChangeReason(qty(3), 'ACCEPTED', 5, undefined)).toBeUndefined();
  });

  it('합격판정개수가 없으면 보지 않는다', () => {
    expect(assertJudgmentChangeReason(qty(10), 'ACCEPTED', null, undefined)).toBeUndefined();
  });
});

describe('remarksWithJudgmentChange', () => {
  it('사유를 맨 앞에, 원래 비고를 다음 줄에 둔다', () => {
    expect(remarksWithJudgmentChange('사유', '비고')).toBe('[판정 변경 사유] 사유\n비고');
    expect(remarksWithJudgmentChange('사유', null)).toBe('[판정 변경 사유] 사유');
    expect(remarksWithJudgmentChange('사유', '')).toBe('[판정 변경 사유] 사유');
  });
});

describe('assertJudgmentChange', () => {
  function db(type: string, acceptanceNumber: number | null | undefined) {
    return {
      inspection_request: {
        findUnique: jest.fn().mockResolvedValue({
          inspection_type_code: type,
          inspection_plan_version: acceptanceNumber === undefined ? null : { acceptance_number: acceptanceNumber },
        }),
      },
    } as unknown as Prisma.TransactionClient;
  }

  it.each(['IQC', 'OQC'])('%s · 합격판정개수 5 · 불합격 10 + 합격 → 400 (#125·#126)', async (type) => {
    await expect(
      assertJudgmentChange(db(type, 5), 1n, { ...qty(10), judgment: 'ACCEPTED', reason: undefined }),
    ).rejects.toBeInstanceOf(ContractException);
  });

  it('OQC · 사유가 있으면 다듬은 사유를 돌려준다 (#126)', async () => {
    await expect(
      assertJudgmentChange(db('OQC', 5), 1n, { ...qty(10), judgment: 'ACCEPTED', reason: '  고객 특채 승인  ' }),
    ).resolves.toBe('고객 특채 승인');
  });

  it.each([
    ['PQC', 5],
    ['OQC', null],
    ['IQC', null],
    ['IQC', undefined],
  ])('%s · 합격판정개수 %s 는 보지 않는다', async (type, acceptanceNumber) => {
    await expect(
      assertJudgmentChange(db(type, acceptanceNumber), 1n, { ...qty(10), judgment: 'ACCEPTED', reason: undefined }),
    ).resolves.toBeUndefined();
  });
});

/*
 * omf-all-around#264 — AQL 버전은 기타 항목 불량 수를 표의 Ac 와 견주고, 치수(수치) 항목은 하나라도 불합격이면
 * 수량과 상관없이 불합격이다(사용자 결정 2026-11-12).
 */
describe('assertJudgmentChange — AQL 치수 항목', () => {
  const { Prisma: P } = jest.requireActual<typeof import('@prisma/client')>('@prisma/client');
  function aqlDb(numericSpecs: { id: number; acceptance: number | null }[], versionAcceptance: number | null = null) {
    return {
      inspection_request: {
        findUnique: jest.fn().mockResolvedValue({
          inspection_type_code: 'IQC',
          target_qty: new P.Decimal(770),
          inspection_plan_version: {
            sampling_method_code: 'AQL',
            aql_value: new P.Decimal(0.4),
            aql_inspection_level_code: 'G-II',
            acceptance_number: versionAcceptance,
          },
        }),
      },
      inspection_item_spec: {
        findMany: jest.fn().mockImplementation(({ where }: { where: { inspection_item_spec_id: { in: bigint[] } } }) =>
          Promise.resolve(
            numericSpecs
              .filter((s) => where.inspection_item_spec_id.in.includes(BigInt(s.id)))
              .map((s) => ({ inspection_item_spec_id: BigInt(s.id), acceptance_number: s.acceptance })),
          ),
        ),
      },
    } as unknown as Prisma.TransactionClient;
  }
  const rejectedAt = (id: number) => ({ inspectionItemSpecId: id, judgmentCode: 'REJECTED' });

  it('치수 항목이 불합격이면 불합격 수량이 Ac(1) 이하여도 합격 확정에 사유가 필요하다', async () => {
    await expect(
      assertJudgmentChange(aqlDb([{ id: 1, acceptance: null }]), 1n, {
        ...qty(1),
        judgment: 'ACCEPTED',
        reason: undefined,
        measurements: () => [rejectedAt(1)],
      }),
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({
          field: 'judgmentChangeReason',
          message: expect.stringContaining('치수 항목이 불합격'),
        }),
      ],
    });
  });

  it('치수가 아닌 항목의 불량은 Ac(1) 이하면 합격이다', async () => {
    await expect(
      assertJudgmentChange(aqlDb([]), 1n, {
        ...qty(1),
        judgment: 'ACCEPTED',
        reason: undefined,
        measurements: () => [rejectedAt(2)],
      }),
    ).resolves.toBeUndefined();
  });

  it('치수 항목도 항목의 합격판정개수 이하 불합격 시료면 불합격이 아니다', async () => {
    await expect(
      assertJudgmentChange(aqlDb([{ id: 1, acceptance: 1 }]), 1n, {
        ...qty(1),
        judgment: 'ACCEPTED',
        reason: undefined,
        measurements: () => [rejectedAt(1)],
      }),
    ).resolves.toBeUndefined();
  });

  it('항목 허용 수가 없으면 버전의 합격판정개수로 견준다', async () => {
    await expect(
      assertJudgmentChange(aqlDb([{ id: 1, acceptance: null }], 1), 1n, {
        ...qty(1),
        judgment: 'ACCEPTED',
        reason: undefined,
        measurements: () => [rejectedAt(1)],
      }),
    ).resolves.toBeUndefined();
  });

  /* `:confirm` 은 본문에 측정값이 없다 — 저장된 측정값을 읽어 같은 규칙으로 잰다. */
  it('저장된 측정값으로 치수 불합격을 판정한다(:confirm 경로)', async () => {
    const tx = {
      inspection_measurement: {
        findMany: jest.fn().mockResolvedValue([{ inspection_item_spec_id: 1n, judgment_code: 'REJECTED' }]),
      },
    } as unknown as Prisma.TransactionClient;

    await expect(
      assertJudgmentChange(aqlDb([{ id: 1, acceptance: null }]), 1n, {
        ...qty(1),
        judgment: 'ACCEPTED',
        reason: undefined,
        measurements: () => storedJudgedMeasurements(tx, 8n),
      }),
    ).rejects.toMatchObject({ errors: [expect.objectContaining({ field: 'judgmentChangeReason' })] });
    expect(tx.inspection_measurement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { inspection_result_id: 8n } }),
    );
  });
});

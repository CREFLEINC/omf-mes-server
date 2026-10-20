import type { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { assertIqcJudgmentChange } from './inspection-result-write-rules';
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

describe('assertIqcJudgmentChange', () => {
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

  it('IQC · 합격판정개수 5 · 불합격 10 + 합격 → 400', async () => {
    await expect(
      assertIqcJudgmentChange(db('IQC', 5), 1n, { ...qty(10), judgment: 'ACCEPTED', reason: undefined }),
    ).rejects.toBeInstanceOf(ContractException);
  });

  it.each([
    ['PQC', 5],
    ['OQC', 5],
    ['IQC', null],
    ['IQC', undefined],
  ])('%s · 합격판정개수 %s 는 보지 않는다', async (type, acceptanceNumber) => {
    await expect(
      assertIqcJudgmentChange(db(type, acceptanceNumber), 1n, { ...qty(10), judgment: 'ACCEPTED', reason: undefined }),
    ).resolves.toBeUndefined();
  });
});

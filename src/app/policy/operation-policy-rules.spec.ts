import { ContractException } from '../../common/errors';
import {
  POLICY_CODES,
  assertPolicyCode,
  assertValues,
  axisCandidates,
  scopeOf,
  scopeRank,
  unresolved,
} from './operation-policy-rules';

/** 범위 축 넷을 골라 담은 가짜 행 — 판정에 쓰는 칸만 있으면 된다. */
function row(scope: Partial<Record<string, bigint | null>>): never {
  return {
    item_id: null,
    process_id: null,
    plant_id: null,
    business_unit_id: null,
    ...scope,
  } as never;
}

function caught(run: () => void): ContractException {
  try {
    run();
  } catch (error) {
    return error as ContractException;
  }
  throw new Error('던지지 않았다');
}

describe('운영 정책 규칙', () => {
  describe('범위 우선순위 — 좁은 것이 이긴다', () => {
    it('⭐ 순위가 ITEM < PROCESS < PLANT < BUSINESS_UNIT < ALL 이다', () => {
      const ranks = [
        scopeRank(row({ item_id: 1n })),
        scopeRank(row({ process_id: 1n })),
        scopeRank(row({ plant_id: 1n })),
        scopeRank(row({ business_unit_id: 1n })),
        scopeRank(row({})),
      ];

      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      expect(new Set(ranks).size).toBe(5);
    });

    it('⭐ 축을 여럿 가진 정책은 «가장 좁은» 축으로 읽는다', () => {
      // 품목과 공장을 함께 지정한 정책은 품목 정책이다 — 더 좁은 쪽이 그 정책의 범위다.
      expect(scopeOf(row({ item_id: 1n, plant_id: 2n }))).toBe('ITEM');
      expect(scopeRank(row({ item_id: 1n, plant_id: 2n }))).toBe(scopeRank(row({ item_id: 9n })));
    });

    it('축이 하나도 없으면 전사(ALL)다', () => {
      expect(scopeOf(row({}))).toBe('ALL');
    });
  });

  describe('후보 고르기', () => {
    it('⭐ 질의가 축을 주지 않으면 그 축을 «지정한» 정책은 후보가 아니다', () => {
      // 빈 배열이면 질의에 `{ 축: null }` 만 남아 축을 지정한 정책이 걸러진다.
      expect(axisCandidates('item_id', {})).toEqual([]);
      expect(axisCandidates('item_id', { itemId: null })).toEqual([]);
    });

    it('축을 주면 그 값과 같은 정책도 후보에 든다', () => {
      expect(axisCandidates('plant_id', { plantId: 7 })).toEqual([{ plant_id: 7 }]);
    });
  });

  describe('값 칸 강제', () => {
    it('⭐ 코드가 요구하는 칸이 비면 REQUIRED 다', () => {
      const error = caught(() => assertValues('SHOT_CONVERSION_ENABLED', {}));

      expect(error.errors).toEqual([
        expect.objectContaining({ field: 'valueBoolean', code: 'REQUIRED' }),
      ]);
    });

    it('⛔ 안 쓰는 칸을 함께 채우면 INVALID 다 — 두 칸이 다른 말을 하면 안 된다', () => {
      const error = caught(() =>
        assertValues('SHOT_CONVERSION_ENABLED', { valueBoolean: true, valueText: '참' }),
      );

      expect(error.errors).toEqual([
        expect.objectContaining({ field: 'valueText', code: 'INVALID' }),
      ]);
    });

    it('환산 비율은 0 보다 커야 한다', () => {
      expect(caught(() => assertValues('SHOT_CONVERSION_RATIO', { valueNumeric: 0 })).errors[0]).toMatchObject(
        { field: 'valueNumeric', code: 'RANGE' },
      );
      expect(() => assertValues('SHOT_CONVERSION_RATIO', { valueNumeric: 0.5 })).not.toThrow();
    });

    it('통제 수준 두 코드는 BLOCK·WARN·OFF 만 받는다', () => {
      for (const code of ['PRECHECK_CONTROL_LEVEL', 'FIFO_ENFORCEMENT_LEVEL'] as const) {
        expect(() => assertValues(code, { valueText: 'WARN' })).not.toThrow();
        expect(caught(() => assertValues(code, { valueText: 'MAYBE' })).errors[0]).toMatchObject({
          field: 'valueText',
          code: 'INVALID',
        });
      }
    });

    it('⭐ 코드 다섯 전부가 어느 칸을 쓰는지 정해져 있다 — 빠진 코드가 없다', () => {
      for (const code of POLICY_CODES) {
        // 아무 값도 안 주면 「요구하는 칸이 비었다」 하나만 나와야 한다.
        const error = caught(() => assertValues(code, {}));
        expect(error.errors).toHaveLength(1);
        expect(error.errors[0].code).toBe('REQUIRED');
      }
    });
  });

  describe('코드 검증', () => {
    it('목록 밖이면 INVALID, 없으면 REQUIRED 다', () => {
      expect(caught(() => assertPolicyCode('없는코드')).errors[0]).toMatchObject({
        field: 'policyCode',
        code: 'INVALID',
      });
      expect(caught(() => assertPolicyCode(undefined)).errors[0].code).toBe('REQUIRED');
    });
  });

  it('⛔ 못 찾은 결과에는 matchedScopeCode 칸이 아예 없다 — 계약 enum 이 null 을 안 받는다', () => {
    const result = unresolved('FIFO_ENFORCEMENT_LEVEL');

    expect(result.resolved).toBe(false);
    expect('matchedScopeCode' in result).toBe(false);
    expect(result.valueText).toBeNull();
  });
});

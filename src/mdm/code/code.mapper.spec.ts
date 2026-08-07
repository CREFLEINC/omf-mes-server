import { code_value } from '@prisma/client';

import { toCodeValue } from './code.mapper';
import { codeEditability } from './code.editability';

function row(overrides: Partial<code_value> = {}): code_value {
  return {
    code_value_id: 1n,
    code_group_id: 2n,
    code: 'MATERIAL',
    code_name: '자재창고',
    display_order: 10,
    effective_from: null,
    effective_to: null,
    is_active: true,
    created_at: new Date(),
    created_by: null,
    updated_at: new Date(),
    updated_by: null,
    version_no: 1,
    ...overrides,
  } as code_value;
}

describe('toCodeValue', () => {
  it('@db.Date 를 넣은 날짜 그대로 내린다', () => {
    // Prisma 가 @db.Date 를 주는 형태 — UTC 자정이다.
    const mapped = toCodeValue(row({ effective_from: new Date('2026-08-07T00:00:00.000Z') }));

    expect(mapped.effectiveFrom).toBe('2026-08-07');
  });

  it('로컬이 아니라 UTC 로 포맷한다', () => {
    // 위 테스트만으로는 부족하다. UTC 자정을 양수 오프셋(서버 UTC·한국 +9·하노이 +7)으로
    // 읽으면 같은 날이 나와, 로컬 포맷으로 짜도 통과한다. 음수 오프셋에서만 갈리는데
    // 그런 환경이 우리에게 없다.
    //
    // 그래서 둘이 갈리는 값으로 「어느 기준으로 포맷하는가」를 직접 본다.
    // Prisma 가 이 시각을 줄 일은 없지만, 검사하려는 것은 날짜가 아니라 그 성질이다.
    const mapped = toCodeValue(row({ effective_from: new Date('2026-08-07T20:00:00.000Z') }));

    expect(mapped.effectiveFrom).toBe('2026-08-07');
  });

  it('연말 경계에서도 밀리지 않는다', () => {
    const mapped = toCodeValue(row({ effective_from: new Date('2026-01-01T00:00:00.000Z') }));

    expect(mapped.effectiveFrom).toBe('2026-01-01');
  });

  it('날짜가 없으면 null 이다', () => {
    const mapped = toCodeValue(row());

    expect(mapped.effectiveFrom).toBeNull();
    expect(mapped.effectiveTo).toBeNull();
  });
});

describe('codeEditability', () => {
  it('언제나 NOT_COUNTABLE 이다 — 셀 수 있는 것이 물어야 할 것의 대리가 아니다', () => {
    expect(codeEditability()).toEqual({
      codeEditable: false,
      reason: 'NOT_COUNTABLE',
      referenceCount: null,
    });
  });
});

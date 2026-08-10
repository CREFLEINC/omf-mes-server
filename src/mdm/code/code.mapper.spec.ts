import { code_value } from '@prisma/client';

import { codeEditability } from './code.editability';
import { toCodeValue } from './code.mapper';

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
  it('계약 필드만 내린다 — 감사 컬럼과 version_no 는 빠진다', () => {
    // version_no 는 본문 노출 금지(공유계약 A-4). ETag 로만 나간다.
    expect(Object.keys(toCodeValue(row())).sort()).toEqual([
      'code',
      'codeGroupId',
      'codeName',
      'codeValueId',
      'displayOrder',
      'effectiveFrom',
      'effectiveTo',
      'isActive',
    ]);
  });

  it('유효기간이 없으면 null 이다', () => {
    const mapped = toCodeValue(row());

    expect(mapped.effectiveFrom).toBeNull();
    expect(mapped.effectiveTo).toBeNull();
  });

  it('유효기간을 날짜 문자열로 내린다', () => {
    const mapped = toCodeValue(
      row({
        effective_from: new Date('2026-08-07T00:00:00.000Z'),
        effective_to: new Date('2026-12-31T00:00:00.000Z'),
      }),
    );

    expect(mapped.effectiveFrom).toBe('2026-08-07');
    expect(mapped.effectiveTo).toBe('2026-12-31');
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

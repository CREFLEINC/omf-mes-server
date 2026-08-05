import { ValidationError } from '@nestjs/common';

import { ErrorResponse } from './contract-error';
import { contractValidationException } from './validation.error';

function error(property: string, constraints: Record<string, string>): ValidationError {
  return { property, constraints } as ValidationError;
}

function itemsOf(errors: ValidationError[]) {
  return (contractValidationException(errors).getResponse() as ErrorResponse).errors;
}

describe('contractValidationException', () => {
  it('계약 봉투 모양으로 바꾼다 — Nest 기본은 {statusCode, message, error} 다', () => {
    expect(itemsOf([error('warehouseCode', { isNotEmpty: '비어 있으면 안 됩니다' })])).toEqual([
      {
        scope: 'field',
        field: 'warehouseCode',
        code: 'REQUIRED',
        message: '비어 있으면 안 됩니다',
      },
    ]);
  });

  it.each([
    ['isDefined', 'REQUIRED'],
    ['isNotEmpty', 'REQUIRED'],
    ['isString', 'RANGE'],
    ['maxLength', 'RANGE'],
    ['isInt', 'RANGE'],
    ['isPositive', 'RANGE'],
  ])('%s 위반은 %s 로 옮긴다', (constraint, code) => {
    expect(itemsOf([error('x', { [constraint]: 'msg' })])[0].code).toBe(code);
  });

  it('여러 필드가 동시에 틀리면 배열에 여러 개를 담는다', () => {
    // 하나씩 알려주면 사용자가 세 번 저장을 눌러야 한다.
    const items = itemsOf([
      error('warehouseCode', { isNotEmpty: 'a' }),
      error('plantId', { isInt: 'b' }),
    ]);

    expect(items.map((i) => i.field)).toEqual(['warehouseCode', 'plantId']);
  });

  it('한 필드에 제약이 여러 개 걸리면 각각 담는다', () => {
    const items = itemsOf([error('warehouseCode', { isNotEmpty: 'a', maxLength: 'b' })]);

    expect(items.map((i) => i.code)).toEqual(['REQUIRED', 'RANGE']);
  });

  it('중첩 DTO 는 경로를 이어 붙인다 — 화면이 어느 칸인지 알아야 한다', () => {
    const parent = {
      property: 'address',
      children: [error('zipCode', { isNotEmpty: 'a' })],
    } as ValidationError;

    expect(itemsOf([parent])[0].field).toBe('address.zipCode');
  });

  it('전부 scope=field 다 — 화면이 인라인으로 붙인다', () => {
    const items = itemsOf([error('a', { isNotEmpty: 'x' }), error('b', { isInt: 'y' })]);

    expect(items.every((i) => i.scope === 'field')).toBe(true);
  });
});

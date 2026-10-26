import type { ErrorObject } from 'ajv';

import { ERROR_CODE } from '../errors';
import { ContractRegistry } from './contract-registry';
import { ContractValidator, OPENAPI_FORMATS } from './contract-validator';
import { toErrorItems } from './validation-error.mapper';

const error = (keyword: string, instancePath: string, params: Record<string, unknown>): ErrorObject =>
  ({ keyword, instancePath, schemaPath: '#', params, message: 'english' }) as ErrorObject;
const one = (keyword: string, instancePath: string, params: Record<string, unknown>) =>
  toErrorItems([error(keyword, instancePath, params)])[0];

const FALLBACK = '값이 계약과 맞지 않습니다';
/** 계약에 쓰인 keyword 마다 ajv 가 싣는 params 의 꼴 — 새 keyword 가 계약에 생기면 여기에 없어 시험이 깨진다. */
const PARAMS: Record<string, Record<string, unknown>> = {
  type: { type: 'integer' },
  required: { missingProperty: 'itemId' },
  minimum: { comparison: '>=', limit: 0 },
  exclusiveMinimum: { comparison: '>', limit: 0 },
  maximum: { comparison: '<=', limit: 100 },
  exclusiveMaximum: { comparison: '<', limit: 100 },
  minLength: { limit: 1 },
  maxLength: { limit: 50 },
  minItems: { limit: 1 },
  maxItems: { limit: 200 },
  enum: { allowedValues: ['A', 'B'] },
  const: { allowedValue: 'A' },
  format: { format: 'date-time' },
  pattern: { pattern: '^[A-Z]+$' },
  additionalProperties: { additionalProperty: 'extra' },
  dependentRequired: { property: 'a', missingProperty: 'b', depsCount: 1, deps: 'b' },
};
/** 자기 오류 없이 하위 스키마의 오류를 그대로 내거나(allOf), 무엇이 틀렸는지 한 줄로 못 짚어 기본 문구인 keyword. */
const COMPOSITE = new Set(['oneOf', 'anyOf', 'allOf', 'not']);
const KEYWORDS = new Set([...Object.keys(PARAMS), ...COMPOSITE]);

describe('계약 검증 오류 문구', () => {
  it('영어 원문 대신 칸·까닭·조치를 담은 한국어 문구이고, scope·field·code 는 그대로다', () => {
    expect(one('type', '/moldId', { type: 'integer' })).toEqual({
      scope: 'field', field: 'moldId', code: ERROR_CODE.INVALID,
      message: 'moldId 칸은 정수여야 합니다. 정수로 보내고, 값이 없으면 칸을 빼고 보내세요.',
    });
    expect(one('required', '', { missingProperty: 'workOrderId' })).toEqual({
      scope: 'field', field: 'workOrderId', code: ERROR_CODE.REQUIRED, message: 'workOrderId 칸이 빠졌습니다. 값을 채워 보내세요.',
    });
    expect(one('maxLength', '/lines/0/remarks', { limit: 200 })).toEqual({
      scope: 'field', field: 'lines[0].remarks', code: ERROR_CODE.RANGE,
      message: 'lines[0].remarks 칸은 200자 이하여야 합니다. 200자 이내로 줄여 보내세요.',
    });
    expect(one('type', '', { type: 'object' })).toEqual({
      scope: 'screen', code: ERROR_CODE.INVALID,
      message: '요청 본문은 객체여야 합니다. 객체로 보내고, 값이 없으면 칸을 빼고 보내세요.',
    });
  });

  it('오류 개수·순서는 그대로다', () => {
    const items = toErrorItems([
      error('required', '', { missingProperty: 'b' }),
      error('type', '/a', { type: 'string' }),
      error('minimum', '/c', { limit: 1 }),
    ]);
    expect(items.map((item) => [item.field, item.code])).toEqual([
      ['b', ERROR_CODE.REQUIRED], ['a', ERROR_CODE.INVALID], ['c', ERROR_CODE.RANGE],
    ]);
  });

  it('keyword 마다 문구', () => {
    const message = (keyword: string, params: Record<string, unknown>, path = '/qty') => one(keyword, path, params).message;
    expect(message('type', { type: ['integer', 'null'] })).toBe('qty 칸은 정수 또는 null이어야 합니다. 정수로 보내고, 값이 없으면 null로 보내세요.');
    expect(message('type', { type: 'integer,null' })).toBe('qty 칸은 정수 또는 null이어야 합니다. 정수로 보내고, 값이 없으면 null로 보내세요.');
    expect(message('type', { type: 'boolean' }, '/ok')).toBe('ok 칸은 참·거짓(true/false)이어야 합니다. 참·거짓(true/false)으로 보내고, 값이 없으면 칸을 빼고 보내세요.');
    expect(message('type', { type: 'array' }, '/lines')).toBe('lines 칸은 목록(배열)이어야 합니다. 목록(배열)로 보내고, 값이 없으면 칸을 빼고 보내세요.');
    expect(message('type', { type: 'string' }, '/name')).toBe('name 칸은 문자열이어야 합니다. 문자열로 보내고, 값이 없으면 칸을 빼고 보내세요.');
    expect(message('type', { type: 'number' })).toBe('qty 칸은 숫자여야 합니다. 숫자로 보내고, 값이 없으면 칸을 빼고 보내세요.');
    expect(message('minimum', { limit: 0 })).toBe('qty 칸은 0 이상이어야 합니다. 값을 확인해 고치세요.');
    expect(message('exclusiveMinimum', { limit: 0 })).toBe('qty 칸은 0 초과여야 합니다. 값을 확인해 고치세요.');
    expect(message('maximum', { limit: 9 })).toBe('qty 칸은 9 이하여야 합니다. 값을 확인해 고치세요.');
    expect(message('exclusiveMaximum', { limit: 9 })).toBe('qty 칸은 9 미만이어야 합니다. 값을 확인해 고치세요.');
    expect(message('minLength', { limit: 1 }, '/name')).toBe('name 칸은 1자 이상이어야 합니다. 값을 채워 보내세요.');
    expect(message('minItems', { limit: 1 }, '/lines')).toBe('lines 목록은 1개 이상이어야 합니다. 목록 개수를 맞춰 보내세요.');
    expect(message('maxItems', { limit: 200 }, '/lines')).toBe('lines 목록은 200개 이하여야 합니다. 목록 개수를 맞춰 보내세요.');
    expect(message('const', { allowedValue: 'A' }, '/kind')).toBe('kind 칸의 값이 허용 값이 아닙니다. A 중에서 고르세요.');
    expect(message('format', { format: 'date-time' }, '/startedAt'))
      .toBe('startedAt 칸은 날짜·시각 형식이어야 합니다. 2026-10-23T09:00:00+07:00 처럼 시간대까지 붙여 보내세요.');
    expect(message('format', { format: 'date' }, '/day')).toBe('day 칸은 날짜 형식이어야 합니다. 2026-10-23 처럼 YYYY-MM-DD 로 보내세요.');
    expect(message('format', { format: 'uuid' }, '/key')).toBe('key 칸은 UUID 형식이어야 합니다. 발급받은 UUID 를 그대로 보내세요.');
    expect(message('format', { format: 'int64' }, '/id')).toBe('id 칸은 -2^63 초과 2^63 미만의 정수여야 합니다. 소수·문자 없이 범위 안의 정수로 보내세요.');
    expect(message('format', { format: 'email' }, '/mail')).toBe('mail 칸은 email 형식이어야 합니다. 계약(API 문서)의 형식대로 보내세요.');
    expect(message('pattern', { pattern: '^x$' }, '/code')).toBe('code 칸의 형식이 맞지 않습니다. 계약(API 문서)의 형식대로 보내세요.');
    expect(message('additionalProperties', { additionalProperty: 'extra' }, '')).toBe('extra 칸은 이 요청에서 받지 않습니다. 그 칸을 빼고 보내세요.');
    expect(message('additionalProperties', { additionalProperty: 'extra' }, '/lines/0')).toBe('lines[0].extra 칸은 이 요청에서 받지 않습니다. 그 칸을 빼고 보내세요.');
    expect(message('dependentRequired', { property: 'a', missingProperty: 'b' }, ''))
      .toBe('a 칸은 b 칸과 함께 보내야 합니다. 두 칸을 같이 채워 보내세요.');
    expect(message('oneOf', { passingSchemas: null })).toBe('qty 칸의 값이 계약과 맞지 않습니다. 보낸 값을 확인해 다시 보내세요.');
  });

  it('허용 값은 코드값 그대로, 많으면 앞 10개와 개수만', () => {
    expect(one('enum', '/statusCode', { allowedValues: ['OPEN', 'CLOSED'] }).message)
      .toBe('statusCode 칸의 값이 허용 값이 아닙니다. OPEN, CLOSED 중에서 고르세요.');
    const many = Array.from({ length: 12 }, (_, index) => `V${index + 1}`);
    expect(one('enum', '/code', { allowedValues: many }).message)
      .toBe('code 칸의 값이 허용 값이 아닙니다. V1, V2, V3, V4, V5, V6, V7, V8, V9, V10 등 12개 중에서 고르세요.');
  });

  it('실제 계약 검증기에서도 같은 문구다 — 본문 null·nullable 칸·경로 id', () => {
    const validator = new ContractValidator(ContractRegistry.load());
    const startedAt = '2026-10-23T09:00:00+07:00';

    expect(validator.validate('POST /production/work-sessions', { body: { workOrderId: 1, startedAt, moldId: null } })).toEqual([{
      scope: 'field', field: 'moldId', code: ERROR_CODE.INVALID,
      message: 'moldId 칸은 정수여야 합니다. 정수로 보내고, 값이 없으면 칸을 빼고 보내세요.',
    }]);
    const precheck = validator.validate('POST /production/precheck-decisions', { body: {
      workOrderId: 1, equipmentId: 2, decidedAt: startedAt, controlLevelCode: 'WARN', decisionCode: 'PASSED', basisInspectionId: 'x',
    } });
    expect(precheck.map((item) => item.message))
      .toContain('basisInspectionId 칸은 정수 또는 null이어야 합니다. 정수로 보내고, 값이 없으면 null로 보내세요.');
    expect(validator.validate('GET /production/work-orders/{workOrderId}', { params: { workOrderId: 'abc' } })[0].message)
      .toBe('workOrderId 칸은 정수여야 합니다. 정수로 보내고, 값이 없으면 칸을 빼고 보내세요.');
    expect(validator.validate('GET /production/work-orders/{workOrderId}', { params: { workOrderId: '1'.padEnd(21, '0') } })[0].message)
      .toBe('workOrderId 칸은 -2^63 초과 2^63 미만의 정수여야 합니다. 소수·문자 없이 범위 안의 정수로 보내세요.');
  });

  it('계약에 쓰인 keyword·format 은 모두 전용 문구가 있다 — 기본 문구로 떨어지지 않는다', () => {
    const registry = ContractRegistry.load();
    const used = new Set<string>();
    const formats = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key === 'format' && typeof value === 'string') formats.add(value);
        else if (KEYWORD_CANDIDATES.has(key)) used.add(key);
        walk(value);
      }
    };
    for (const key of registry.keys()) walk(registry.get(key)?.document);

    expect([...used].filter((keyword) => !KEYWORDS.has(keyword))).toEqual([]);
    for (const keyword of used) {
      if (COMPOSITE.has(keyword)) continue;
      expect(one(keyword, '/x', PARAMS[keyword]).message).not.toContain(FALLBACK);
    }
    // 값 검사를 끈 format 은 오류가 나지 않는다 — 실제로 검사하는 것만 전용 문구를 본다.
    for (const format of [...formats].filter((name) => !OPENAPI_FORMATS.includes(name))) {
      expect(one('format', '/x', { format }).message).not.toContain(`${format} 형식이어야`);
    }
  });
});

/** JSON Schema 검증 keyword 중 계약 문서에서 찾아볼 것. 이름이 겹치는 OpenAPI 칸(`required: [..]`·`properties`)은 빼고 본다. */
const KEYWORD_CANDIDATES = new Set([
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'multipleOf',
  'pattern', 'enum', 'const', 'uniqueItems', 'additionalProperties', 'dependentRequired', 'oneOf', 'anyOf', 'allOf', 'not',
  'minProperties', 'maxProperties', 'contains', 'propertyNames', 'dependentSchemas', 'prefixItems', 'unevaluatedProperties',
]);

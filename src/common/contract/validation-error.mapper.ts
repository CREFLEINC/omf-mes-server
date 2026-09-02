import type { ErrorObject } from 'ajv';

import { ERROR_CODE, ErrorItem } from '../errors';

/**
 * ajv 오류를 계약 `ErrorItem` 으로 옮긴다.
 *
 * 계약이 `code` 값 목록을 「등」으로 열어 두었으므로, 문서가 이름 붙인 것(REQUIRED·RANGE)은
 * 그대로 쓰고 나머지 형식 위반은 `INVALID` 하나로 모은다 — 화면은 어느 칸이 왜 틀렸는지를
 * `field` 와 `message` 로 읽지, 코드를 세분해 분기하지 않는다.
 */
const RANGE_KEYWORDS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'multipleOf',
]);

function codeFor(keyword: string): string {
  if (keyword === 'required') return ERROR_CODE.REQUIRED;
  if (RANGE_KEYWORDS.has(keyword)) return ERROR_CODE.RANGE;
  if (keyword === 'dependentRequired' || keyword === 'dependencies') return ERROR_CODE.PAIR;
  return ERROR_CODE.INVALID;
}

/**
 * `/lines/0/itemId` → `lines[0].itemId`.
 * 화면이 입력칸을 찾는 이름이므로 JSON 포인터가 아니라 프로퍼티 경로로 준다.
 */
function fieldPath(instancePath: string, extra?: string): string | undefined {
  const tokens = instancePath.split('/').filter((token) => token !== '');
  if (extra) tokens.push(extra);
  if (tokens.length === 0) return undefined;

  return tokens.reduce((acc, token) => {
    const unescaped = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (/^\d+$/.test(unescaped)) return `${acc}[${unescaped}]`;
    return acc === '' ? unescaped : `${acc}.${unescaped}`;
  }, '');
}

export function toErrorItems(errors: ErrorObject[], prefix?: string): ErrorItem[] {
  return errors.map((error) => {
    const missing =
      error.keyword === 'required'
        ? (error.params as { missingProperty?: string }).missingProperty
        : undefined;
    const path = fieldPath(error.instancePath, missing);
    const field = prefix && path ? `${prefix}.${path}` : (path ?? prefix);

    return {
      // 필드를 짚을 수 있으면 인라인, 못 짚으면 배너. 근거: 공유계약 G-1
      scope: field ? ('field' as const) : ('screen' as const),
      ...(field ? { field } : {}),
      code: codeFor(error.keyword),
      message: error.message ?? '값이 계약과 맞지 않습니다.',
    };
  });
}

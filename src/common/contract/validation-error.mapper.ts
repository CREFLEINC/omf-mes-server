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
      message: safeMessage(error, field),
    };
  });
}

/** `type` 값의 이름과 그 뒤에 붙는 조사. 받침에 따라 갈려 이름마다 적어 둔다. */
const TYPE_WORD: Record<string, { name: string; ida: string; ro: string }> = {
  integer: { name: '정수', ida: '여야', ro: '로' },
  number: { name: '숫자', ida: '여야', ro: '로' },
  string: { name: '문자열', ida: '이어야', ro: '로' },
  boolean: { name: '참·거짓(true/false)', ida: '이어야', ro: '으로' },
  array: { name: '목록(배열)', ida: '이어야', ro: '로' },
  object: { name: '객체', ida: '여야', ro: '로' },
};
/** 실제로 값을 검사하는 format 만 — 검사를 끈 format(`OPENAPI_FORMATS`)은 오류가 나지 않는다. */
const FORMAT_MESSAGE: Record<string, (subject: string) => string> = {
  'date-time': (subject) =>
    `${subject} 날짜·시각 형식이어야 합니다. 2026-10-23T09:00:00+07:00 처럼 시간대까지 붙여 보내세요.`,
  date: (subject) => `${subject} 날짜 형식이어야 합니다. 2026-10-23 처럼 YYYY-MM-DD 로 보내세요.`,
  uuid: (subject) => `${subject} UUID 형식이어야 합니다. 발급받은 UUID 를 그대로 보내세요.`,
  // `INT64_FORMAT` 은 배정도로 판정해 2^63-1 같은 끝값도 거절한다 — 정확한 경계를 적으면 틀린 안내가 된다.
  int64: (subject) => `${subject} 너무 크거나 작은 정수입니다. 대략 ±9.22×10^18 미만의 정수로 보내세요.`,
};
/** 허용 값을 다 늘어놓으면 문구가 화면을 넘는다 — 앞에서 이만큼만 보이고 나머지는 개수로 적는다. */
const ENUM_SHOWN = 10;
/** 받지 않는 칸 이름은 요청이 보낸 값 그대로라 길이 제한이 없다. */
const KEY_SHOWN = 40;

/** 공용 오류 경로라 문구를 못 만들어도 400 은 그대로 나가야 한다 — 500 으로 바뀌지 않게 기본 문구로 떨어진다. */
function safeMessage(error: ErrorObject, field: string | undefined): string {
  try {
    return messageFor(error, field) ?? fallback(field);
  } catch {
    return fallback(field);
  }
}

function fallback(field: string | undefined): string {
  return `${field ? `${field} 칸의` : '요청 본문의'} 값이 계약과 맞지 않습니다. 보낸 값을 확인해 다시 보내세요.`;
}

/**
 * ajv 영어 원문 대신 「무엇이 틀렸나 · 어느 칸 · 어떻게 고치나」를 담은 문구. 문구에 필요한 params 가 없으면 undefined.
 * 이 오류는 화면 입력이 아니라 요청 모양 오류라 칸 이름은 계약 칸 이름(경로) 그대로 짚는다 — 개발·지원이 바로 찾게.
 */
function messageFor(error: ErrorObject, field: string | undefined): string | undefined {
  const subject = field ? `${field} 칸은` : '요청 본문은';
  const of = field ? `${field} 칸의` : '요청 본문의';
  const list = field ? `${field} 목록은` : '요청 본문은';
  const params = (error.params ?? {}) as Record<string, unknown>;
  const limit = params.limit == null ? undefined : String(params.limit);
  switch (error.keyword) {
    case 'type':
      return params.type == null ? undefined : typeMessage(params.type, field, subject);
    case 'required':
      return field ? `${field} 칸이 빠졌습니다. 값을 채워 보내세요.` : undefined;
    case 'minimum':
      return limit && `${subject} ${limit} 이상이어야 합니다. 값을 확인해 고치세요.`;
    case 'exclusiveMinimum':
      return limit && `${subject} ${limit} 초과여야 합니다. 값을 확인해 고치세요.`;
    case 'maximum':
      return limit && `${subject} ${limit} 이하여야 합니다. 값을 확인해 고치세요.`;
    case 'exclusiveMaximum':
      return limit && `${subject} ${limit} 미만이어야 합니다. 값을 확인해 고치세요.`;
    case 'minLength':
      return limit && `${subject} ${limit}자 이상이어야 합니다. 값을 채워 보내세요.`;
    case 'maxLength':
      return limit && `${subject} ${limit}자 이하여야 합니다. ${limit}자 이내로 줄여 보내세요.`;
    case 'minItems':
      return limit && `${list} ${limit}개 이상이어야 합니다. 목록 개수를 맞춰 보내세요.`;
    case 'maxItems':
      return limit && `${list} ${limit}개 이하여야 합니다. 목록 개수를 맞춰 보내세요.`;
    case 'enum':
      return Array.isArray(params.allowedValues) ? enumMessage(params.allowedValues, of) : undefined;
    case 'const':
      return 'allowedValue' in params ? enumMessage([params.allowedValue], of) : undefined;
    case 'format': {
      if (params.format == null) return undefined;
      const format = String(params.format);
      return Object.hasOwn(FORMAT_MESSAGE, format)
        ? FORMAT_MESSAGE[format](subject)
        : `${subject} ${format} 형식이어야 합니다. 계약(API 문서)의 형식대로 보내세요.`;
    }
    case 'pattern':
      return `${of} 형식이 맞지 않습니다. 계약(API 문서)의 형식대로 보내세요.`;
    // 이 두 keyword 는 instancePath 가 칸을 담은 객체를 가리킨다 — 칸 이름은 params 에 있다.
    case 'additionalProperties': {
      if (params.additionalProperty == null) return undefined;
      const key = String(params.additionalProperty);
      const shown = key.length > KEY_SHOWN ? `${key.slice(0, KEY_SHOWN)}…` : key;
      return `${inside(field, shown)} 칸은 이 요청에서 받지 않습니다. 그 칸을 빼고 보내세요.`;
    }
    case 'dependentRequired':
      if (params.property == null || params.missingProperty == null) return undefined;
      return `${inside(field, params.property)} 칸은 ${inside(field, params.missingProperty)} 칸과 함께 보내야 합니다. 두 칸을 같이 채워 보내세요.`;
    default:
      return undefined;
  }
}

function typeMessage(type: unknown, field: string | undefined, subject: string): string {
  const types = (Array.isArray(type) ? type : String(type).split(',')).map(String);
  const nullable = types.includes('null');
  const words = types.filter((name) => name !== 'null').map((name) => TYPE_WORD[name] ?? { name, ida: '이어야', ro: '로' });
  if (words.length === 0) return `${subject} null이어야 합니다. null로 보내세요.`;
  const names = words.map((word) => word.name).join(' 또는 ');
  const last = words[words.length - 1];
  if (nullable) {
    return `${subject} ${names} 또는 null이어야 합니다. ${names}${last.ro} 보내거나, 값이 없으면 null로 보내세요.`;
  }
  // 본문 전체가 틀렸으면 고칠 칸이 없다 — 보낼 JSON 의 모양을 짚는다.
  const how = field ? `${names}${last.ro}` : `JSON ${names}${last.ro}`;
  return `${subject} ${names}${last.ida} 합니다. ${how} 보내세요.`;
}

function enumMessage(allowed: unknown[], of: string): string {
  const values = allowed.filter((value) => value !== null);
  const nullable = values.length < allowed.length;
  if (values.length === 0) return `${of} 값이 허용 값이 아닙니다. null로 보내세요.`;
  const shown = values
    .slice(0, ENUM_SHOWN)
    .map((value) => (typeof value === 'object' ? JSON.stringify(value) : String(value)))
    .join(', ');
  const rest = values.length > ENUM_SHOWN ? ` 등 ${values.length}개` : '';
  const action = nullable ? '중에서 고르거나, 값이 없으면 null로 보내세요.' : '중에서 고르세요.';
  return `${of} 값이 허용 값이 아닙니다. ${shown}${rest} ${action}`;
}

/** `fieldPath` 와 같은 표기 — 숫자 키는 `[n]` 이다. */
function inside(parent: string | undefined, name: unknown): string {
  const key = String(name);
  if (/^\d+$/.test(key)) return `${parent ?? ''}[${key}]`;
  return parent ? `${parent}.${key}` : key;
}

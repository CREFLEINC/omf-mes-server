import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import { ErrorItem } from '../errors';
import {
  ContractOperation,
  ContractRegistry,
  OpenApiDocument,
  jsonPointerToken,
} from './contract-registry';
import { toErrorItems } from './validation-error.mapper';

/**
 * OpenAPI 고유 format. JSON Schema 에는 없어 ajv 가 모른다. 무연산으로 등록해 둔다 —
 * `validateFormats: false` 로 통째로 끄면 date·date-time·uuid 검사까지 같이 죽는다.
 */
const OPENAPI_FORMATS = ['int32', 'double', 'float', 'binary', 'password'];

/**
 * `int64` 만 «무연산이 아니다» — 실제로 범위를 본다.
 *
 * 모든 id 컬럼이 물리 `BigInt`(int8) 이고 계약도 그 자리 1456곳을 `format: int64` 로
 * 적었다. 그런데 `type: integer` 만으로는 1e20 이 통과한다 — `Number.isInteger(1e20)`
 * 가 참이라서다. 통과한 값은 Prisma 가 int8 로 못 접어 던지고, 그것이 조회 오퍼레이션
 * 210건에서 **500** 으로 나갔다(계약은 그 자리에 500 을 선언한 적이 없다).
 *
 * ⚠ 상한이 `2 ** 63 - 1` 이 아니라 `2 ** 63` **미만**인 이유 — 자바스크립트 수는 배정도라
 * int64 최댓값을 표현하지 못한다. `Number('9223372036854775807')` 은 `2 ** 63` 으로
 * 올림되고, 그 값은 int8 에 안 들어가 다시 500 이 된다. 그래서 「배정도로 int8 에
 * 실을 수 있는가」가 정확한 경계이고, 그 경계는 `2 ** 63` 미만이다
 * (표현 가능한 가장 큰 값 `2 ** 63 - 1024` 는 유효한 int64 라 통과한다).
 *
 * ⛔ 2^53 초과 구간의 정밀도 손실은 여기서 막지 않는다 — 그 값은 반올림된 채 조회돼
 * 404 로 끝나고 500 이 아니다. 계약이 int64 를 허용한 이상 거절할 근거가 없다(통보 210).
 *
 * ⛔ **경로·질의에만 건다. 본문에는 걸지 않는다** — 본문 정수 범위는 I-28 이 이미
 * 자기 규칙으로 막고 있고(`recipients[].userId` 를 `MAX_SAFE_INTEGER` 초과에서
 * `code: RANGE` 로 거절 · `app-notification-preview.e2e-spec.ts`), 그 자리는 아직
 * «설계 미정 · 문의 번호 배정 대기(I-28 R-11)»다. 여기서 format 으로 먼저 잡으면
 * 이미 `RANGE` 를 받아 온 클라이언트가 말없이 `INVALID` 를 받게 되고, 다른 슬라이스가
 * 들고 있는 미결 판정을 공용 자리가 덮어쓴다. 신고된 결함도 경로·질의뿐이다.
 */
const INT64_FORMAT = {
  type: 'number',
  validate: (value: number): boolean =>
    Number.isInteger(value) && value >= -(2 ** 63) && value < 2 ** 63,
} as const;

interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  schema?: unknown;
}

export interface RequestParts {
  body?: unknown;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
}

/**
 * ajv 는 `$id` 를 URI 로 읽는다. 파일 이름을 그대로 쓰면 `params:app-공통.json` 이
 * 스킴 `params` 로 해석돼 `$ref` 가 안 풀린다. ASCII 로 된 불투명 URI 를 붙인다.
 */
const ID_BASE = 'https://omf-mes.invalid/contract';

interface CompiledOperation {
  body?: ValidateFunction;
  /** 계약이 `requestBody.required: false` 라 적은 자리 — 본문이 아예 없어도 통과시킨다. */
  bodyOptional?: boolean;
  query?: ValidateFunction;
  path?: ValidateFunction;
}

/** `parameters` 는 경로·질의용 인스턴스라는 뜻이다 — 본문용과 두 가지가 갈린다. */
function buildAjv(document: OpenApiDocument, id: string, parameters: boolean): Ajv2020 {
  const ajv = new Ajv2020({
    // 계약에 example·x-* 가 3천 자리 넘게 있다. strict 면 스키마 컴파일이 그것들로 죽는다.
    strict: false,
    // 계약 ErrorResponse 가 errors 를 배열로 정의했다 — 첫 오류에서 멈추면 화면이
    // 필드를 하나씩 고치며 왕복한다.
    allErrors: true,
    coerceTypes: parameters,
  });
  addFormats(ajv);
  for (const format of OPENAPI_FORMATS) ajv.addFormat(format, true);
  ajv.addFormat('int64', parameters ? INT64_FORMAT : true);
  ajv.addSchema(document as object, id);
  return ajv;
}

/** 계약 문서 안을 가리키는 `$ref`. 인라인 스키마도 이렇게 가리켜야 내부 `$ref` 가 풀린다. */
function refTo(id: string, pointer: string): { $ref: string } {
  return { $ref: `${id}#${pointer}` };
}

function resolveRef(document: OpenApiDocument, ref: string): unknown {
  let value: unknown = document;
  for (const token of ref.replace(/^#\//, '').split('/')) {
    value = (value as Record<string, unknown>)[token.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return value;
}

/**
 * 파라미터를 오퍼레이션과 path-item 양쪽에서 모은다.
 * 경로 파라미터 171자리가 path-item 레벨에만 있다(실측) — 한쪽만 보면 통째로 놓친다.
 */
function collectParameters(
  entry: ContractOperation,
): { parameter: Parameter; pointer: string }[] {
  const pathItem = entry.document.paths?.[entry.path] as
    | Record<string, unknown>
    | undefined;
  const shared = (pathItem?.parameters ?? []) as unknown[];
  const own = ((entry.operation as { parameters?: unknown[] }).parameters ?? []) as unknown[];

  const sharedPointer = `/paths/${jsonPointerToken(entry.path)}/parameters`;
  const ownPointer = `${entry.pointer}/parameters`;

  return [
    ...shared.map((value, index) => ({ value, pointer: `${sharedPointer}/${index}` })),
    ...own.map((value, index) => ({ value, pointer: `${ownPointer}/${index}` })),
  ]
    .map(({ value, pointer }) => {
      const record = value as { $ref?: string };
      // $ref 파라미터는 전부 공통 헤더다(Idempotency-Key·If-Match·X-Worker-No).
      // 헤더는 이 검증기가 다루지 않으므로 가리키는 곳을 풀어 in 만 본다.
      const parameter = (
        record.$ref ? resolveRef(entry.document, record.$ref) : value
      ) as Parameter;
      const target = record.$ref ? `${record.$ref.replace(/^#/, '')}` : pointer;
      return { parameter, pointer: target };
    })
    .filter(({ parameter }) => parameter?.name !== undefined);
}

function parameterSchema(
  id: string,
  entries: { parameter: Parameter; pointer: string }[],
  location: string,
): object | undefined {
  const selected = entries.filter(({ parameter }) => parameter.in === location);
  if (selected.length === 0) return undefined;

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const { parameter, pointer } of selected) {
    properties[parameter.name] = parameter.schema
      ? refTo(id, `${pointer}/schema`)
      : {};
    if (parameter.required) required.push(parameter.name);
  }

  // 계약에 없는 질의 파라미터는 막지 않는다 — 화면이 추적용 값을 붙이는 일이 있고,
  // 계약도 additionalProperties 를 거의 쓰지 않는다(전 파일 1자리).
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

function requestBodyOf(
  entry: ContractOperation,
): { required?: boolean; content?: Record<string, unknown> } | undefined {
  return (entry.operation as { requestBody?: { required?: boolean; content?: Record<string, unknown> } })
    .requestBody;
}

function bodySchemaPointer(entry: ContractOperation): string | undefined {
  const content = requestBodyOf(entry)?.content;
  if (!content) return undefined;
  // multipart 4자리는 파일 업로드다 — JSON 스키마로 볼 대상이 아니다.
  if (!content['application/json']) return undefined;

  return `${entry.pointer}/requestBody/content/application~1json/schema`;
}

/** 계약대로 요청을 검증한다. 오퍼레이션마다 처음 쓸 때 컴파일해 둔다. */
export class ContractValidator {
  private readonly compiled = new Map<string, CompiledOperation>();
  private readonly ajvBySource = new Map<string, { body: Ajv2020; params: Ajv2020 }>();
  private readonly idsBySource = new Map<string, { body: string; params: string }>();

  constructor(private readonly registry: ContractRegistry) {}

  /** 계약 전건을 미리 컴파일한다. 부팅 때 한 번 불러 스키마 결함을 그 자리에서 드러낸다. */
  compileAll(): number {
    for (const key of this.registry.keys()) this.compileOperation(key);
    return this.compiled.size;
  }

  validate(key: string, request: RequestParts): ErrorItem[] {
    const compiled = this.compileOperation(key);
    if (!compiled) return [];

    const items: ErrorItem[] = [];
    if (compiled.path && !compiled.path(request.params ?? {})) {
      items.push(...toErrorItems(compiled.path.errors ?? []));
    }
    if (compiled.query && !compiled.query(request.query ?? {})) {
      items.push(...toErrorItems(compiled.query.errors ?? []));
    }
    // 본문 없는 요청(`req.body === undefined` — body-parser 2)은 계약이
    // `requestBody.required: false` 로 연 자리에서만 통과한다. 스키마로 판정할 수
    // 없다 — `required: []` 인 객체 스키마도 `undefined` 는 「객체가 아니다」로 막는다.
    const bodyOmitted = request.body === undefined && compiled.bodyOptional === true;
    if (compiled.body && !bodyOmitted && !compiled.body(request.body)) {
      items.push(...toErrorItems(compiled.body.errors ?? []));
    }
    return items;
  }

  private compileOperation(key: string): CompiledOperation | undefined {
    const cached = this.compiled.get(key);
    if (cached) return cached;

    const entry = this.registry.get(key);
    if (!entry) return undefined;

    let ids = this.idsBySource.get(entry.source);
    if (!ids) {
      const index = this.idsBySource.size;
      ids = { body: `${ID_BASE}/${index}/body`, params: `${ID_BASE}/${index}/params` };
      this.idsBySource.set(entry.source, ids);
    }

    let ajv = this.ajvBySource.get(entry.source);
    if (!ajv) {
      ajv = {
        // 본문은 JSON 이라 타입이 이미 뜻을 갖는다 — 강제 변환하면 "3" 이 3 으로 통과한다.
        body: buildAjv(entry.document, ids.body, false),
        // 질의·경로는 언제나 문자열로 온다 — 강제 변환하지 않으면 integer 가 전부 틀린다.
        params: buildAjv(entry.document, ids.params, true),
      };
      this.ajvBySource.set(entry.source, ajv);
    }

    const parameters = collectParameters(entry);
    const pathSchema = parameterSchema(ids.params, parameters, 'path');
    const querySchema = parameterSchema(ids.params, parameters, 'query');
    const bodyPointer = bodySchemaPointer(entry);

    const compiled: CompiledOperation = {
      ...(pathSchema ? { path: ajv.params.compile(pathSchema) } : {}),
      ...(querySchema ? { query: ajv.params.compile(querySchema) } : {}),
      ...(bodyPointer ? { body: ajv.body.compile(refTo(ids.body, bodyPointer)) } : {}),
      ...(requestBodyOf(entry)?.required === false ? { bodyOptional: true } : {}),
    };
    this.compiled.set(key, compiled);
    return compiled;
  }
}

import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import { ErrorItem } from '../errors';
import {
  ContractOperation,
  ContractRegistry,
  OpenApiDocument,
  OpenApiOperation,
  jsonPointerToken,
} from './contract-registry';
import { toErrorItems } from './validation-error.mapper';

/**
 * OpenAPI 고유 format. JSON Schema 에는 없어 ajv 가 모른다. 무연산으로 등록해 둔다 —
 * `validateFormats: false` 로 통째로 끄면 date·date-time·uuid 검사까지 같이 죽는다.
 */
const OPENAPI_FORMATS = ['int64', 'int32', 'double', 'float', 'binary', 'password'];

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
  query?: ValidateFunction;
  path?: ValidateFunction;
}

function buildAjv(document: OpenApiDocument, id: string, coerceTypes: boolean): Ajv2020 {
  const ajv = new Ajv2020({
    // 계약에 example·x-* 가 3천 자리 넘게 있다. strict 면 스키마 컴파일이 그것들로 죽는다.
    strict: false,
    // 계약 ErrorResponse 가 errors 를 배열로 정의했다 — 첫 오류에서 멈추면 화면이
    // 필드를 하나씩 고치며 왕복한다.
    allErrors: true,
    coerceTypes,
  });
  addFormats(ajv);
  for (const format of OPENAPI_FORMATS) ajv.addFormat(format, true);
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

function bodySchemaPointer(entry: ContractOperation): string | undefined {
  const requestBody = (entry.operation as { requestBody?: { content?: Record<string, unknown> } })
    .requestBody;
  const content = requestBody?.content;
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
    if (compiled.body && !compiled.body(request.body)) {
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
    };
    this.compiled.set(key, compiled);
    return compiled;
  }
}

export type { OpenApiOperation };

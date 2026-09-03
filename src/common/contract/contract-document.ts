import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { OpenApiDocument, OpenApiOperation, defaultContractsDir } from './contract-registry';

/**
 * `/api/docs` 가 보여 줄 문서를 **계약 원본에서** 만든다.
 *
 * ⛔ Nest 가 반사(reflection)로 만든 문서를 쓰지 않는다. DTO 가 평범한 `interface` 라
 * 런타임에 지워지고 컨트롤러에 `@ApiProperty` 도 없어, 그 문서는 경로 186건을 나열하면서
 * **스키마·파라미터·오류 응답이 0개**다(실측). 「무엇을 보내야 하는가」를 못 알려 주면서
 * 정본처럼 보이는 것이 아무것도 없는 것보다 나쁘다.
 *
 * ⛔ 반대로 컨트롤러에 데코레이터를 다는 길도 안 간다 — 482 오퍼레이션의 스키마를 손으로
 * 복제하면 계약과 두 벌이 되고, 두 벌은 반드시 어긋난다. 정본은 `contracts/` 하나다.
 *
 * ⚠ 문서에 실리는 것은 **계약 전건(482)** 이고, 그중 서버가 실제로 서빙하는 것만
 * 표시로 가른다. 구현된 것만 실으면 「아직 없는 것」을 화면이 못 보고, 전건만 실으면
 * 「지금 부를 수 있는 것」을 못 가린다.
 */

const UNIMPLEMENTED_MARK = '⛔ 미구현 — ';

interface Components {
  schemas?: Record<string, unknown>;
  [key: string]: unknown;
}

interface SourceDocument extends OpenApiDocument {
  components?: Components;
}

/** 계약 파일 하나를 가리키는 짧은 이름 — `mdm-기준정보.json` 은 `mdm` 이다. */
function sourceKey(file: string): string {
  return file.replace(/\.json$/, '').split('-')[0];
}

/**
 * 컴포넌트 이름 충돌을 가른다.
 *
 * ⛔ 실측: 481 이름 중 **3개가 파일마다 내용이 다르다**(`PageMeta`·`ErrorItem`·
 * `ConflictResponse`). 그냥 합치면 마지막 파일이 이기고, 그 자리를 쓰는 오퍼레이션들이
 * **조용히 남의 스키마를 가리킨다**. 내용이 같은 이름은 그대로 두고 다른 것만 접두어를 붙인다.
 */
function renameMap(
  sources: { file: string; document: SourceDocument }[],
  kind: string,
): Map<string, string> {
  const byName = new Map<string, Map<string, string>>();
  for (const { file, document } of sources) {
    const bag = (document.components?.[kind] ?? {}) as Record<string, unknown>;
    for (const [name, schema] of Object.entries(bag)) {
      const seen = byName.get(name) ?? new Map<string, string>();
      seen.set(file, JSON.stringify(schema));
      byName.set(name, seen);
    }
  }

  const renames = new Map<string, string>();
  for (const [name, seen] of byName) {
    if (new Set(seen.values()).size <= 1) continue;
    for (const file of seen.keys()) renames.set(`${file} ${name}`, `${sourceKey(file)}_${name}`);
  }
  return renames;
}

/** `$ref` 를 새 이름으로 갈아 끼운다. 이름이 안 바뀐 참조는 그대로 둔다. */
function rewriteRefs(
  value: unknown,
  file: string,
  renames: Map<string, Map<string, string>>,
): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteRefs(item, file, renames));
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === '$ref' && typeof item === 'string') {
      const match = /^#\/components\/([^/]+)\/(.+)$/.exec(item);
      const renamed = match ? renames.get(match[1])?.get(`${file} ${match[2]}`) : undefined;
      out[key] = renamed === undefined ? item : `#/components/${String(match?.[1])}/${renamed}`;
      continue;
    }
    out[key] = rewriteRefs(item, file, renames);
  }
  return out;
}

const METHODS: readonly string[] = ['get', 'post', 'put', 'patch', 'delete'];
const COMPONENT_KINDS = ['schemas', 'parameters', 'responses', 'headers', 'requestBodies'];

/** 오퍼레이션을 묶는 축. 최상위 경로가 곧 도메인이다(`/mdm/warehouses` 는 `mdm`). */
function tagOf(path: string): string {
  return path.split('/')[1] ?? 'etc';
}

export interface ContractDocument extends OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers: { url: string }[];
  tags: { name: string }[];
  /** 이 문서가 담은 전체 오퍼레이션 수와 그중 지금 서빙되는 수. */
  'x-coverage': { implemented: number; total: number };
}

/**
 * 계약 파일 전부를 한 문서로 합친다.
 *
 * @param served 지금 서버가 실제로 서빙하는 `METHOD /path` 집합. 부팅 때 Nest 가 만든
 *   반사 문서에서 뽑는다 — 그것이 「무엇이 떠 있는가」의 유일한 정본이다.
 */
export function buildContractDocument(
  served: ReadonlySet<string>,
  dir: string = defaultContractsDir(),
): ContractDocument {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const sources = files.map((file) => ({
    file,
    document: JSON.parse(readFileSync(join(dir, file), 'utf8')) as SourceDocument,
  }));
  const renames = new Map(COMPONENT_KINDS.map((kind) => [kind, renameMap(sources, kind)]));

  const paths: Record<string, Record<string, OpenApiOperation>> = {};
  const components: Record<string, Record<string, unknown>> = {};
  let implemented = 0;
  let total = 0;

  for (const { file, document } of sources) {
    for (const kind of COMPONENT_KINDS) {
      const bag = (document.components?.[kind] ?? {}) as Record<string, unknown>;
      if (Object.keys(bag).length === 0) continue;
      const target = components[kind] ?? {};
      for (const [name, schema] of Object.entries(bag)) {
        const renamed = renames.get(kind)?.get(`${file} ${name}`) ?? name;
        target[renamed] = rewriteRefs(schema, file, renames);
      }
      components[kind] = target;
    }

    for (const [path, item] of Object.entries(document.paths ?? {})) {
      const rewritten = rewriteRefs(item, file, renames) as Record<string, OpenApiOperation>;
      const bucket = paths[path] ?? {};
      for (const [key, value] of Object.entries(rewritten)) {
        if (!METHODS.includes(key)) {
          // `parameters` 처럼 경로 수준에 붙는 것은 그대로 옮긴다.
          bucket[key] = value;
          continue;
        }
        total += 1;
        const live = served.has(`${key.toUpperCase()} ${path}`);
        if (live) implemented += 1;
        bucket[key] = {
          ...value,
          tags: [tagOf(path)],
          summary: `${live ? '' : UNIMPLEMENTED_MARK}${String(value.summary ?? '')}`,
          'x-implemented': live,
          'x-contract-source': file,
        };
      }
      paths[path] = bucket;
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'OMF MES API',
      version: '0.1.0',
      description: [
        `구현 **${implemented} / ${total}**.`,
        `표제에 \`${UNIMPLEMENTED_MARK.trim()}\` 가 붙은 것은 아직 서버에 없다.`,
        '',
        `이 문서는 \`contracts/\` 의 OpenAPI ${files.length}파일을 그대로 합친 것이다 —`,
        '컨트롤러에서 반사한 것이 아니라 스키마가 어긋날 자리가 없다.',
        '',
        '이름이 파일마다 다른 컴포넌트는 출처를 앞에 붙였다(예: `mdm_PageMeta`).',
      ].join('\n'),
    },
    servers: [{ url: '/api' }],
    tags: [...new Set(Object.keys(paths).map(tagOf))].sort().map((name) => ({ name })),
    paths,
    components,
    'x-coverage': { implemented, total },
  };
}

/** 반사 문서의 경로(`/api/mdm/...`)를 계약 키(`GET /mdm/...`)로 바꾼다. */
export function servedOperations(
  reflected: { paths?: Record<string, Record<string, unknown>> },
  prefix: string,
): Set<string> {
  const served = new Set<string>();
  for (const [path, item] of Object.entries(reflected.paths ?? {})) {
    if (!path.startsWith(`/${prefix}/`)) continue;
    const contractPath = path.slice(prefix.length + 1);
    for (const method of Object.keys(item)) {
      if (!METHODS.includes(method)) continue;
      served.add(`${method.toUpperCase()} ${contractPath}`);
    }
  }
  return served;
}

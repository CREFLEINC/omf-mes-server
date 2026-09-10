import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { FAMILY_CONFLICT_CODE } from './idempotency.service';

/**
 * ⭐ 「계열 봉투를 쓰는 호출부에만 `FAMILY_CONFLICT_CODE` 를 넘긴다」를 **기계로** 잠근다.
 *
 * ⛔ 이 판정은 **e2e 로는 반증되지 않는다** — 인자가 빠지면 409 본문에서 required 칸이
 * 사라질 뿐 5xx 도 타입 오류도 안 난다(다섯째 인자가 선택이라 `tsc` 도 못 잡는다).
 * 부채 #337 ⓐ 가 애초에 그래서 살아남았다. 실측(#414 리뷰 M-1): 28 호출부 중 **26곳**에서
 * 인자를 지워도 e2e 98파일 1771건이 전부 초록이었다. 그 26곳을 이 스펙이 한 번에 잠근다.
 *
 * 선례 — `contract-coverage.spec.ts`(계약 × 소스 × Dockerfile 텍스트 대조) ·
 * `permissions.spec.ts`(`contracts/*.json` 직접 적재).
 */

const SRC = join(__dirname, '../..');
const CONTRACTS = join(SRC, '../contracts');
const MARKER = 'FAMILY_CONFLICT_CODE';

interface ConflictSchema {
  required: string[];
  codeEnum: string[];
}

type Json = Record<string, unknown>;

/** 계약 문서 안의 `#/…` 포인터를 푼다. 409 는 응답 자체가 `$ref` 인 자리가 있다. */
function resolve(document: Json, ref: string): Json {
  let node: Json = document;
  for (const token of ref.replace(/^#\//, '').split('/')) {
    node = node[token.replace(/~1/g, '/').replace(/~0/g, '~')] as Json;
  }
  return node;
}

/** `METHOD /path` → 그 오퍼레이션의 409 스키마. 409 를 안 선언한 오퍼레이션은 담지 않는다. */
function conflictSchemas(): Map<string, ConflictSchema> {
  const found = new Map<string, ConflictSchema>();

  for (const file of readdirSync(CONTRACTS).filter((name) => name.endsWith('.json')).sort()) {
    const document = JSON.parse(readFileSync(join(CONTRACTS, file), 'utf8')) as Json;
    const paths = (document.paths ?? {}) as Record<string, Record<string, Json>>;

    for (const [path, item] of Object.entries(paths)) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        const operation = item[method];
        if (!operation) continue;

        let response = ((operation.responses ?? {}) as Json)['409'] as Json | undefined;
        if (!response) continue;
        if (typeof response.$ref === 'string') response = resolve(document, response.$ref);

        const content = ((response.content ?? {}) as Json)['application/json'] as Json | undefined;
        let schema = (content?.schema ?? {}) as Json;
        if (typeof schema.$ref === 'string') schema = resolve(document, schema.$ref);

        const code = ((schema.properties ?? {}) as Json).code as Json | undefined;
        found.set(`${method.toUpperCase()} ${path}`, {
          required: (schema.required ?? []) as string[],
          codeEnum: ((code?.enum ?? []) as string[]) ?? [],
        });
      }
    }
  }
  return found;
}

/**
 * 컨트롤러 소스를 `@Contract(...)` 로 끊어 「이 오퍼레이션의 핸들러 본문」 구간을 만든다.
 * 첫 `@Contract` 앞(= import 절)은 버린다 — 파일마다 `FAMILY_CONFLICT_CODE` 를 import 하므로
 * 그것까지 세면 전건이 「넘긴다」로 읽힌다.
 */
function callSites(): { key: string; source: string; passes: boolean }[] {
  const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.controller.ts'))
    .filter((name) => !name.split(/[\\/]/).some((segment) => segment.startsWith('__')))
    .sort();

  const sites: { key: string; source: string; passes: boolean }[] = [];
  for (const file of files) {
    const text = readFileSync(join(SRC, file), 'utf8');
    const marks = [...text.matchAll(/@Contract\(\s*['"]([^'"]+)['"]\s*\)/g)];

    marks.forEach((mark, index) => {
      const start = mark.index ?? 0;
      const end = index + 1 < marks.length ? (marks[index + 1].index ?? text.length) : text.length;
      sites.push({
        key: mark[1],
        source: relative(SRC, join(SRC, file)),
        passes: text.slice(start, end).includes(MARKER),
      });
    });
  }
  return sites;
}

describe('계열 봉투의 `code` — 호출부 배정', () => {
  const schemas = conflictSchemas();
  const sites = callSites();
  /** 계열 = 409 봉투가 `code` 를 **required** 로 둔 것(`*ConflictResponse` 넷). */
  const isFamily = (key: string): boolean => schemas.get(key)?.required.includes('code') === true;

  it('⭐ 계열 봉투인데 `FAMILY_CONFLICT_CODE` 를 안 넘긴 호출부가 없다', () => {
    const missing = sites
      .filter((site) => isFamily(site.key) && !site.passes)
      .map((site) => `${site.source} — ${site.key}`);

    expect(missing).toEqual([]);
  });

  it('⭐ 계열 봉투가 «아닌데» 넘긴 호출부가 없다 — 「언제나 싣기」의 반대 방향', () => {
    // `ConflictResponse`(app·equipment·logistics·mdm)에는 `code` 프로퍼티 자체가 없다.
    // 한 컨트롤러 파일 «안»에서도 갈린다 — `work-order` 의 자원계획 2건 · `production-order:resync`.
    const extra = sites
      .filter((site) => site.passes && !isFamily(site.key))
      .map((site) => `${site.source} — ${site.key}`);

    expect(extra).toEqual([]);
  });

  it('넘긴 호출부가 39건이다 — 계열 43건 중 구현된 몫(#414 실측 + I-25 3 · I-21 3 · I-26 1 · I-22 3 · I-23 1)', () => {
    // ⭐ I-23 이 `POST /logistics/shipments` 를 더했다. 이 슬라이스는 계열 오퍼레이션이 넷
    //    더 온다(`:confirm`·`:request-cancel`·`:cancel`·재등록) ⇒ 그때마다 여기가 먼저 빨개진다.
    //    ⛔ 그것이 이 표의 뜻이다 — 넘기는 것을 잊으면 409 봉투에서 required `code` 가 빠지고
    //      e2e 로는 반증이 안 된다.
    expect(sites.filter((site) => site.passes)).toHaveLength(39);
  });

  it('⭐ 두 값이 계열 네 enum «전부»에 있다 — 계약에서 직접 읽는다', () => {
    const enums = [...schemas.values()]
      .filter((schema) => schema.required.includes('code'))
      .map((schema) => schema.codeEnum);
    expect(enums.length).toBeGreaterThan(0);

    for (const values of enums) {
      expect(values).toContain(FAMILY_CONFLICT_CODE.duplicate);
      expect(values).toContain(FAMILY_CONFLICT_CODE.inProgress);
    }
  });
});

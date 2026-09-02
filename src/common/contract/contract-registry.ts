import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** OpenAPI 3.1 오퍼레이션 객체. 스키마는 검증기가 읽으므로 여기서는 그대로 들고만 있는다. */
export type OpenApiOperation = Record<string, unknown>;

export interface ContractOperation {
  /** `METHOD /path` — 계약 7파일을 통틀어 유일하다. */
  key: string;
  method: string;
  /** OpenAPI 템플릿 경로. `/trace/lots/{lotId}` 처럼 중괄호를 그대로 둔다. */
  path: string;
  /** 어느 계약 파일에서 왔나. 어긋났을 때 어디를 볼지 말해 준다. */
  source: string;
  operation: OpenApiOperation;
  /**
   * 이 오퍼레이션이 들어 있는 계약 문서 전체. 요청 스키마의 `$ref` 가
   * `#/components/...` 로 문서 안을 가리키므로 문서째 있어야 풀 수 있다.
   * 파일 하나당 한 벌을 공유한다 — 오퍼레이션마다 복사하지 않는다.
   */
  document: OpenApiDocument;
  /** 이 오퍼레이션 객체를 문서 루트에서 가리키는 JSON 포인터. */
  pointer: string;
}

export interface OpenApiDocument {
  paths?: Record<string, Record<string, OpenApiOperation>>;
  components?: Record<string, unknown>;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** RFC 6901. `/` 와 `~` 를 escape 하지 않으면 경로에 `/` 가 든 순간 포인터가 어긋난다. */
export function jsonPointerToken(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * 운영 이미지의 WORKDIR 이 `/app` 이고 계약이 `/app/contracts` 에 실린다(Dockerfile runtime).
 * 개발·테스트도 저장소 루트에서 도므로 같은 상대 경로가 선다.
 */
export function defaultContractsDir(): string {
  return join(process.cwd(), 'contracts');
}

/** 계약 7파일을 적재해 `METHOD /path` 로 찾을 수 있게 둔다. */
export class ContractRegistry {
  private constructor(private readonly operations: ReadonlyMap<string, ContractOperation>) {}

  static load(dir: string = defaultContractsDir()): ContractRegistry {
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort();

    // 「없음」을 「통과」로 바꾸지 않는다 — 경로가 어긋나면 검증기가 전건을 무검증으로
    // 흘려보내고, 그것이 오류 없이 조용히 일어난다.
    if (files.length === 0) {
      throw new Error(`계약 파일이 없다: ${dir}`);
    }

    const operations = new Map<string, ContractOperation>();
    for (const file of files) {
      const document = JSON.parse(readFileSync(join(dir, file), 'utf8')) as OpenApiDocument;

      for (const [path, item] of Object.entries(document.paths ?? {})) {
        for (const method of METHODS) {
          const operation = item[method];
          if (!operation) continue;

          const key = `${method.toUpperCase()} ${path}`;
          const existing = operations.get(key);
          if (existing) {
            throw new Error(`계약 오퍼레이션이 겹친다: ${key} (${existing.source} · ${file})`);
          }
          operations.set(key, {
            key,
            method: method.toUpperCase(),
            path,
            source: file,
            operation,
            document,
            pointer: `/paths/${jsonPointerToken(path)}/${method}`,
          });
        }
      }
    }

    return new ContractRegistry(operations);
  }

  get(key: string): ContractOperation | undefined {
    return this.operations.get(key);
  }

  has(key: string): boolean {
    return this.operations.has(key);
  }

  keys(): string[] {
    return [...this.operations.keys()];
  }

  get size(): number {
    return this.operations.size;
  }
}

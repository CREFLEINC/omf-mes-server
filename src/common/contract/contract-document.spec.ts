import { buildContractDocument, servedOperations } from './contract-document';
import { ContractRegistry } from './contract-registry';

describe('계약 문서(/api/docs)', () => {
  const registry = ContractRegistry.load();
  const served = new Set(['GET /mdm/warehouses', 'POST /app/roles']);
  const document = buildContractDocument(served);

  it('⭐ 계약 전건을 싣는다 — 구현된 것만 싣지 않는다', () => {
    expect(document['x-coverage'].total).toBe(registry.size);
    expect(document['x-coverage'].implemented).toBe(served.size);
  });

  it('⭐ 서빙되지 않는 것은 표제로 갈린다', () => {
    const warehouses = document.paths?.['/mdm/warehouses'];
    expect(warehouses?.get).toMatchObject({ 'x-implemented': true });
    expect(String(warehouses?.get?.summary)).not.toContain('미구현');
    expect(warehouses?.post).toMatchObject({ 'x-implemented': false });
    expect(String(warehouses?.post?.summary)).toContain('미구현');
  });

  it('⛔ 내용이 다른 컴포넌트 이름은 출처로 가른다 — 안 그러면 남의 스키마를 가리킨다', () => {
    const schemas = (document.components?.schemas ?? {}) as Record<string, unknown>;

    // 실측: PageMeta 는 파일마다 내용이 다르다.
    expect(schemas['PageMeta']).toBeUndefined();
    expect(schemas['mdm_PageMeta']).toBeDefined();
    expect(schemas['quality_PageMeta']).toBeDefined();
    // 내용이 같은 이름은 그대로 둔다.
    expect(schemas['Warehouse']).toBeDefined();
  });

  it('⛔ 문서 안의 $ref 가 전부 실재한다 — 하나라도 끊기면 화면이 스키마를 못 푼다', () => {
    const dangling: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (value === null || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (key === '$ref' && typeof item === 'string') {
          const match = /^#\/components\/([^/]+)\/(.+)$/.exec(item);
          const bag = match
            ? ((document.components as Record<string, Record<string, unknown>>)[match[1]] ?? {})
            : {};
          if (!match || !(match[2] in bag)) dangling.push(item);
          continue;
        }
        walk(item);
      }
    };
    walk(document.paths);
    walk(document.components);

    expect([...new Set(dangling)]).toEqual([]);
  });

  it('도메인 태그로 묶는다 — 최상위 경로가 곧 축이다', () => {
    const names = (document.tags ?? []).map((tag) => tag.name);

    expect(names).toEqual(expect.arrayContaining(['app', 'mdm', 'planning', 'quality', 'logistics']));
  });

  it('반사 문서의 경로를 계약 키로 되돌린다', () => {
    const keys = servedOperations(
      {
        paths: {
          '/api/mdm/warehouses': { get: {}, post: {} },
          '/api/mdm/warehouses/{warehouseId}:activate': { post: {} },
          '/api/health': { get: {} },
          '/metrics': { get: {} },
        },
      },
      'api',
    );

    expect([...keys].sort()).toEqual([
      'GET /health',
      'GET /mdm/warehouses',
      'POST /mdm/warehouses',
      'POST /mdm/warehouses/{warehouseId}:activate',
    ]);
  });
});

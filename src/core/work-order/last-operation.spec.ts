import { isLastOperation } from './last-operation';

/** 그 Routing 의 공정 순번들만 가진 가짜 — `aggregate` 가 받은 조건을 남긴다. */
function db(seqsByRouting: Record<string, number[]>) {
  const wheres: unknown[] = [];
  return {
    wheres,
    db: {
      routing_operation: {
        aggregate: ({ where }: { where: { routing_id: bigint } }) => {
          wheres.push(where);
          const seqs = seqsByRouting[String(where.routing_id)] ?? [];
          return Promise.resolve({ _max: { operation_seq: seqs.length === 0 ? null : Math.max(...seqs) } });
        },
      },
    } as never,
  };
}

describe('isLastOperation', () => {
  it('FR-001 — 최대 공정 순번만 마지막이다(10·20·30 중 30)', async () => {
    const { db: fake } = db({ '7': [10, 20, 30] });
    expect(await isLastOperation(fake, { routing_id: 7n, operation_seq: 10 })).toBe(false);
    expect(await isLastOperation(fake, { routing_id: 7n, operation_seq: 20 })).toBe(false);
    expect(await isLastOperation(fake, { routing_id: 7n, operation_seq: 30 })).toBe(true);
  });

  it('FR-001 — 공정이 하나면 그 공정이 마지막이다', async () => {
    const { db: fake } = db({ '8': [10] });
    expect(await isLastOperation(fake, { routing_id: 8n, operation_seq: 10 })).toBe(true);
  });

  it('FR-001 — 그 공정의 Routing 안에서만 센다(다른 Routing 의 더 큰 순번은 보지 않는다)', async () => {
    const { db: fake, wheres } = db({ '7': [10, 20], '9': [10, 20, 90] });
    expect(await isLastOperation(fake, { routing_id: 7n, operation_seq: 20 })).toBe(true);
    expect(wheres).toEqual([{ routing_id: 7n }]);
  });
});

import { MESSAGE_STATUS } from '../message/integration-message.service';
import { PrismaService } from '../../prisma/prisma.service';
import { INBOUND, InboundCycle, InboundTable, MAX_ATTEMPTS, Tx, UnitTable } from './inbound-cycle';
import { RelayClient, RelayCursor } from './relay-client';
import { RelayRow, RelayTable, orderColumns } from './relay-tables';

const SOURCE: RelayTable = {
  interfaceCode: 'IF-TEST-RECV',
  targetTypeCode: 'TEST',
  name: 'T_TEST',
  label: '시험',
  flagColumn: 'IF_YN',
  keyColumns: ['CODE'],
  versionColumn: 'T_SEQ',
};

type Message = Record<string, unknown>;

function row(id: number, code: string, seq = 1): RelayRow {
  return { MES_INF_ID: id, CODE: code, T_SEQ: seq, IF_YN: 'N' };
}

/** 코드 앞 네 글자가 같은 행을 한 단위로 묶는다(BOM 의 모품목 자리). */
function unitTable(units: string[][], fail: string[] = []): UnitTable {
  return {
    source: SOURCE,
    unitOf: (r) => (r.CODE as string).slice(0, 4),
    applyUnit: async (_: Tx, rows: RelayRow[]) => {
      if (rows.some((r) => fail.includes(r.CODE as string))) throw new Error('단위 실패');
      units.push(rows.map((r) => r.CODE as string));
    },
  };
}

/** 앞에서부터 비교한다 — 실제 쿼리의 ORDER BY 와 같은 순서. */
function compare(a: unknown[], b: unknown[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) continue;
    return (a[i] as number | string) < (b[i] as number | string) ? -1 : 1;
  }
  return 0;
}

/**
 * 중계 DB 와 MES 를 흉내낸다. 무엇을 어떤 순서로 불렀는지(`calls`)와 트랜잭션 안에서
 * 중계 DB 를 불렀는지(`relayInTx`)가 이 스위트의 목이다.
 */
function fake(rows: RelayRow[], seed: { messages?: Message[] } = {}) {
  const calls: string[] = [];
  const messages = new Map<string, Message>(
    (seed.messages ?? []).map((m) => [m.message_key as string, m]),
  );
  let inTx = false;
  let relayInTx = false;
  const key = (r: RelayRow): unknown[] => orderColumns(SOURCE).map((c) => r[c]);

  const relay = {
    fetchPending: async (_: RelayTable, after: RelayCursor | undefined, limit: number) => {
      relayInTx ||= inTx;
      calls.push('fetch');
      return rows
        .filter((r) => r.IF_YN === 'N' && (after === undefined || compare(key(r), after) > 0))
        .sort((a, b) => compare(key(a), key(b)))
        .slice(0, limit);
    },
    writeError: async (_: RelayTable, id: number, message: string) => {
      relayInTx ||= inTx;
      calls.push(`error ${id} ${message}`);
    },
    ack: async (_: RelayTable, ids: number[]) => {
      relayInTx ||= inTx;
      calls.push(`ack ${ids.join(',')}`);
      rows.filter((r) => ids.includes(r.MES_INF_ID)).forEach((r) => (r.IF_YN = 'Y'));
    },
  };

  const upsert = async (a: {
    where: { message_key: string };
    create: Message;
    update: Message;
  }) => {
    const found = messages.get(a.where.message_key);
    if (found === undefined) {
      messages.set(a.where.message_key, { message_key: a.where.message_key, ...a.create });
      return;
    }
    const increment = (a.update.retry_count as { increment?: number } | undefined)?.increment;
    messages.set(a.where.message_key, {
      ...found,
      ...a.update,
      retry_count: (found.retry_count as number) + (increment ?? 0),
    });
  };
  const integration_message = {
    upsert,
    findMany: async (a: { where: Message }) =>
      [...messages.values()].filter(
        (m) =>
          m.interface_code === a.where.interface_code &&
          m.status_code === a.where.status_code &&
          (m.retry_count as number) >= (a.where.retry_count as { gte: number }).gte,
      ),
  };
  const prisma = {
    integration_message,
    $transaction: async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => {
      inTx = true;
      try {
        return await fn({ integration_message } as unknown as Tx);
      } finally {
        inTx = false;
      }
    },
  };
  const cycle = new InboundCycle(
    prisma as unknown as PrismaService,
    relay as unknown as RelayClient,
  );
  return { cycle, calls, messages, rows, relayInTx: () => relayInTx, inTx: () => inTx };
}

/** `fail` 에 든 코드는 반영에서 던진다. */
function table(fail: string[] = [], applied: string[] = []): InboundTable {
  return {
    source: SOURCE,
    apply: async (_: Tx, r: RelayRow) => {
      if (fail.includes(r.CODE as string)) throw new Error(`${r.CODE as string} 반영 실패`);
      applied.push(`${r.CODE as string}#${r.T_SEQ as number}`);
    },
  };
}

describe('InboundCycle', () => {
  it('반영한 행만 확인 표시하고 실패한 행은 N 으로 둔다', async () => {
    const f = fake([row(1, 'A'), row(2, 'B'), row(3, 'C')]);

    const result = await f.cycle.run(table(['B']));

    expect(result).toEqual({ read: 3, applied: 2, failed: 1, held: 0 });
    expect(f.calls).toContain('ack 1,3');
    expect(f.rows.map((r) => r.IF_YN)).toEqual(['Y', 'N', 'Y']);
    expect(f.messages.get('IF-TEST-RECV:2')).toMatchObject({
      direction_code: INBOUND,
      target_type_code: 'TEST',
      target_id: 2,
      status_code: MESSAGE_STATUS.FAILED,
      retry_count: 1,
      last_error_message: 'B 반영 실패',
    });
    expect(f.messages.get('IF-TEST-RECV:1')).toMatchObject({
      status_code: MESSAGE_STATUS.DONE,
      payload: { key: 'A', seq: 1, row: row(1, 'A') },
    });
  });

  it('반영이 돌려준 커밋 뒤 할 일은 확인 표시와 리스 연장 뒤 트랜잭션 밖에서 부르고, 실패해도 반영을 실패로 돌리지 않는다', async () => {
    const f = fake([row(1, 'A'), row(2, 'B')]);
    const withAfter: InboundTable = {
      source: SOURCE,
      apply: async (_: Tx, r: RelayRow) => async () => {
        f.calls.push(`after ${r.CODE as string} ${f.inTx() ? '안' : '밖'}`);
        if (r.CODE === 'B') throw new Error('뒤 처리 실패');
      },
    };

    const result = await f.cycle.run(withAfter, async () => {
      f.calls.push('renew');
    });

    expect(result).toEqual({ read: 2, applied: 2, failed: 0, held: 0 });
    expect(f.calls).toEqual(['fetch', 'ack 1,2', 'renew', 'after A 밖', 'after B 밖']);
    expect(f.messages.get('IF-TEST-RECV:2')).toMatchObject({ status_code: MESSAGE_STATUS.DONE });
  });

  it('커밋 뒤 할 일이 많으면 중간중간 리스를 늘린다', async () => {
    const f = fake(Array.from({ length: 45 }, (_, index) => row(index + 1, `C${String(index).padStart(2, '0')}`)));
    let renewals = 0;
    const withAfter: InboundTable = { source: SOURCE, apply: async () => async () => undefined };

    await f.cycle.run(withAfter, async () => {
      renewals += 1;
    });

    // 묶음 뒤 한 번 + 20건·40건째 앞에서 한 번씩.
    expect(renewals).toBe(3);
  });

  it('실패 사유는 표시를 마친 뒤 원본 행에 남긴다', async () => {
    const f = fake([row(1, 'A'), row(2, 'B')]);

    await f.cycle.run(table(['B']));

    expect(f.calls).toEqual(['fetch', 'ack 1', 'error 2 B 반영 실패']);
  });

  it('앞 판이 실패한 업무 키의 뒤 판은 반영도 표시도 하지 않는다', async () => {
    const applied: string[] = [];
    const f = fake([row(1, 'A', 1), row(2, 'A', 2), row(3, 'B', 1)]);

    const result = await f.cycle.run({
      source: SOURCE,
      apply: async (_: Tx, r: RelayRow) => {
        if (r.MES_INF_ID === 1) throw new Error('첫 판 실패');
        applied.push(`${r.CODE as string}#${r.T_SEQ as number}`);
      },
    });

    expect(result).toEqual({ read: 3, applied: 1, failed: 1, held: 1 });
    expect(applied).toEqual(['B#1']);
    expect(f.rows.map((r) => r.IF_YN)).toEqual(['N', 'N', 'Y']);
    expect(f.messages.has('IF-TEST-RECV:2')).toBe(false);
  });

  it(`${MAX_ATTEMPTS}번 실패한 행과 그 업무 키의 뒤 판은 반영하지 않는다`, async () => {
    const applied: string[] = [];
    const quarantined = {
      message_key: 'IF-TEST-RECV:1',
      interface_code: SOURCE.interfaceCode,
      direction_code: INBOUND,
      status_code: MESSAGE_STATUS.FAILED,
      retry_count: MAX_ATTEMPTS,
      target_id: 1n,
      payload: { key: 'A' },
    };
    const f = fake([row(1, 'A', 1), row(2, 'A', 2), row(3, 'B', 1)], { messages: [quarantined] });

    const result = await f.cycle.run(table([], applied));

    expect(result).toEqual({ read: 3, applied: 1, failed: 0, held: 2 });
    expect(applied).toEqual(['B#1']);
    expect(f.messages.get('IF-TEST-RECV:1')).toMatchObject({ retry_count: MAX_ATTEMPTS });
  });

  it(`${MAX_ATTEMPTS - 1}번 실패한 행은 다시 시도하고, 또 실패하면 격리 기준에 닿는다`, async () => {
    const tried = {
      message_key: 'IF-TEST-RECV:1',
      interface_code: SOURCE.interfaceCode,
      status_code: MESSAGE_STATUS.FAILED,
      retry_count: MAX_ATTEMPTS - 1,
      target_id: 1n,
      payload: { key: 'A' },
    };
    const f = fake([row(1, 'A')], { messages: [tried] });

    const result = await f.cycle.run(table(['A']));

    expect(result.failed).toBe(1);
    expect(f.messages.get('IF-TEST-RECV:1')).toMatchObject({ retry_count: MAX_ATTEMPTS });
  });

  it('표시 전에 멈춰 같은 행이 다시 와도 메시지는 하나다', async () => {
    const f = fake([row(1, 'A')]);
    await f.cycle.run(table());
    f.rows[0].IF_YN = 'N'; // 'Y' 를 올리기 전에 죽은 것과 같다.

    await f.cycle.run(table());

    expect([...f.messages.keys()]).toEqual(['IF-TEST-RECV:1']);
    expect(f.messages.get('IF-TEST-RECV:1')).toMatchObject({ status_code: MESSAGE_STATUS.DONE });
  });

  it('실패했던 행이 다음 회차에 반영되면 DONE 으로 바뀌고 오류를 지운다', async () => {
    const f = fake([row(1, 'A')]);
    await f.cycle.run(table(['A']));

    await f.cycle.run(table());

    expect(f.messages.get('IF-TEST-RECV:1')).toMatchObject({
      status_code: MESSAGE_STATUS.DONE,
      last_error_message: null,
    });
  });

  it('묶음 열쇠가 같은 이웃 행은 한 트랜잭션에 함께 반영한다', async () => {
    const units: string[][] = [];
    const f = fake([row(1, 'P001-a'), row(2, 'P001-b'), row(3, 'P002-a')]);

    const result = await f.cycle.run(unitTable(units));

    expect(result).toEqual({ read: 3, applied: 3, failed: 0, held: 0 });
    expect(units).toEqual([['P001-a', 'P001-b'], ['P002-a']]);
    expect(f.calls).toContain('ack 1,2,3');
  });

  it('꽉 찬 묶음의 끝에서 잘린 단위는 다음 묶음으로 미뤄 한 번에 반영한다', async () => {
    const units: string[][] = [];
    // 단위마다 3행 — 500행 묶음의 끝 단위(167번째)는 2행만 들어와 잘린다.
    const rows = Array.from({ length: 501 }, (_, i) =>
      row(i + 1, `${String(Math.floor(i / 3)).padStart(4, '0')}-${i % 3}`),
    );
    const f = fake(rows);

    const result = await f.cycle.run(unitTable(units));

    expect(result).toEqual({ read: 501, applied: 501, failed: 0, held: 0 });
    expect(units).toHaveLength(167);
    expect(units.every((unit) => unit.length === 3)).toBe(true);
  });

  it('단위의 한 행이라도 격리돼 있으면 단위 전체를 보류한다', async () => {
    const units: string[][] = [];
    const quarantined = {
      message_key: 'IF-TEST-RECV:2',
      interface_code: SOURCE.interfaceCode,
      status_code: MESSAGE_STATUS.FAILED,
      retry_count: MAX_ATTEMPTS,
      target_id: 2n,
      // 업무 키가 없는 기록이라도 행 번호로 막는다.
      payload: {},
    };
    const f = fake([row(1, 'P001-a'), row(2, 'P001-b'), row(3, 'P002-a')], {
      messages: [quarantined],
    });

    const result = await f.cycle.run(unitTable(units));

    expect(result).toEqual({ read: 3, applied: 1, failed: 0, held: 2 });
    expect(units).toEqual([['P002-a']]);
  });

  it('단위 반영이 실패하면 그 단위의 행이 모두 실패로 남는다', async () => {
    const f = fake([row(1, 'P001-a'), row(2, 'P001-b'), row(3, 'P002-a')]);

    const result = await f.cycle.run(unitTable([], ['P001-b']));

    expect(result).toEqual({ read: 3, applied: 1, failed: 2, held: 0 });
    expect(f.calls).toEqual(['fetch', 'ack 3', 'error 1 단위 실패', 'error 2 단위 실패']);
  });

  it('Postgres 트랜잭션 안에서 중계 DB 를 부르지 않는다', async () => {
    const f = fake([row(1, 'A'), row(2, 'B')]);

    await f.cycle.run(table(['B']));

    expect(f.relayInTx()).toBe(false);
  });

  it('남은 행이 없을 때까지 묶음을 되풀이한다', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) =>
      row(i + 1, `K${String(i).padStart(4, '0')}`),
    );
    const f = fake(rows);

    const result = await f.cycle.run(table());

    expect(result.applied).toBe(1001);
    expect(f.calls.filter((c) => c === 'fetch')).toHaveLength(3);
    expect(f.rows.every((r) => r.IF_YN === 'Y')).toBe(true);
  });

  it('실패로 N 에 남은 행을 같은 회차에 다시 읽지 않는다', async () => {
    const rows = Array.from({ length: 501 }, (_, i) =>
      row(i + 1, `K${String(i).padStart(4, '0')}`),
    );
    const f = fake(rows);

    const result = await f.cycle.run(table(['K0000']));

    expect(result).toEqual({ read: 501, applied: 500, failed: 1, held: 0 });
    expect(f.calls.filter((c) => c === 'fetch')).toHaveLength(2);
  });
});

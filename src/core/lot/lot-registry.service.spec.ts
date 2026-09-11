import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { LotHoldService } from './lot-hold.service';
import {
  LotPreIssueInput,
  LotRegisterInput,
  LotRegistryService,
  Tx,
  nextMesLotNos,
  slotQtys,
} from './lot-registry.service';

const LOT_ID = 900n;
const LINE_ID = 41;
const USED_LOTS = 7;
const dec = (v: string) => new Prisma.Decimal(v);

type Args = Record<string, unknown>;
type Seed = {
  line?: { lot_id: bigint | null };
  iqcPlans?: { inspection_plan_version_id: bigint }[];
};

/**
 * 「그 트랜잭션의 표」를 흉내낸다 — 어느 객체로 읽고 썼는지가 이 스위트의 목이라
 * 호출을 부른 순서 그대로 담는다.
 */
function fake(seed: Seed) {
  const calls: string[] = [];
  const args: Args[] = [];
  const record =
    <T>(name: string, result: (a: Args) => T) =>
    async (a: Args) => {
      calls.push(name);
      args.push(a);
      return result(a);
    };
  let line = seed.line ?? null;
  const created: Args[] = [];
  const tx = {
    // 등록 코어가 코어 보류를 태우면서 `lot` 을 먼저 잠근다(R-5) — 원문 SQL 이라 따로 받는다.
    $queryRaw: async (strings: TemplateStringsArray) => {
      calls.push('lot.lock');
      args.push({ sql: strings.join('?') });
      return [{ lot_id: LOT_ID, status_code: 'INSPECTION_PENDING', version_no: 1 }];
    },
    lot: {
      create: record('lot.create', (a) => {
        created.push(a.data as Args);
        return { lot_id: LOT_ID + BigInt(created.length - 1) };
      }),
      findUniqueOrThrow: record('lot.findUniqueOrThrow', () => ({
        lot_id: LOT_ID,
        lot_hold: [],
      })),
      findMany: record('lot.findMany', () =>
        created.map((data, i) => ({
          ...data,
          lot_id: LOT_ID + BigInt(i),
          lot_hold: [],
        })),
      ),
      count: record('lot.count', () => USED_LOTS),
    },
    lot_hold: { create: record('lot_hold.create', () => ({})) },
    lot_external_identifier: {
      create: record('identifier.create', () => ({})),
    },
    inspection_plan_version: {
      findMany: record('iqc.plan.findMany', () => seed.iqcPlans ?? []),
    },
    inspection_request: { create: record('iqc.request.create', () => ({})) },
    inbound_receipt_line: {
      updateMany: record('line.updateMany', () => {
        const hit = line !== null && line.lot_id === null;
        if (hit) line = { lot_id: LOT_ID };
        return { count: hit ? 1 : 0 };
      }),
      findUnique: record('line.findUnique', () => line),
    },
  };
  return { tx: tx as unknown as Tx, calls, args, created };
}

function input(extra: Partial<LotRegisterInput> = {}): LotRegisterInput {
  return {
    lotNo: 'SUP-1',
    itemId: 1,
    lotTypeCode: 'MATERIAL',
    plantId: 2,
    initialQty: 10,
    uomId: 3,
    sourceTypeCode: 'INBOUND_RECEIPT_LINE',
    sourceId: LINE_ID,
    ...extra,
  };
}

function preIssue(extra: Partial<LotPreIssueInput> = {}): LotPreIssueInput {
  return {
    workOrderId: 55n,
    plantId: 2,
    itemId: 1,
    uomId: 3,
    bomId: 8,
    bomVersion: 2,
    lotNos: ['A', 'B', 'C'],
    qtys: [dec('300'), dec('300'), dec('100')],
    ...extra,
  };
}

describe('LotRegistryService', () => {
  const service = new LotRegistryService(new LotHoldService());

  it('LOT 코어 — 읽기도 tx 로 한다(같은 트랜잭션의 라인을 본다)', async () => {
    // 라인은 «이 트랜잭션 안»에만 있다 — 코어가 다른 연결로 읽으면 못 보고 400 이 된다.
    const { tx, calls, args } = fake({ line: { lot_id: null } });

    await service.createWithin(tx, input(), 7);

    expect(calls).toContain('line.updateMany');
    expect(args[calls.indexOf('line.updateMany')].where).toEqual({
      inbound_receipt_line_id: LINE_ID,
      lot_id: null,
    });
    // 정상 경로는 판별 읽기를 더하지 않는다.
    expect(calls).not.toContain('line.findUnique');
  });

  it('LOT 코어 — 이미 lot_id 가 있는 라인에 다시 채우면 400 STATE_LOCKED 다', async () => {
    const { tx } = fake({ line: { lot_id: 111n } });

    await expect(service.createWithin(tx, input(), 7)).rejects.toMatchObject({
      errors: [{ field: 'sourceId', code: 'STATE_LOCKED' }],
    });
  });

  it('LOT 코어 — 없는 라인이면 400 INVALID 다', async () => {
    const { tx } = fake({});

    const failure = await service.createWithin(tx, input(), 7).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractException);
    expect((failure as ContractException).errors[0]).toMatchObject({
      field: 'sourceId',
      code: 'INVALID',
    });
  });

  it('LOT 코어 — 라인 → LOT → 라인 UPDATE 순서다', async () => {
    const { tx, calls } = fake({ line: { lot_id: null } });

    await service.createWithin(tx, input(), 7);

    // 라인은 코어가 불리기 «전에» 서 있다(`lot.source_id` 가 라인 id 다).
    expect(calls.indexOf('lot.create')).toBeLessThan(calls.indexOf('line.updateMany'));
    expect(calls.indexOf('lot_hold.create')).toBeGreaterThan(calls.indexOf('lot.create'));
    // ⭐⭐ R-5 — 보류 쓰기 «앞»에 `lot` 잠금이 선다(코어가 표식으로 강제하는 순서다).
    expect(calls.indexOf('lot.lock')).toBeLessThan(calls.indexOf('lot_hold.create'));
  });

  it('LOT 코어 — 입하 라인이 아닌 원천은 라인을 만지지 않는다', async () => {
    const { tx, calls } = fake({});

    await service.createWithin(tx, input({ sourceTypeCode: 'WORK_ORDER' }), 7);

    expect(calls).not.toContain('line.updateMany');
  });

  it('LOT 코어 — IQC 계획이 정확히 하나면 LOT과 같은 트랜잭션에서 의뢰를 한 건 만든다', async () => {
    const { tx, calls, args } = fake({
      line: { lot_id: null },
      iqcPlans: [{ inspection_plan_version_id: 55n }],
    });

    await service.createWithin(
      tx,
      input({
        incomingIqc: {
          requestNo: 'IRQ-20260911-0001',
          effectiveDate: '2026-09-11',
          requestedAt: '2026-09-11T01:00:00.000Z',
        },
      }),
      7,
    );

    expect(calls.filter((call) => call === 'iqc.request.create')).toHaveLength(1);
    expect(args[calls.indexOf('iqc.request.create')].data).toMatchObject({
      inspection_request_no: 'IRQ-20260911-0001',
      inspection_plan_version_id: 55n,
      lot_id: LOT_ID,
      target_qty: 10,
      status_code: 'REQUESTED',
    });
  });

  it('LOT 코어 — 유효한 IQC 계획이 복수면 임의 선택하지 않고 LOT 생성 전에 막는다', async () => {
    const { tx, calls } = fake({
      line: { lot_id: null },
      iqcPlans: [{ inspection_plan_version_id: 55n }, { inspection_plan_version_id: 56n }],
    });

    await expect(
      service.createWithin(
        tx,
        input({
          incomingIqc: {
            requestNo: 'IRQ-20260911-0001',
            effectiveDate: '2026-09-11',
            requestedAt: '2026-09-11T01:00:00.000Z',
          },
        }),
        7,
      ),
    ).rejects.toMatchObject({ errors: [{ code: 'STATE_LOCKED' }] });
    expect(calls).not.toContain('lot.create');
  });
});

describe('선발행 슬롯', () => {
  const service = new LotRegistryService(new LotHoldService());

  it('슬롯 — N = 올림(orderQty ÷ lotSize) 이고 마지막만 나머지다(1000/300 → 300·300·300·100)', () => {
    expect(slotQtys(dec('1000'), dec('300')).map(String)).toEqual(['300', '300', '300', '100']);
  });

  it('슬롯 — lotSize ≥ orderQty 면 슬롯 1개이고 수량은 orderQty 다(lotSize 가 아니다)', () => {
    expect(slotQtys(dec('1000'), dec('1000')).map(String)).toEqual(['1000']);
    // 5000 이 아니라 1000 이다 — 「전량 1슬롯」(W-02-07).
    expect(slotQtys(dec('1000'), dec('5000')).map(String)).toEqual(['1000']);
  });

  it('슬롯 — lotSize ≤ 0 이면 400 이다(무한 루프·CHECK 500 을 앞당겨 막는다)', () => {
    const failure = (() => {
      try {
        slotQtys(dec('1000'), dec('0'));
      } catch (e: unknown) {
        return e;
      }
    })();
    expect(failure).toBeInstanceOf(ContractException);
    expect((failure as ContractException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect((failure as ContractException).errors[0]).toMatchObject({
      field: 'lotSize',
      code: 'INVALID',
    });
  });

  it('슬롯 — 소수 수량도 Decimal 로 나눠 합이 지시수량과 정확히 같다(0.5/0.2 → 0.2·0.2·0.1)', () => {
    const qtys = slotQtys(dec('0.5'), dec('0.2'));
    expect(qtys.map(String)).toEqual(['0.2', '0.2', '0.1']);
    // 부동소수면 0.30000000000000004 가 나오는 자리다.
    expect(qtys.reduce((a, b) => a.plus(b), dec('0')).equals(dec('0.5'))).toBe(true);
  });

  it('슬롯 — work_order_lot_seq 는 1부터 N 까지 빠짐없이 찍힌다', async () => {
    const { tx, created } = fake({});

    const rows = await service.preIssueWithin(tx, preIssue(), 7);

    expect(created.map((d) => d.work_order_lot_seq)).toEqual([1, 2, 3]);
    expect(created.map((d) => d.lot_no)).toEqual(['A', 'B', 'C']);
    expect(created.map((d) => d.lifecycle_status_code)).toEqual(['WAITING', 'WAITING', 'WAITING']);
    expect(created[0]).toMatchObject({
      lot_type_code: 'PRODUCTION',
      status_code: 'INSPECTION_PENDING',
      source_type_code: 'WORK_ORDER',
      source_id: 55n,
    });
    expect(rows).toHaveLength(3);
  });

  it('슬롯 — lot_hold 를 만들지 않는다(입하 등록과 다르다)', async () => {
    const { tx, calls } = fake({});

    await service.preIssueWithin(tx, preIssue(), 7);

    expect(calls).not.toContain('lot_hold.create');
    // 이력도 안 쓴다 — WAITING 은 태어남이지 전이가 아니다.
    expect(calls).not.toContain('lifecycle_history.create');
  });

  it('슬롯 — bom_id 와 bom_version 은 둘 다 차거나 둘 다 빈다', async () => {
    const { tx, created } = fake({});

    await service.preIssueWithin(tx, preIssue({ bomId: null, bomVersion: null }), 7);
    expect(created[0]).toMatchObject({ bom_id: null, bom_version: null });

    // 짝이 어긋나면 호출자 버그다 — 400 이 아니라 Error 다.
    const half = fake({});
    await expect(service.preIssueWithin(half.tx, preIssue({ bomVersion: null }), 7)).rejects.toThrow(
      /ck_lot_bom_snapshot/,
    );
  });

  it('번호 — count 를 한 번 읽어 used+1…used+N 을 찍는다', async () => {
    const { tx, calls } = fake({});

    const lotNos = await nextMesLotNos(tx, 2, '2026-09-06', 3);

    expect(calls.filter((c) => c === 'lot.count')).toHaveLength(1);
    expect(lotNos.map((no) => no.slice(15, 21))).toEqual(['000008', '000009', '000010']);
    expect(new Set(lotNos).size).toBe(3);
  });
});

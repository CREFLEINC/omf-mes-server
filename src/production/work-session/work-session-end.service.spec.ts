import { WorkOrderNotifier } from '../work-order/work-order-notice';
import { ContractException } from '../../common/errors';
import { DocumentStateService } from '../../core/document-state';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkSessionEndService } from './work-session-end.service';

type Row = Record<string, unknown>;

const SESSION = 1001;
const STARTED_AT = '2026-09-07T02:00:00.000Z';
const ENDED_AT = '2026-09-07T06:00:00.000Z';

const context = { workerNo: 'W-1', version: undefined, appUserId: 5, terminalId: 77n };

function stub(options: { status?: string } = {}) {
  const updates: Row[] = [];
  const events: Row[] = [];
  const touched = new Set<string>();
  const closed: unknown[][] = [];

  const target = {
    $executeRaw: (_sql: TemplateStringsArray, ...values: unknown[]) => {
      closed.push(values);
      return Promise.resolve(1);
    },
    $queryRaw: () =>
      Promise.resolve([
        { started_at: new Date(STARTED_AT), status_code: options.status ?? 'RUNNING', version_no: 1 },
      ]),
    work_session: {
      update: ({ data }: { data: Row }) => {
        updates.push(data);
        return Promise.resolve({
          work_session_id: BigInt(SESSION),
          work_order_id: 900n,
          session_no: 1,
          shift_id: null,
          equipment_id: null,
          mold_id: null,
          terminal_id: 77n,
          started_at: new Date(STARTED_AT),
          ended_at: new Date(ENDED_AT),
          status_code: 'ENDED',
          stop_reason_code: null,
          remarks: null,
          version_no: 2,
        });
      },
    },
    work_session_event: {
      create: ({ data }: { data: Row }) => {
        events.push(data);
        return Promise.resolve({});
      },
    },
  };
  // 어느 표를 «읽었는지» 남긴다 — 「읽지 않는다」를 단언하려면 접근 자체를 봐야 한다.
  const tx = new Proxy(target, {
    get(source, key: string) {
      touched.add(key);
      return (source as Record<string, unknown>)[key];
    },
  });

  const prisma = {
    worker: { findUnique: async () => ({ worker_id: 1n }) },
    $transaction: (work: (client: unknown) => Promise<unknown>) => work(tx),
  } as unknown as PrismaService;

  return { service: new WorkSessionEndService(prisma, new DocumentStateService(), { notify: () => Promise.resolve() } as unknown as WorkOrderNotifier), updates, events, touched, closed };
}

describe('WorkSessionEndService.end', () => {
  it(':end 가 work_order 를 UPDATE 하지 않는다', async () => {
    const it0 = stub();
    const view = await it0.service.end(SESSION, { endedAt: ENDED_AT }, context);
    expect(view.statusCode).toBe('ENDED');
    expect([...it0.touched]).not.toContain('work_order');
    expect(it0.events[0]).toMatchObject({ event_type_code: 'END', terminal_id: 77n });
  });

  it(':end 가 남은 참여자를 종료 시각으로 닫는다', async () => {
    const it0 = stub();
    await it0.service.end(SESSION, { endedAt: ENDED_AT }, context);
    expect(it0.closed).toEqual([[new Date(ENDED_AT), BigInt(SESSION)]]);
  });

  it(':end 는 terminal_process 를 읽지 않는다', async () => {
    const it0 = stub();
    await it0.service.end(SESSION, { endedAt: ENDED_AT }, context);
    expect([...it0.touched]).not.toContain('terminal_process');
  });

  it(':end 가 work_session_worker.left_at 을 찍지 않는다', async () => {
    // 설계 미정 — 문의 058
    const it0 = stub();
    await it0.service.end(SESSION, { endedAt: ENDED_AT }, context);
    expect([...it0.touched]).not.toContain('work_session_worker');
  });

  it('stopReasonCode 는 받되 저장하지 않고 400 도 내지 않는다', async () => {
    const it0 = stub();
    await it0.service.end(SESSION, { endedAt: ENDED_AT, stopReasonCode: 'MOLD_CHANGE' }, context);
    expect(it0.updates[0]).not.toHaveProperty('stop_reason_code');
  });

  it('endedAt 이 startedAt 보다 앞서면 400 RANGE 다', async () => {
    const it0 = stub();
    const error = (await it0.service
      .end(SESSION, { endedAt: '2026-09-07T01:00:00.000Z' }, context)
      .catch((e: unknown) => e)) as ContractException;
    expect(error.getStatus()).toBe(400);
    expect(error.errors[0]).toMatchObject({ field: 'endedAt', code: 'RANGE' });
    expect(it0.updates).toEqual([]);
  });

  it('이미 ENDED 면 400 STATE_LOCKED 다', async () => {
    const it0 = stub({ status: 'ENDED' });
    const error = (await it0.service.end(SESSION, { endedAt: ENDED_AT }, context).catch((e: unknown) => e)) as ContractException;
    expect(error.getStatus()).toBe(400);
    expect(error.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    // 관리웹 강제 종료 뒤 단말이 보낸 종료가 여기 닿는다 — 다시 할 일을 알려 준다.
    expect(error.errors[0].message).toContain('작업 시작을 다시');
  });
});

describe('WorkSessionEndService.forceEnd', () => {
  it('관리웹 강제 종료는 서버 시각으로 닫고 사건 FORCE_END 에 계정·사유를 남긴다 — 단말은 비운다', async () => {
    const it0 = stub({ status: 'STOPPED' });
    const before = Date.now();

    const view = await it0.service.forceEnd(SESSION, { reason: '단말 고장' }, 5);

    expect(view.statusCode).toBe('ENDED');
    expect(it0.events[0]).toMatchObject({ event_type_code: 'FORCE_END', performed_by: 5n, terminal_id: null, remarks: '단말 고장' });
    const endedAt = it0.updates[0].ended_at as Date;
    expect(endedAt.getTime()).toBeGreaterThanOrEqual(before);
    // 남은 참여자도 같은 시각으로 닫는다.
    expect(it0.closed[0]).toContain(endedAt);
  });

  it('이미 종료된 세션은 400 STATE_LOCKED 이고 새로 고치라고 알려 준다', async () => {
    const error = await stub({ status: 'ENDED' }).service.forceEnd(SESSION, { reason: '단말 고장' }, 5).catch((e: unknown) => e);

    expect((error as ContractException).errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    expect((error as ContractException).errors[0].message).toContain('새로 고쳐');
  });

  it('사유가 비면 400 이다', async () => {
    await expect(stub().service.forceEnd(SESSION, { reason: '  ' }, 5)).rejects.toBeInstanceOf(ContractException);
  });
});

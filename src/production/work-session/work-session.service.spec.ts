import { Prisma } from '@prisma/client';

import { ConflictException, ContractException } from '../../common/errors';
import { DocumentStateService } from '../../core/document-state';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkSessionContext, WorkSessionCreate, WorkSessionService } from './work-session.service';

type Row = Record<string, unknown>;

const WORK_ORDER = 900;
const TERMINAL = 77n;
const STARTED_AT = '2026-09-07T02:00:00.000Z';

/** BigInt 를 문자열로 바꿔 직렬화한다 — 단언에 쓰는 스냅숏 용도다. */
const dump = (value: unknown): string => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
const body = (extra: Partial<WorkSessionCreate> = {}): WorkSessionCreate => ({
  workOrderId: WORK_ORDER,
  startedAt: STARTED_AT,
  ...extra,
});

const context = (extra: Partial<WorkSessionContext> = {}): WorkSessionContext => ({
  workerNo: 'W-1',
  idempotencyKey: 'IDEM-1',
  version: undefined,
  appUserId: 5,
  terminalId: TERMINAL,
  ...extra,
});

function stub(options: { status?: string; maxSessionNo?: number | null; openSession?: boolean; canStartWork?: boolean | null; timezone?: string } = {}) {
  const created: Row[] = [];
  const events: Row[] = [];
  const workers: Row[] = [];
  const updates: Row[] = [];
  const calls: string[] = [];
  const touched = new Set<string>();

  const sessionRow = (data: Row) => ({
    work_session_id: 1n,
    work_order_id: data.work_order_id,
    session_no: data.session_no,
    shift_id: data.shift_id ?? null,
    equipment_id: data.equipment_id ?? null,
    mold_id: data.mold_id ?? null,
    terminal_id: data.terminal_id,
    started_at: new Date(STARTED_AT),
    ended_at: null,
    status_code: data.status_code,
    stop_reason_code: null,
    remarks: null,
    version_no: 1,
  });

  const target = {
    $queryRaw: () => {
      calls.push('lockWorkOrder');
      return Promise.resolve([
        {
          status_code: options.status ?? 'RELEASED',
          released_at: new Date(STARTED_AT),
          version_no: 1,
          order_qty: new Prisma.Decimal(100),
          planned_start_at: null,
          planned_end_at: null,
        },
      ]);
    },
    work_session: {
      findFirst: ({ where }: { where: Row }) => {
        calls.push(`findFirst:${dump(where)}`);
        return Promise.resolve(options.openSession === true ? { work_session_id: 9n } : null);
      },
      aggregate: () => {
        calls.push('aggregate');
        return Promise.resolve({ _max: { session_no: options.maxSessionNo ?? null } });
      },
      create: ({ data }: { data: Row }) => {
        created.push(data);
        return Promise.resolve(sessionRow(data));
      },
    },
    work_order: {
      findUniqueOrThrow: () => Promise.resolve({ routing_operation: { process_id: 30n } }),
      update: ({ data }: { data: Row }) => {
        updates.push(data);
        return Promise.resolve({});
      },
    },
    terminal_process: {
      findUnique: () =>
        Promise.resolve(options.canStartWork === null ? null : { can_start_work: options.canStartWork ?? true }),
    },
    terminal: { findUniqueOrThrow: () => Promise.resolve({ plant_id: 11n }) },
    plant: { findUnique: () => Promise.resolve({ timezone_code: options.timezone ?? 'Asia/Ho_Chi_Minh' }) },
    shift: {
      findMany: () =>
        Promise.resolve([
          {
            shift_id: 55n,
            start_time: new Date('1970-01-01T08:00:00.000Z'),
            end_time: new Date('1970-01-01T17:00:00.000Z'),
            crosses_midnight: false,
          },
        ]),
    },
    work_session_event: {
      createMany: ({ data }: { data: Row[] }) => {
        events.push(...data);
        return Promise.resolve({ count: data.length });
      },
    },
    work_session_worker: {
      createMany: ({ data }: { data: Row[] }) => {
        workers.push(...data);
        return Promise.resolve({ count: data.length });
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
    worker: {
      // 헤더 축(`assertWorkerNoExists`)은 `findUnique`, 아래 `count` 는 본문 `workerIds` «명단» 축이다.
      findUnique: () => Promise.resolve({ worker_id: 1n }),
      count: ({ where }: { where: Row }) => {
        const ids = (where.worker_id as { in?: unknown[] } | undefined)?.in;
        return Promise.resolve(ids === undefined ? 1 : ids.length);
      },
    },
    shift: { count: () => Promise.resolve(1) },
    equipment: { count: () => Promise.resolve(1) },
    mold: { count: () => Promise.resolve(1) },
    work_order: { findUnique: () => Promise.resolve({ work_order_type_code: 'EMERGENCY' }) },
    code_value: {
      findMany: () => Promise.resolve([{ code: 'EMERGENCY_WORK_ORDER', code_group: { group_code: 'CONTROL_OVERRIDE_REASON' } }]),
    },
    $transaction: (work: (client: unknown) => Promise<unknown>) => work(tx),
  } as unknown as PrismaService;

  const service = new WorkSessionService(prisma, new DocumentStateService());
  return { service, created, events, workers, updates, calls, touched };
}

describe('WorkSessionService.create', () => {
  it('RELEASED 에서 열면 W/O 가 IN_PROGRESS 로 간다', async () => {
    const it0 = stub({ status: 'RELEASED' });
    const view = await it0.service.create(body(), context());
    expect(view.statusCode).toBe('RUNNING');
    expect(it0.updates).toEqual([{ status_code: 'IN_PROGRESS', version_no: { increment: 1 }, updated_by: 5 }]);
    expect(it0.events).toHaveLength(1);
    expect(it0.events[0]).toMatchObject({ event_type_code: 'START', terminal_id: TERMINAL, performed_by: 5n });
    expect(it0.events[0]).not.toHaveProperty('reason_code');
  });

  it('IN_PROGRESS 에서 열어도 던지지 않는다 — from 에 둘 다 있다', async () => {
    const it0 = stub({ status: 'IN_PROGRESS' });
    await expect(it0.service.create(body(), context())).resolves.toMatchObject({ sessionNo: 1 });
  });

  it('상태가 같으면 W/O 를 UPDATE 하지 않는다', async () => {
    const it0 = stub({ status: 'IN_PROGRESS' });
    await it0.service.create(body(), context());
    expect(it0.updates).toEqual([]);
  });

  it('CLOSED W/O 는 전이표가 400 STATE_LOCKED 로 먼저 막아 마감 트리거에 닿지 않는다', async () => {
    const it0 = stub({ status: 'CLOSED' });
    const error = (await it0.service.create(body(), context()).catch((e: unknown) => e)) as ContractException;
    expect(error).toBeInstanceOf(ContractException);
    expect(error.getStatus()).toBe(400);
    expect(error.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    expect(it0.created).toEqual([]);
    expect(it0.updates).toEqual([]);
  });

  it('열린 세션 판정은 ended_at IS NULL 이다 — status_code 를 안 본다', async () => {
    const it0 = stub({ openSession: true });
    const error = (await it0.service.create(body(), context()).catch((e: unknown) => e)) as ConflictException;
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.conflict).toMatchObject({ code: 'OPEN_SESSION_EXISTS' });
    const where = it0.calls.find((call) => call.startsWith('findFirst:')) ?? '';
    expect(where).toContain('"ended_at":null');
    expect(where).not.toContain('status_code');
  });

  it('session_no 는 그 W/O 의 MAX+1 이고 W/O 를 잠근 뒤에 센다', async () => {
    const it0 = stub({ maxSessionNo: 4 });
    const view = await it0.service.create(body(), context());
    expect(view.sessionNo).toBe(5);
    expect(it0.calls.indexOf('lockWorkOrder')).toBeLessThan(it0.calls.indexOf('aggregate'));
  });

  it('idempotency_key 를 헤더 값 그대로 컬럼에 넣는다', async () => {
    const it0 = stub();
    await it0.service.create(body(), context({ idempotencyKey: 'HEADER-VALUE' }));
    expect(it0.created[0]).toMatchObject({ idempotency_key: 'HEADER-VALUE' });
  });

  it('workerIds 가 비면 work_session_worker 를 만들지 않는다', async () => {
    const it0 = stub();
    await it0.service.create(body({ workerIds: [] }), context());
    expect(it0.workers).toEqual([]);
  });

  it('workerIds 로 만든 참여 행의 역할은 물리 기본값 OPERATOR 다', async () => {
    // 설계 미정 — 문의 056
    const it0 = stub();
    await it0.service.create(body({ workerIds: [7, 8] }), context());
    expect(it0.workers).toHaveLength(2);
    for (const row of it0.workers) expect(row).not.toHaveProperty('worker_role_code');
  });

  it('controlOverride.note 는 저장하지 않는다 — 담을 칸이 없다', async () => {
    const it0 = stub();
    await it0.service.create(body({ controlOverride: { reasonCode: 'EMERGENCY_WORK_ORDER', note: '설비 이상' } }), context());
    const override = it0.events.find((row) => row.event_type_code === 'CONTROL_OVERRIDE');
    expect(override).toMatchObject({ reason_code: 'EMERGENCY_WORK_ORDER' });
    expect(dump(it0.events)).not.toContain('설비 이상');
  });

  it('precheck_decision 을 읽지 않는다', async () => {
    // 판정은 화면이 한다 — P-02-02 §5-9
    const it0 = stub();
    await it0.service.create(body(), context());
    expect([...it0.touched]).not.toContain('precheck_decision');
  });

  it('타임존 코드가 잘못되면 shift_id 를 비우고 연다', async () => {
    // #258 리뷰 Minor — 계약 「어느 교대에도 안 들어도 세션을 막지 않는다」
    const it0 = stub({ timezone: 'Not/A_Zone' });
    const view = await it0.service.create(body(), context());
    expect(view.shiftId).toBeUndefined();
    expect(it0.created[0]).toMatchObject({ shift_id: null });
  });

  it('단말을 못 풀면 게이팅 조회 전에 403 이다', async () => {
    // 설계 미정 — 문의 054
    const it0 = stub();
    const error = (await it0.service.create(body(), context({ terminalId: null })).catch((e: unknown) => e)) as ContractException;
    expect(error.getStatus()).toBe(403);
    expect(error.errors[0]).toMatchObject({ scope: 'screen', code: 'PERMISSION_DENIED' });
    expect([...it0.touched]).not.toContain('terminal_process');
  });

  it('can_start_work 가 false 거나 행이 없으면 403 이다', async () => {
    for (const canStartWork of [false, null] as const) {
      const it0 = stub({ canStartWork });
      const error = (await it0.service.create(body(), context()).catch((e: unknown) => e)) as ContractException;
      expect(error.getStatus()).toBe(403);
      expect(it0.created).toEqual([]);
    }
  });
});

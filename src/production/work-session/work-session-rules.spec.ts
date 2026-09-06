import { ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { assertEventPair } from './work-session-rules';
import { WorkSessionWorkerService } from './work-session-worker.service';

type Row = Record<string, unknown>;

/** 코드값 검사는 「그룹 안이다」로 늘 통과시킨다 — 이 스펙이 보는 것은 «짝» 규칙이다. */
const codeValues = (rows: { code: string; groupCode: string }[]) => ({
  findMany: ({ where }: { where: { OR: { code: string; code_group: { group_code: string } }[] } }) =>
    Promise.resolve(
      where.OR.filter((c) => rows.some((r) => r.code === c.code && r.groupCode === c.code_group.group_code)).map(
        (c) => ({ code: c.code, code_group: { group_code: c.code_group.group_code } }),
      ),
    ),
});

const prismaOf = (rows: { code: string; groupCode: string }[]) =>
  ({ code_value: codeValues(rows) }) as unknown as PrismaService;

const EVENT_TYPES = ['START', 'STOP', 'RESUME', 'END', 'CONTROL_OVERRIDE'].map((code) => ({
  code,
  groupCode: 'WORK_SESSION_EVENT_TYPE',
}));
const REASONS = [{ code: 'MOLD_CHANGE', groupCode: 'WORK_SESSION_EVENT_REASON' }];

/** 던진 `ContractException` 의 첫 오류를 「필드:코드」로 줄인다. */
async function reject(work: Promise<unknown>): Promise<string> {
  const error = await work.then(() => null, (e: unknown) => e);
  const item = (error as ContractException).getResponse() as { errors: { field?: string; code: string }[] };
  return `${item.errors[0].field ?? ''}:${item.errors[0].code}`;
}

describe('work-session-rules', () => {
  it('A-25 — STOP 은 사유 필수, RESUME 은 사유 금지다', async () => {
    const prisma = prismaOf([...EVENT_TYPES, ...REASONS]);
    expect(await assertEventPair(prisma, 'STOP', 'MOLD_CHANGE')).toBe('work-session-stop');
    expect(await assertEventPair(prisma, 'RESUME', undefined)).toBe('work-session-resume');
    expect(await reject(assertEventPair(prisma, 'STOP', undefined))).toBe('reasonCode:REQUIRED');
    expect(await reject(assertEventPair(prisma, 'STOP', 'NOT_A_REASON'))).toBe('reasonCode:INVALID');
    expect(await reject(assertEventPair(prisma, 'RESUME', 'MOLD_CHANGE'))).toBe('reasonCode:INVALID');
  });

  it('A-25 — START·END·CONTROL_OVERRIDE 는 단말이 못 보낸다', async () => {
    const prisma = prismaOf(EVENT_TYPES);
    for (const eventTypeCode of ['START', 'END', 'CONTROL_OVERRIDE']) {
      expect(await reject(assertEventPair(prisma, eventTypeCode, undefined))).toBe('eventTypeCode:INVALID');
    }
    // 그룹 밖 문자열은 코드값 검사가 먼저 가른다 — 같은 400 `INVALID` 지만 문구가 다르다.
    expect(await reject(assertEventPair(prisma, 'PAUSE', undefined))).toBe('eventTypeCode:INVALID');
    // `Object.prototype` 의 멤버 이름도 그냥 「그룹 밖 문자열」이다 — 500 으로 새지 않는다.
    expect(await reject(assertEventPair(prisma, 'toString', undefined))).toBe('eventTypeCode:INVALID');
  });

  it('workerIds 로 만든 참여 행의 역할은 물리 기본값 OPERATOR 다', async () => {
    // 설계 미정 — 문의 056. `/workers` 참여도 같다 — 값이 없으면 칸을 «안 넣어» 물리
    // 기본값을 타므로, 계약이 세운 `MAIN`/`SUB` 둘 중 어느 것도 되지 않는다.
    const created: Row[] = [];
    const tx = {
      $queryRaw: () => Promise.resolve([{ status_code: 'RUNNING', version_no: 1 }]),
      work_session_worker: {
        count: () => Promise.resolve(0),
        create: ({ data }: { data: Row }) => {
          created.push(data);
          return Promise.resolve({
            work_session_worker_id: 1n,
            work_session_id: 3n,
            worker_id: 7n,
            worker_role_code: 'OPERATOR',
            joined_at: new Date('2026-09-07T02:00:00.000Z'),
            left_at: null,
          });
        },
      },
    };
    const prisma = {
      worker: { count: () => Promise.resolve(1) },
      code_value: codeValues([]),
      $transaction: (work: (client: unknown) => Promise<unknown>) => work(tx),
    } as unknown as PrismaService;

    const view = await new WorkSessionWorkerService(prisma).join(
      3,
      { workerId: 7, joinedAt: '2026-09-07T02:00:00.000Z' },
      { version: undefined, appUserId: 5 },
    );
    expect(Object.keys(created[0])).not.toContain('worker_role_code');
    expect(view.workerRoleCode).toBe('OPERATOR');
  });
});

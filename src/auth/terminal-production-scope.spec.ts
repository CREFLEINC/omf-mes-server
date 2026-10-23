import type { Request } from 'express';

import { PrismaService } from '../prisma/prisma.service';
import type { TerminalContext } from './terminal-context';
import { assertTerminalProductionScope } from './terminal-production-scope';

/** 그 W/O 의 계획 설비와 이 단말의 W/O 공정 매핑(기본은 기능 전부 켬). */
function workOrder(plannedEquipmentId: bigint | null, flags: Record<string, boolean> = ALL_FLAGS) {
  return { planned_equipment_id: plannedEquipmentId, routing_operation: { process: { terminal_process: [flags] } } };
}
const ALL_FLAGS = { can_start_work: true, can_input_material: true, can_input_result: true };
const terminal: TerminalContext = {
  terminalId: 7n, terminalCode: 'POP-7', plantId: 3n, terminalTypeCode: 'POP', equipmentId: 5n,
};
const prisma = {
  // `count` 는 「함께 일할 사람」 명단 중 단말 공장 재직자 수 — 기본은 명단 전원이다.
  worker: {
    findFirst: jest.fn().mockResolvedValue({ worker_id: 19n }),
    count: jest.fn(async ({ where }: { where: { worker_id: { in: bigint[] } } }) => where.worker_id.in.length),
  },
  work_order: { findFirst: jest.fn().mockResolvedValue(workOrder(null)) },
  work_session: { findFirst: jest.fn().mockResolvedValue({ work_session_id: 29n }) },
  lot: { findFirst: jest.fn().mockResolvedValue({ lot_id: 43n }) },
  mold: { findFirst: jest.fn().mockResolvedValue({ mold_id: 53n }) },
} as unknown as PrismaService;

function request(body: Record<string, unknown> = {}, params: Record<string, string> = {}, workerNo?: string): Request {
  return { body, params, headers: workerNo ? { 'x-worker-no': workerNo } : {} } as unknown as Request;
}

describe('POP production terminal scope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.worker.findFirst as jest.Mock).mockResolvedValue({ worker_id: 19n });
    (prisma.work_order.findFirst as jest.Mock).mockResolvedValue(workOrder(null));
    (prisma.work_session.findFirst as jest.Mock).mockResolvedValue({ work_session_id: 29n });
    (prisma.lot.findFirst as jest.Mock).mockResolvedValue({ lot_id: 43n });
    (prisma.mold.findFirst as jest.Mock).mockResolvedValue({ mold_id: 53n });
  });

  it('allows a mapped same-plant W/O and actual terminal equipment for session start', async () => {
    await assertTerminalProductionScope(prisma,
      request({ workOrderId: 11, equipmentId: 5, moldId: 53 }, {}, '900028'),
      'POST /production/work-sessions', terminal);
    expect(prisma.work_order.findFirst).toHaveBeenCalledWith({
      where: { work_order_id: 11n, production_line: { plant_id: 3n },
        released_at: { not: null }, completed_at: null, closed_at: null,
        NOT: { status_code: 'CANCELLED' },
      },
      select: {
        planned_equipment_id: true,
        // 이 단말의 «그 W/O 공정» 매핑 한 행 — 단말의 첫 공정·다른 공정 행이 아니다.
        routing_operation: { select: { process: { select: { terminal_process: {
          where: { terminal_id: 7n }, select: { can_start_work: true },
        } } } } },
      },
    });
  });

  describe('저장 API 는 화면과 같은 W/O 공정 매핑의 기능 플래그를 본다', () => {
    const save = (key: string, flags: Record<string, boolean> | null) => {
      (prisma.work_order.findFirst as jest.Mock).mockResolvedValueOnce(
        flags === null ? { planned_equipment_id: null, routing_operation: { process: { terminal_process: [] } } } : workOrder(null, flags),
      );
      return assertTerminalProductionScope(prisma, request({ workOrderId: 11, lotId: 43 }, {}, '900028'), key, terminal);
    };
    const CONSUME = 'POST /production/material-consumptions';
    const RESULT = 'POST /production/production-results';
    const denied = (name: string) => ({ status: 401, errors: [expect.objectContaining({
      message: expect.stringContaining(`관리웹 시스템 관리 › 단말기-공정 매핑에서 해당 공정의 「${name}」을 켜세요.`),
    })] });

    it('투입만 켠 매핑 — 투입은 되고 실적은 401(실적 입력을 켜라)', async () => {
      const only = { can_start_work: false, can_input_material: true, can_input_result: false };
      await expect(save(CONSUME, only)).resolves.toBeUndefined();
      await expect(save(RESULT, only)).rejects.toMatchObject(denied('실적 입력'));
    });

    it('실적만 켠 매핑 — 실적은 되고 투입은 401(자재 투입을 켜라)', async () => {
      const only = { can_start_work: false, can_input_material: false, can_input_result: true };
      await expect(save(RESULT, only)).resolves.toBeUndefined();
      await expect(save(CONSUME, only)).rejects.toMatchObject(denied('자재 투입'));
    });

    it('작업 시작만 켠 매핑 — 투입·실적 모두 401', async () => {
      const only = { can_start_work: true, can_input_material: false, can_input_result: false };
      await expect(save(CONSUME, only)).rejects.toMatchObject({ status: 401 });
      await expect(save(RESULT, only)).rejects.toMatchObject({ status: 401 });
    });

    it('W/O 공정에 매핑이 없으면 범위 밖 401 이다', async () => {
      await expect(save(CONSUME, null)).rejects.toMatchObject({ status: 401, errors: [expect.objectContaining({ message: '단말 인증 범위 밖입니다.' })] });
    });
  });

  it('rejects a different terminal equipment, worker plant, or unmapped W/O', async () => {
    await expect(assertTerminalProductionScope(prisma,
      request({ workOrderId: 11, equipmentId: 6 }, {}, '900028'),
      'POST /production/work-sessions', terminal)).rejects.toMatchObject({ status: 401 });
    (prisma.worker.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(assertTerminalProductionScope(prisma,
      request({ workOrderId: 11, equipmentId: 5 }, {}, '900028'),
      'POST /production/work-sessions', terminal)).rejects.toMatchObject({ status: 401 });
    (prisma.work_order.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(assertTerminalProductionScope(prisma,
      request({ workOrderId: 11, equipmentId: 5 }, {}, '900028'),
      'POST /production/work-sessions', terminal)).rejects.toMatchObject({ status: 401 });
  });

  describe('설비 없는 단말의 작업 전 점검·세션 설비', () => {
    const bare: TerminalContext = { ...terminal, equipmentId: null };
    const precheck = (equipmentId: unknown, who = bare) =>
      assertTerminalProductionScope(prisma, request({ workOrderId: 11, equipmentId }, {}, '900028'), 'POST /production/precheck-decisions', who);

    it('설비 없는 단말은 W/O 의 계획 설비로 점검한다 — 다른 설비는 막는다', async () => {
      (prisma.work_order.findFirst as jest.Mock).mockResolvedValue(workOrder(8n));
      await expect(precheck(8)).resolves.toBeUndefined();
      await expect(precheck(5)).rejects.toMatchObject({ status: 401 });
    });

    it('W/O 에도 설비가 없으면 점검할 설비가 없다', async () => {
      (prisma.work_order.findFirst as jest.Mock).mockResolvedValue(workOrder(null));
      await expect(precheck(8)).rejects.toMatchObject({ status: 401 });
    });

    it('설비 단말은 W/O 계획 설비와 상관없이 자기 설비만이다', async () => {
      (prisma.work_order.findFirst as jest.Mock).mockResolvedValue(workOrder(8n));
      await expect(precheck(5, terminal)).resolves.toBeUndefined();
      await expect(precheck(8, terminal)).rejects.toMatchObject({ status: 401 });
    });

    it('세션 설비도 같은 원칙이다 — 설비 없는 단말·설비 없는 W/O 는 설비 없이 연다', async () => {
      const start = (body: Record<string, unknown>) =>
        assertTerminalProductionScope(prisma, request({ workOrderId: 11, ...body }, {}, '900028'), 'POST /production/work-sessions', bare);
      (prisma.work_order.findFirst as jest.Mock).mockResolvedValue(workOrder(8n));
      await expect(start({ equipmentId: 8 })).resolves.toBeUndefined();
      await expect(start({ equipmentId: 5 })).rejects.toMatchObject({ status: 401 });
      (prisma.work_order.findFirst as jest.Mock).mockResolvedValue(workOrder(null));
      await expect(start({})).resolves.toBeUndefined();
      await expect(start({ equipmentId: 8 })).rejects.toMatchObject({ status: 401 });
    });
  });

  it('세션 시작의 부작업자(workerIds)도 단말 공장 재직자여야 한다', async () => {
    const start = (workerIds: unknown[]) => assertTerminalProductionScope(prisma,
      request({ workOrderId: 11, workerIds }, {}, '900028'), 'POST /production/work-sessions', terminal);
    await expect(start([19, 20])).resolves.toBeUndefined();
    expect(prisma.worker.count).toHaveBeenLastCalledWith({ where: { worker_id: { in: [19n, 20n] }, plant_id: 3n, is_active: true } });
    (prisma.worker.count as jest.Mock).mockResolvedValueOnce(1);
    await expect(start([19, 20])).rejects.toMatchObject({ status: 401 });
    // 정수 id 로 읽을 수 없는 값은 범위로 가르지 않는다 — 계약 검증이 400 으로 막는다.
    await expect(start(['x'])).resolves.toBeUndefined();
  });

  it('공동 작업자 참여·이탈·목록은 자기 세션이고, 참여하는 사람은 단말 공장의 재직 작업자다', async () => {
    const join = (workerId: number) => assertTerminalProductionScope(prisma,
      request({ workerId, joinedAt: '2026-09-07T02:00:00.000Z' }, { workSessionId: '29' }, '900028'),
      'POST /production/work-sessions/{workSessionId}/workers', terminal);
    await expect(join(19)).resolves.toBeUndefined();
    (prisma.worker.count as jest.Mock).mockResolvedValueOnce(0);
    await expect(join(20)).rejects.toMatchObject({ status: 401 });
    await expect(assertTerminalProductionScope(prisma, request({}, { workSessionId: '29' }),
      'GET /production/work-sessions/{workSessionId}/workers', terminal)).resolves.toBeUndefined();
    (prisma.work_session.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(assertTerminalProductionScope(prisma,
      request({ leftAt: '2026-09-07T03:00:00.000Z' }, { workSessionId: '29', workSessionWorkerId: '5' }, '900028'),
      'POST /production/work-sessions/{workSessionId}/workers/{workSessionWorkerId}:leave', terminal)).rejects.toMatchObject({ status: 401 });
  });

  it('작업지시 마감은 그 W/O 공정 매핑의 마감 권한으로 가르고, 권한만 꺼졌으면 켤 곳을 알려 준다', async () => {
    const closing = (flag: boolean | null) => {
      const mapping = flag === null ? [] : [{ can_close_work_order: flag }];
      (prisma.work_order.findFirst as jest.Mock).mockResolvedValueOnce({ routing_operation: { process: { terminal_process: mapping } } });
      return assertTerminalProductionScope(prisma, request({}, { workOrderId: '11' }, '900028'),
        'POST /production/work-orders/{workOrderId}:close', terminal);
    };

    await expect(closing(true)).resolves.toBeUndefined();
    await expect(closing(false)).rejects.toMatchObject({ status: 401, errors: [expect.objectContaining({ message: expect.stringContaining('작업지시 마감') })] });
    await expect(closing(null)).rejects.toMatchObject({ status: 401 });
  });

  it('범위 밖 까닭은 단말 공장·이 단말 매핑이 있는 W/O 의 상태로만 찾는다 — 남의 공장·매핑 없는 W/O 는 일반 문구', async () => {
    const findFirst = prisma.work_order.findFirst as jest.Mock;
    findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      status_code: 'CLOSED', released_at: new Date(), completed_at: null, closed_at: new Date(),
    });

    await expect(assertTerminalProductionScope(prisma, request({}, { workOrderId: '11' }, '900028'),
      'POST /production/work-orders/{workOrderId}:hold', terminal))
      .rejects.toMatchObject({ status: 401, errors: [expect.objectContaining({ message: expect.stringContaining('마감됐습니다') })] });
    expect(findFirst).toHaveBeenLastCalledWith({
      where: { work_order_id: 11n, production_line: { plant_id: 3n },
        routing_operation: { process: { terminal_process: { some: { terminal_id: 7n } } } } },
      select: { status_code: true, released_at: true, completed_at: true, closed_at: true },
    });

    findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(assertTerminalProductionScope(prisma, request({}, { workOrderId: '11' }, '900028'),
      'POST /production/work-orders/{workOrderId}:hold', terminal))
      .rejects.toMatchObject({ status: 401, errors: [expect.objectContaining({ message: '단말 인증 범위 밖입니다.' })] });
  });

  it('세션 읽기는 W/O 단위 조회 기준(다른 단말 세션도), 쓰기는 자기 단말 세션만이다', async () => {
    await assertTerminalProductionScope(prisma,
      request({}, { workSessionId: '29' }),
      'GET /production/work-sessions/{workSessionId}/workers', terminal);
    expect(prisma.work_session.findFirst).toHaveBeenCalledWith({
      where: { work_session_id: 29n, work_order: { production_line: { plant_id: 3n },
        released_at: { not: null }, completed_at: null, closed_at: null, NOT: { status_code: 'CANCELLED' },
        routing_operation: { process: { terminal_process: { some: {
          terminal_id: 7n,
          OR: [{ can_start_work: true }, { can_input_material: true }, { can_input_result: true }],
        } } } } } },
      select: { work_session_id: true },
    });
    await assertTerminalProductionScope(prisma,
      request({ eventTypeCode: 'STOP' }, { workSessionId: '29' }, '900028'),
      'POST /production/work-sessions/{workSessionId}/events', terminal);
    expect(prisma.work_session.findFirst).toHaveBeenLastCalledWith({
      where: { work_session_id: 29n, terminal_id: 7n,
        work_order: { production_line: { plant_id: 3n } } },
      select: { work_session_id: true },
    });
    (prisma.work_session.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(assertTerminalProductionScope(prisma,
      request({ eventTypeCode: 'STOP' }, { workSessionId: '29' }, '900028'),
      'POST /production/work-sessions/{workSessionId}/events', terminal)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects another-plant LOT allocation and serial creation', async () => {
    (prisma.lot.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(assertTerminalProductionScope(prisma,
      request({ workOrderId: 11, lotAllocations: [{ lotId: 43 }] }, {}, '900028'),
      'POST /production/production-results', terminal)).rejects.toMatchObject({ status: 401 });
    (prisma.lot.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(assertTerminalProductionScope(prisma,
      request({ lotId: 43 }, {}, '900028'),
      'POST /trace/serial-numbers', terminal)).rejects.toMatchObject({ status: 401 });
  });
});

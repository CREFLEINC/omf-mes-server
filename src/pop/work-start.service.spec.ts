import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';

import { TerminalAuthService, TerminalPrincipal } from '../auth/terminal-auth.service';
import { OperationPolicyService } from '../master-data/operation-policy/operation-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { PopWorkOrderQueryDto, StartWorkDto } from './work-start.dto';
import { WorkStartService } from './work-start.service';

/** 사출은 시작까지, 포장은 실적 입력만 허용된 단말. */
const terminal: TerminalPrincipal = {
  terminalId: 5n,
  terminalCode: 'POP_INJ_01',
  plantId: 2n,
  processes: [
    {
      processCode: 'INJECTION',
      processName: '사출',
      capabilities: ['can_start_work', 'can_input_result'],
    },
    { processCode: 'PACKING', processName: '포장', capabilities: ['can_input_result'] },
  ],
};

const worker = {
  worker_id: 30n,
  worker_no: 'EMP-1043',
  worker_name: '김작업',
};

const dayShift = { shift_id: 7n, shift_code: 'DAY', shift_name: '주간' };

const baseWorkOrder = {
  work_order_id: 11n,
  work_order_no: 'WO-2026-0001',
  status_code: 'RELEASED',
  item_id: 40n,
  item: { item_code: 'ITEM_0001', item_name: '하우징' },
  uom: { uom_code: 'EA' },
  order_qty: new Prisma.Decimal(1000),
  routing_operation: {
    process_id: 3n,
    operation_name: '사출 성형',
    equipment_required: false,
    mold_required: false,
    process: { process_id: 3n, process_code: 'INJECTION', process_name: '사출' },
  },
  planned_start_at: new Date('2026-07-28T00:00:00Z'),
  planned_end_at: null,
  priority_no: 100,
  equipment: { equipment_id: 21n, equipment_code: 'INJ-01' },
  mold: null,
  shift: dayShift,
  production_plan: { production_order: { plant_id: 2n } },
};

type WorkOrderOverrides = Partial<Record<keyof typeof baseWorkOrder, unknown>>;

const workOrderWith = (overrides: WorkOrderOverrides = {}) => ({ ...baseWorkOrder, ...overrides });

const query = (overrides: Partial<PopWorkOrderQueryDto> = {}): PopWorkOrderQueryDto =>
  Object.assign(new PopWorkOrderQueryDto(), overrides);

describe('WorkStartService', () => {
  let service: WorkStartService;
  let prisma: {
    work_order: Record<string, jest.Mock>;
    work_session: Record<string, jest.Mock>;
    shift: Record<string, jest.Mock>;
    equipment: Record<string, jest.Mock>;
    mold: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  let tx: {
    work_session: Record<string, jest.Mock>;
    work_session_worker: Record<string, jest.Mock>;
    work_session_event: Record<string, jest.Mock>;
    work_order: Record<string, jest.Mock>;
  };
  const terminals = {
    resolveWorker: jest.fn(),
    assertCapability: jest.fn(),
    findValidQualifications: jest.fn(),
  };
  const policies = { resolveText: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();

    tx = {
      work_session: {
        create: jest.fn().mockResolvedValue({
          work_session_id: 100n,
          session_no: 1,
          started_at: new Date('2026-07-28T01:00:00Z'),
          status_code: 'OPEN',
        }),
      },
      work_session_worker: { create: jest.fn() },
      work_session_event: { create: jest.fn() },
      work_order: { update: jest.fn() },
    };

    prisma = {
      work_order: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
      work_session: {
        findFirst: jest.fn().mockResolvedValue(null),
        aggregate: jest.fn().mockResolvedValue({ _max: { session_no: null } }),
      },
      shift: { findFirst: jest.fn() },
      equipment: { findFirst: jest.fn() },
      mold: { findFirst: jest.fn() },
      // 목록은 배열형, 시작은 콜백형으로 같은 메서드를 쓴다.
      $transaction: jest.fn((arg: unknown) =>
        Array.isArray(arg) ? Promise.all(arg) : (arg as (t: typeof tx) => unknown)(tx),
      ),
    };

    terminals.resolveWorker.mockResolvedValue(worker);
    terminals.assertCapability.mockResolvedValue(undefined);
    terminals.findValidQualifications.mockResolvedValue([]);
    policies.resolveText.mockResolvedValue('OFF');
    prisma.work_order.findUnique.mockResolvedValue(workOrderWith());

    const moduleRef = await Test.createTestingModule({
      providers: [
        WorkStartService,
        { provide: PrismaService, useValue: prisma },
        { provide: TerminalAuthService, useValue: terminals },
        { provide: OperationPolicyService, useValue: policies },
      ],
    }).compile();

    service = moduleRef.get(WorkStartService);
  });

  describe('findStartable', () => {
    beforeEach(() => {
      prisma.work_order.findMany.mockResolvedValue([
        { ...workOrderWith(), work_session: [] },
      ]);
      prisma.work_order.count.mockResolvedValue(1);
    });

    // 실적 입력만 되는 공정의 W/O에 시작 버튼이 뜨면 눌러 보고 나서야 403을 만난다.
    it('시작이 허용된 공정의 작업지시만 조회한다', async () => {
      await service.findStartable(terminal, query());

      const where = prisma.work_order.findMany.mock.calls[0][0].where;
      expect(where.routing_operation.process.process_code.in).toEqual(['INJECTION']);
      expect(where.status_code.in).toEqual(['RELEASED', 'IN_PROGRESS']);
      expect(where.production_plan.production_order.plant_id).toBe(2n);
    });

    it('열려 있는 세션이 있으면 hasOpenSession으로 알려준다', async () => {
      prisma.work_order.findMany.mockResolvedValue([
        { ...workOrderWith(), work_session: [{ work_session_id: 99n }] },
      ]);

      const page = await service.findStartable(terminal, query());

      expect(page.items[0].hasOpenSession).toBe(true);
      expect(page.items[0].workOrderNo).toBe('WO-2026-0001');
    });

    it('단말이 시작할 수 없는 공정을 지정하면 403', async () => {
      await expect(
        service.findStartable(terminal, query({ processCode: 'PACKING' })),
      ).rejects.toThrow(ForbiddenException);
    });

    it('시작 가능한 공정이 하나도 없으면 빈 페이지다', async () => {
      const readOnly: TerminalPrincipal = {
        ...terminal,
        processes: [{ processCode: 'PACKING', processName: '포장', capabilities: [] }],
      };

      const page = await service.findStartable(readOnly, query());

      expect(page.total).toBe(0);
      expect(prisma.work_order.findMany).not.toHaveBeenCalled();
    });
  });

  describe('start', () => {
    const start = (dto: StartWorkDto = {}) => service.start(terminal, 'EMP-1043', 11n, dto);

    it('세션·작업자 귀속·시작 이벤트를 함께 만든다', async () => {
      const result = await start();

      expect(tx.work_session.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          work_order_id: 11n,
          session_no: 1,
          shift_id: 7n,
          equipment_id: 21n,
          mold_id: null,
          terminal_id: 5n,
          status_code: 'OPEN',
        }),
      });
      expect(tx.work_session_worker.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ work_session_id: 100n, worker_id: 30n }),
      });
      expect(tx.work_session_event.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ event_type_code: 'START', terminal_id: 5n }),
      });
      expect(result.workSessionId).toBe(100n);
      expect(result.warnings).toEqual([]);
    });

    it('배포 상태였으면 작업중으로 올린다', async () => {
      await start();

      expect(tx.work_order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status_code: 'IN_PROGRESS' }) }),
      );
    });

    it('이미 작업중이던 작업지시는 상태를 건드리지 않는다', async () => {
      prisma.work_order.findUnique.mockResolvedValue(workOrderWith({ status_code: 'IN_PROGRESS' }));

      await start();

      expect(tx.work_order.update).not.toHaveBeenCalled();
    });

    it('세션 회차는 마지막 회차 다음이다', async () => {
      prisma.work_session.aggregate.mockResolvedValue({ _max: { session_no: 2 } });

      await start();

      expect(tx.work_session.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ session_no: 3 }),
      });
    });

    it('사번 헤더가 없으면 400', async () => {
      await expect(service.start(terminal, undefined, 11n, {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it('이미 진행 중이면 409', async () => {
      prisma.work_session.findFirst.mockResolvedValue({ work_session_id: 99n });

      await expect(start()).rejects.toThrow(ConflictException);
    });

    it('배포되지 않은 작업지시는 시작할 수 없다', async () => {
      prisma.work_order.findUnique.mockResolvedValue(workOrderWith({ status_code: 'PLANNED' }));

      await expect(start()).rejects.toThrow(ForbiddenException);
    });

    it('다른 공장의 작업지시는 시작할 수 없다', async () => {
      prisma.work_order.findUnique.mockResolvedValue(
        workOrderWith({ production_plan: { production_order: { plant_id: 9n } } }),
      );

      await expect(start()).rejects.toThrow(ForbiddenException);
    });

    describe('자격 강제', () => {
      it('BLOCK이면 자격 없는 작업자를 막는다', async () => {
        policies.resolveText.mockResolvedValue('BLOCK');

        await expect(start()).rejects.toThrow(ForbiddenException);
        expect(tx.work_session.create).not.toHaveBeenCalled();
      });

      it('WARN이면 경고만 싣고 시작시킨다', async () => {
        policies.resolveText.mockResolvedValue('WARN');

        const result = await start();

        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('INJECTION');
        expect(tx.work_session.create).toHaveBeenCalled();
      });

      it('공정 무관 자격은 어느 공정에나 통한다', async () => {
        policies.resolveText.mockResolvedValue('BLOCK');
        terminals.findValidQualifications.mockResolvedValue([
          { qualificationTypeCode: 'PROCESS_OPERATION', processCode: null, validTo: null },
        ]);

        const result = await start();

        expect(result.warnings).toEqual([]);
      });

      // 정책값 오타 하나로 현장을 세우지 않는다 — 사실은 남기고 통과시킨다.
      it('알 수 없는 정책값은 경고로 떨어뜨린다', async () => {
        policies.resolveText.mockResolvedValue('BLOK');

        const result = await start();

        expect(result.warnings).toHaveLength(1);
      });

      it('OFF면 자격을 조회하지도 않는다', async () => {
        await start();

        expect(terminals.findValidQualifications).not.toHaveBeenCalled();
      });
    });

    describe('4M 승계', () => {
      it('계획 근무조가 없고 지정도 없으면 400', async () => {
        prisma.work_order.findUnique.mockResolvedValue(workOrderWith({ shift: null }));

        await expect(start()).rejects.toThrow(BadRequestException);
      });

      it('지정한 근무조가 계획을 이긴다', async () => {
        prisma.shift.findFirst.mockResolvedValue({ ...dayShift, shift_id: 8n, shift_code: 'NIGHT' });

        await start({ shiftCode: 'NIGHT' });

        expect(tx.work_session.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ shift_id: 8n }),
        });
      });

      it('설비가 필수인 공정에 계획 설비도 지정도 없으면 400', async () => {
        prisma.work_order.findUnique.mockResolvedValue(
          workOrderWith({
            equipment: null,
            routing_operation: {
              ...baseWorkOrder.routing_operation,
              equipment_required: true,
            },
          }),
        );

        await expect(start()).rejects.toThrow(BadRequestException);
      });

      it('금형이 필수인 공정에 금형이 없으면 400', async () => {
        prisma.work_order.findUnique.mockResolvedValue(
          workOrderWith({
            routing_operation: { ...baseWorkOrder.routing_operation, mold_required: true },
          }),
        );

        await expect(start()).rejects.toThrow(BadRequestException);
      });
    });
  });
});

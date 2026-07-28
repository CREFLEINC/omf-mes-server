import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';

import { TerminalAuthService, TerminalPrincipal } from '../auth/terminal-auth.service';
import { NumberingService } from '../master-data/numbering/numbering.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductionResultService } from './production-result.service';

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
  ],
};

const baseSession = {
  work_session_id: 100n,
  status_code: 'OPEN',
  ended_at: null,
  shift_id: 7n,
  equipment_id: 21n,
  mold_id: null,
  work_order: {
    work_order_id: 11n,
    uom: { uom_id: 3n, uom_code: 'EA' },
    routing_operation: { process: { process_code: 'INJECTION' } },
    production_plan: { production_order: { plant_id: 2n } },
  },
  work_session_worker: [{ worker_id: 30n, left_at: null, worker: { worker_id: 30n } }],
};

const createdResult = {
  production_result_id: 500n,
  production_result_no: 'PR-260728-0001',
  result_sequence: 1,
  good_qty: new Prisma.Decimal(300),
  occurred_at: new Date('2026-07-28T09:00:00Z'),
  status_code: 'CONFIRMED',
  work_session_id: 100n,
};

const KEY = 'req-0001';

describe('ProductionResultService', () => {
  let service: ProductionResultService;
  let prisma: {
    work_session: Record<string, jest.Mock>;
    production_result: Record<string, jest.Mock>;
  };
  const terminals = { assertCapability: jest.fn() };
  const numbering = { issue: jest.fn() };

  const sessionWith = (overrides: Record<string, unknown> = {}) => ({
    ...baseSession,
    ...overrides,
  });

  const create = (dto = { goodQty: 300 }) => service.create(terminal, 100n, KEY, dto);

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      work_session: { findUnique: jest.fn().mockResolvedValue(sessionWith()) },
      production_result: {
        findUnique: jest.fn().mockResolvedValue(null),
        aggregate: jest.fn().mockResolvedValue({ _max: { result_sequence: null } }),
        create: jest.fn().mockResolvedValue(createdResult),
      },
    };
    terminals.assertCapability.mockResolvedValue(undefined);
    numbering.issue.mockResolvedValue('PR-260728-0001');

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProductionResultService,
        { provide: PrismaService, useValue: prisma },
        { provide: TerminalAuthService, useValue: terminals },
        { provide: NumberingService, useValue: numbering },
      ],
    }).compile();

    service = moduleRef.get(ProductionResultService);
  });

  it('세션의 4M을 승계해 실적을 남긴다', async () => {
    const result = await create();

    expect(prisma.production_result.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        production_result_no: 'PR-260728-0001',
        work_order_id: 11n,
        work_session_id: 100n,
        result_sequence: 1,
        good_qty: 300,
        uom_id: 3n,
        worker_id: 30n,
        equipment_id: 21n,
        shift_id: 7n,
        terminal_id: 5n,
        idempotency_key: KEY,
      }),
    });
    expect(result.replayed).toBe(false);
    expect(result.productionResultNo).toBe('PR-260728-0001');
  });

  it('실적 입력이 허용된 공정인지 확인한다', async () => {
    await create();

    expect(terminals.assertCapability).toHaveBeenCalledWith(5n, 'INJECTION', 'can_input_result');
  });

  it('회차는 작업지시 안에서 마지막 다음이다', async () => {
    prisma.production_result.aggregate.mockResolvedValue({ _max: { result_sequence: 4 } });

    await create();

    expect(prisma.production_result.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ result_sequence: 5 }),
    });
  });

  // 초과분은 추가 생산LOT 발행으로 처리하는 것이 확정 설계다(도식 02 태그 464:6653).
  it('지시수량을 넘겨도 막지 않는다', async () => {
    const result = await create({ goodQty: 999999 });

    expect(result.replayed).toBe(false);
    expect(prisma.production_result.create).toHaveBeenCalled();
  });

  it('발생 시각을 안 보내면 서버 시각으로 남긴다', async () => {
    await create();

    const data = prisma.production_result.create.mock.calls[0][0].data;
    expect(data.occurred_at).toBeInstanceOf(Date);
  });

  it('닫힌 세션에는 실적을 올릴 수 없다', async () => {
    prisma.work_session.findUnique.mockResolvedValue(
      sessionWith({ status_code: 'CLOSED', ended_at: new Date() }),
    );

    await expect(create()).rejects.toThrow(ForbiddenException);
    expect(prisma.production_result.create).not.toHaveBeenCalled();
  });

  it('다른 공장의 세션에는 올릴 수 없다', async () => {
    prisma.work_session.findUnique.mockResolvedValue(
      sessionWith({
        work_order: {
          ...baseSession.work_order,
          production_plan: { production_order: { plant_id: 9n } },
        },
      }),
    );

    await expect(create()).rejects.toThrow(ForbiddenException);
  });

  describe('멱등 재전송', () => {
    it('같은 키의 재전송은 처음 만든 실적을 그대로 돌려준다', async () => {
      prisma.production_result.findUnique.mockResolvedValue(createdResult);

      const result = await create();

      expect(result.replayed).toBe(true);
      expect(result.productionResultId).toBe(500n);
      // 재전송이 새 실적을 만들면 생산량이 그대로 부풀려진다.
      expect(prisma.production_result.create).not.toHaveBeenCalled();
    });

    // 세션이 닫힌 뒤 도착한 재전송도 처음 만든 결과를 돌려줘야 한다.
    it('재전송은 세션 상태 검증보다 먼저다', async () => {
      prisma.production_result.findUnique.mockResolvedValue(createdResult);
      prisma.work_session.findUnique.mockResolvedValue(
        sessionWith({ status_code: 'CLOSED', ended_at: new Date() }),
      );

      const result = await create();

      expect(result.replayed).toBe(true);
    });

    it('다른 세션에 쓰인 키면 409', async () => {
      prisma.production_result.findUnique.mockResolvedValue({
        ...createdResult,
        work_session_id: 999n,
      });

      await expect(create()).rejects.toThrow(ConflictException);
    });

    it('경합으로 진 요청은 이긴 쪽의 실적을 돌려준다', async () => {
      prisma.production_result.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['idempotency_key'] },
        }),
      );
      prisma.production_result.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createdResult);

      const result = await create();

      expect(result.replayed).toBe(true);
      expect(result.productionResultId).toBe(500n);
    });

    // 채번 중복·회차 중복은 멱등이 아니라 진짜 충돌이다 — 삼키면 안 된다.
    it('멱등 키가 아닌 UNIQUE 위반은 그대로 던진다', async () => {
      prisma.production_result.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['work_order_id', 'result_sequence'] },
        }),
      );

      await expect(create()).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
    });
  });
});

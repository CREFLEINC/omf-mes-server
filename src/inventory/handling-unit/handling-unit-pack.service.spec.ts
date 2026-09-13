import { ConflictException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { HandlingUnitPackService } from './handling-unit-pack.service';

/**
 * e2e 가 «값으로» 못 재는 것 둘만 확정한다(계획 §9-4 단위 2·4).
 *  ⓐ **자물쇠** — `:pack` 은 오늘 언제나 200/400/404/409 로 닫히므로 `FOR UPDATE` 를 통째로
 *    빼거나 `FOR SHARE` 로 낮춰도 e2e 가 전부 초록이다. 경쟁을 실제로 재는 시험은 저장소에
 *    선례가 0이고, «원시 SQL 을 단위 스펙이 지켜보는» 선례가 많다(`stock-transfer-lock.spec.ts` 형).
 *  ⓑ **409 두 갈래의 순서** — 「이미 확정」과 「낡은 토큰」이 «동시에» 성립하는 행을 HTTP 로
 *    만들 수는 있으나, 순서가 뒤집혔을 때 화면이 무엇을 보는지는 결국 이 문구 하나로만 갈린다.
 *    여기서 두 갈래를 «같은 행»에 겹쳐 두고 어느 쪽이 이기는지 못 박는다.
 */

const HU = 77;
const CONTEXT = { workerNo: 'W1', appUserId: 9 };
const BODY = {
  contents: [{ itemId: 101, lotId: 201, qty: 1, uomId: 301 }],
  businessDate: '2026-09-09',
  occurredAt: '2026-09-09T10:22:00+09:00',
};

interface Recorded {
  calls: string[];
  lockSql: string;
  lockValues: unknown[];
}

function fake(locked: { status_code: string; version_no: number } | null) {
  const recorded: Recorded = { calls: [], lockSql: '', lockValues: [] };

  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      recorded.calls.push('lock');
      recorded.lockSql = strings.join('?');
      recorded.lockValues = values;
      return locked === null ? [] : [locked];
    },
  };

  const prisma = {
    // 사번 확인은 이 스펙의 주제가 아니다 — 있는 것으로 두고 지난다(트랜잭션 «밖»이라
    // `calls` 에도 안 남는다 ⇒ 「첫 문장」 단언이 그것에 안 흔들린다).
    worker: { findUnique: async () => ({ worker_id: 1n }) },
    $transaction: async (work: (client: unknown) => Promise<unknown>) => {
      recorded.calls.push('transaction');
      return work(tx);
    },
  };

  const service = new HandlingUnitPackService(
    prisma as unknown as PrismaService,
    undefined as never,
  );
  return { service, recorded };
}

const thrown = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('던지지 않았다');
};

describe('HandlingUnitPackService.pack — 자물쇠와 409 순서', () => {
  it('단말 포장 확정은 계정 없이도 성공하고 감사 사용자 칸은 null로 남긴다', async () => {
    const created = jest.fn().mockResolvedValue({ count: 1 });
    const updated = jest.fn().mockResolvedValue({});
    const tx = {
      worker: { findFirst: jest.fn().mockResolvedValue({ worker_id: 8n }) },
      terminal: { findFirst: jest.fn().mockResolvedValue({ terminal_id: 7n }) },
      audit_event: { create: jest.fn().mockResolvedValue({}) },
      $queryRaw: jest.fn().mockResolvedValue([{ status_code: 'OPEN', version_no: 1 }]),
      item: { findMany: jest.fn().mockResolvedValue([{ item_id: 101n }]) },
      lot: { findMany: jest.fn().mockResolvedValue([{ lot_id: 201n, item_id: 101n }]) },
      uom: { findMany: jest.fn().mockResolvedValue([{ uom_id: 301n }]) },
      handling_unit_content: { deleteMany: jest.fn(), createMany: created },
      handling_unit: { update: updated },
    };
    const prisma = {
      worker: { findUnique: jest.fn().mockResolvedValue({ worker_id: 8n }) },
      $transaction: (work: (client: typeof tx) => Promise<unknown>) => work(tx),
    } as unknown as PrismaService;
    const queries = { get: jest.fn().mockResolvedValue({ handlingUnit: { handlingUnitId: HU }, contents: [] }) };
    const service = new HandlingUnitPackService(prisma, queries as never);

    await service.pack(HU, undefined, BODY, { workerNo: 'W1', workerId: 8n, terminalAudit: {
      workerId: 8n, workerNo: 'W1', terminalId: 7n, plantId: 3n,
      correlationId: 'pack-1', operationKey: 'POST /inventory/handling-units/{handlingUnitId}:pack',
    } });

    expect(created).toHaveBeenCalledWith({ data: [expect.objectContaining({ created_by: null })] });
    expect(updated).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ updated_by: null }) }));
    expect(tx.audit_event.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      target_type_code: 'HANDLING_UNIT', target_id: BigInt(HU), event_type_code: 'PACK',
      terminal_id: 7n, correlation_id: 'pack-1',
    }) });
  });

  it('⭐ 트랜잭션 «첫 문장»이 그 행 하나의 `FOR UPDATE` 다 — 0행이면 404 다', async () => {
    const { service, recorded } = fake(null);

    const error = await thrown(() => service.pack(HU, undefined, BODY, CONTEXT));

    expect(recorded.calls).toEqual(['transaction', 'lock']);
    expect(recorded.lockSql).toContain('FOR UPDATE');
    expect(recorded.lockSql).toContain('inventory.handling_unit');
    expect(recorded.lockSql).toContain('WHERE handling_unit_id =');
    // ⭐ 잠그는 값이 «경로 id» 다 — 상수로 잠그면 여기가 빨개진다.
    expect(recorded.lockValues).toEqual([BigInt(HU)]);
    expect((error as { status?: number }).status).toBe(404);
  });

  it('⭐ 이미 확정 + 낡은 토큰이 «겹치면» 「이미 확정」이 이긴다 — 안 겹치면 「낡은 토큰」이다', async () => {
    const both = fake({ status_code: 'PACKED', version_no: 9 });

    // 상태도 확정이고 버전도 어긋난다 — 순서를 뒤집으면 「다시 읽어 오면 풀린다」가 나가는데
    // 다시 읽어도 영영 안 풀린다.
    const first = await thrown(() => both.service.pack(HU, 3, BODY, CONTEXT));
    expect(first).toBeInstanceOf(ConflictException);
    expect((first as ConflictException).conflict).toEqual({
      conflictCause: 'user',
      message: '이미 확정된 포장입니다. 다시 확정할 수 없습니다.',
    });

    // 확정 전인데 토큰만 낡았다 — 이쪽은 재조회로 풀린다. 두 문구를 하나로 합치면 빨개진다.
    const stale = fake({ status_code: 'OPEN', version_no: 9 });
    const second = await thrown(() => stale.service.pack(HU, 3, BODY, CONTEXT));
    expect((second as ConflictException).conflict).toEqual({
      conflictCause: 'user',
      message: '다른 사용자가 먼저 저장했습니다. 다시 불러온 뒤 저장하세요.',
    });
  });
});

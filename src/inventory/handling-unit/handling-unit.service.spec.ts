import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../core/numbering';
import { HandlingUnitQueryService } from './handling-unit-query.service';
import { HU_STATUS_OPEN, HU_STATUS_PACKED } from './handling-unit-status';
import { HandlingUnitService, assertParentAcyclic } from './handling-unit.service';

/**
 * e2e 가 «값으로» 못 재는 둘만 확정한다.
 *  ⓐ 채번 호출의 세 인자 — e2e 는 결과 문자열만 보므로 `plantId` 를 아무 값으로 바꿔도
 *    오늘의 픽스처에서는 같은 번호가 나온다.
 *  ⓑ 순환 검사의 «반복 상한» — 이미 200단이 넘는 사슬은 e2e 픽스처로 만들 자리가 없다.
 */

const day = (): string => new Date().toISOString().slice(0, 10);

/** 부모 사슬 하나. `{ id: parentId | null }` 로 준다 — 순환도 그대로 표현된다. */
function chainTx(links: Record<number, number | null>): Prisma.TransactionClient {
  return {
    handling_unit: {
      findUnique: async ({ where }: { where: { handling_unit_id: number } }) =>
        where.handling_unit_id in links
          ? { parent_handling_unit_id: links[where.handling_unit_id] }
          : null,
    },
  } as unknown as Prisma.TransactionClient;
}

const thrown = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('던지지 않았다');
};

describe('취급 단위 상태 상수', () => {
  it('상수가 둘이고 값이 OPEN·PACKED 다 // 결정 — 통보 141', () => {
    expect([HU_STATUS_OPEN, HU_STATUS_PACKED]).toEqual(['OPEN', 'PACKED']);
  });
});

describe('취급 단위 순환 검사', () => {
  it('⭐ A→B→C→A 를 잡는다 — 자기참조만 막는 물리 CHECK 가 못 막는 자리다', async () => {
    // 3 을 부모로 지목하면 3→2→1→3 으로 되돌아온다.
    const error = await thrown(() => assertParentAcyclic(chainTx({ 1: 3, 2: 1, 3: 2 }), 3));

    expect(error).toBeInstanceOf(ContractException);
    expect((error as ContractException).getResponse()).toEqual({
      errors: [
        { scope: 'field', field: 'parentHandlingUnitId', code: 'INVALID', message: expect.any(String) },
      ],
    });
  });

  it('깊이 2 의 순환(A→B→A)도 잡는다', async () => {
    await expect(assertParentAcyclic(chainTx({ 1: 2, 2: 1 }), 1)).rejects.toBeInstanceOf(
      ContractException,
    );
  });

  it('⭐ 순환이 «아닌» 3단 사슬은 통과한다 — 깊이 상한을 두지 않는다(P-04-01 §8 미결 4)', async () => {
    await expect(assertParentAcyclic(chainTx({ 1: null, 2: 1, 3: 2 }), 3)).resolves.toBeUndefined();
    await expect(assertParentAcyclic(chainTx({}), null)).resolves.toBeUndefined();
  });

  it('⭐ 이미 200단을 넘는 사슬은 400 INVALID 다 — 500 도 무한 루프도 아니다', async () => {
    const links: Record<number, number | null> = {};
    for (let id = 1; id <= 250; id += 1) links[id] = id === 1 ? null : id - 1;

    const error = await thrown(() => assertParentAcyclic(chainTx(links), 250));

    expect(error).toBeInstanceOf(ContractException);
    expect((error as ContractException).getStatus()).toBe(400);
  });
});

describe('취급 단위 등록 — 채번', () => {
  it('⭐ next(HANDLING_UNIT, null, 서버 UTC 날짜) 로 부르고 OPEN 으로 저장한다 // 결정 — 통보 144', async () => {
    const numberingCalls: [string, bigint | null, string][] = [];
    const written: Record<string, unknown>[] = [];

    const prisma = {
      worker: { findUnique: async () => ({ worker_id: 1n }) },
      code_value: {
        findMany: async () => [{ code: 'PALLET', code_group: { group_code: 'HANDLING_UNIT_TYPE' } }],
      },
      item: { findMany: async () => [] },
      lot: { findMany: async () => [] },
      uom: { findMany: async () => [] },
      $transaction: async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        work({
          worker: { findFirst: async () => ({ worker_id: 8n }) },
          terminal: { findFirst: async () => ({ terminal_id: 7n }) },
          audit_event: { create: async () => ({}) },
          handling_unit: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
              written.push(data);
              return { handling_unit_id: 77n };
            },
          },
        } as unknown as Prisma.TransactionClient),
    };
    const numbering = {
      next: async (documentTypeCode: string, plantId: bigint | null, periodDate: string) => {
        numberingCalls.push([documentTypeCode, plantId, periodDate]);
        return 'HU-20260909-0001';
      },
    };
    const queries = {
      get: async () => ({ handlingUnit: { handlingUnitId: 77 }, contents: [], versionNo: 1 }),
    };

    const service = new HandlingUnitService(
      prisma as unknown as PrismaService,
      queries as unknown as HandlingUnitQueryService,
      numbering as unknown as NumberingService,
    );
    const result = await service.create(
      { handlingUnitTypeCode: 'PALLET' },
      { workerNo: '100027', appUserId: 42 },
    );

    // ⛔ `plantId` 는 null 이고(공장 축이 0개다) 기간 축은 «서버 UTC 오늘»이다 — 고정
    //    문자열로 바꾸면 여기가 빨개진다(변이 9).
    expect(numberingCalls).toEqual([['HANDLING_UNIT', null, day()]]);
    expect(written).toEqual([
      expect.objectContaining({
        handling_unit_no: 'HU-20260909-0001',
        handling_unit_type_code: 'PALLET',
        status_code: HU_STATUS_OPEN,
        parent_handling_unit_id: null,
        warehouse_id: null,
        location_id: null,
        created_by: 42,
        updated_by: 42,
      }),
    ]);
    // ⭐ ETag 의 원천이 «캐시되는 본문»에 실린다 — 빠지면 재전송 응답이 토큰을 잃는다(§4-1).
    expect(result.versionNo).toBe(1);

    await service.create(
      { handlingUnitTypeCode: 'PALLET' },
      { workerNo: '100027', workerId: 8n, terminalAudit: {
        workerId: 8n, workerNo: '100027', terminalId: 7n, plantId: 3n,
        correlationId: 'create-1', operationKey: 'POST /inventory/handling-units',
      } },
    );
    expect(written[1]).toMatchObject({ created_by: null, updated_by: null });
  });

  it('⭐ 번호가 부딪히면 다시 뽑는다 — 사용자가 고칠 수 없는 값이라 400 으로 되돌리지 않는다', async () => {
    const used: string[] = [];
    let issued = 0;

    const duplicate = new Prisma.PrismaClientKnownRequestError('중복', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['handling_unit_no'] },
    });
    const prisma = {
      worker: { findUnique: async () => ({ worker_id: 1n }) },
      code_value: {
        findMany: async () => [{ code: 'PALLET', code_group: { group_code: 'HANDLING_UNIT_TYPE' } }],
      },
      item: { findMany: async () => [] },
      lot: { findMany: async () => [] },
      uom: { findMany: async () => [] },
      $transaction: async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        work({
          handling_unit: {
            create: async ({ data }: { data: { handling_unit_no: string } }) => {
              used.push(data.handling_unit_no);
              // 첫 번호만 부딪힌다 — 두 번째는 통과해야 «다시 뽑았다»가 보인다.
              if (used.length === 1) throw duplicate;
              return { handling_unit_id: 77n };
            },
          },
        } as unknown as Prisma.TransactionClient),
    };
    const numbering = {
      next: async () => {
        issued += 1;
        return `HU-20260909-000${issued}`;
      },
    };
    const queries = {
      get: async () => ({ handlingUnit: { handlingUnitId: 77 }, contents: [], versionNo: 1 }),
    };

    const service = new HandlingUnitService(
      prisma as unknown as PrismaService,
      queries as unknown as HandlingUnitQueryService,
      numbering as unknown as NumberingService,
    );
    await service.create(
      { handlingUnitTypeCode: 'PALLET' },
      { workerNo: '100027', appUserId: 42 },
    );

    // ⛔ 같은 번호를 다시 쓰지 않는다 — 재시도가 채번을 «다시» 부른다(결번 허용).
    expect(used).toEqual(['HU-20260909-0001', 'HU-20260909-0002']);
  });
});

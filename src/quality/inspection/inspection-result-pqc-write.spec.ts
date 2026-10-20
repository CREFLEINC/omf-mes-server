import { ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { assertPqcAfterProduction, preparePqcWrite } from './inspection-result-write-rules';

/** PQC 는 실적이 먼저이고, 작성중 1회차는 `POST` 가 덮는다(omf-all-around#107 · 장부 P-49). */
const prismaFor = (options: { type?: string; results?: number; first?: { status_code: string } | null }) => {
  const count = jest.fn().mockResolvedValue(options.results ?? 1);
  const findFirst = jest
    .fn()
    .mockResolvedValue(options.first === undefined || options.first === null ? null : { inspection_result_id: 12n, ...options.first });
  const prisma = {
    inspection_request: {
      findUnique: jest.fn().mockResolvedValue({ inspection_type_code: options.type ?? 'PQC', work_order_id: 2n }),
    },
    production_result: { count },
    inspection_result: { findFirst },
  } as unknown as PrismaService;
  return { prisma, count, findFirst };
};

const rejectionOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return JSON.stringify((error as ContractException).getResponse());
  }
  return 'PASSED';
};

describe('preparePqcWrite', () => {
  it('⛔ 그 W/O 에 생산 실적이 없으면 작업자가 읽을 문구로 400 을 낸다', async () => {
    const { prisma } = prismaFor({ results: 0 });
    const body = await rejectionOf(() => preparePqcWrite(prisma, { inspectionRequestId: 1 }, 1));
    expect(body).toContain('STATE_LOCKED');
    expect(body).toContain('이 MES W/O 의 생산 실적이 아직 없습니다. 실적을 먼저 등록하세요.');
  });

  it('실적은 확정된 «원본» 행만 센다 — 정정본은 따로 세지 않는다', async () => {
    const { prisma, count } = prismaFor({});
    await preparePqcWrite(prisma, { inspectionRequestId: 1 }, 1);
    expect(count).toHaveBeenCalledWith({
      where: { work_order_id: 2n, status_code: 'CONFIRMED', corrects_production_result_id: null },
    });
  });

  it('⭐ 1회차가 작성중이면 그 회차 id 를 돌려준다 — 새로 만들지 않고 덮는다', async () => {
    const { prisma } = prismaFor({ first: { status_code: 'DRAFT' } });
    await expect(preparePqcWrite(prisma, { inspectionRequestId: 1 }, 1)).resolves.toBe(12n);
  });

  it('1회차가 없거나 이미 확정이면 지금처럼 새로 만든다(확정이면 회차 충돌 409)', async () => {
    await expect(preparePqcWrite(prismaFor({ first: null }).prisma, { inspectionRequestId: 1 }, 1)).resolves.toBeNull();
    await expect(
      preparePqcWrite(prismaFor({ first: { status_code: 'CONFIRMED' } }).prisma, { inspectionRequestId: 1 }, 1),
    ).resolves.toBeNull();
  });

  it('재검사 회차(앞 회차 지정)는 덮지 않는다', async () => {
    const { prisma, findFirst } = prismaFor({ first: { status_code: 'DRAFT' } });
    await expect(preparePqcWrite(prisma, { inspectionRequestId: 1, previousResultId: 11 }, 2)).resolves.toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('IQC·OQC 는 실적을 묻지도 덮지도 않는다 — 동작 불변', async () => {
    for (const type of ['IQC', 'OQC']) {
      const { prisma, count, findFirst } = prismaFor({ type, results: 0, first: { status_code: 'DRAFT' } });
      await expect(preparePqcWrite(prisma, { inspectionRequestId: 1 }, 1)).resolves.toBeNull();
      expect(count).not.toHaveBeenCalled();
      expect(findFirst).not.toHaveBeenCalled();
    }
  });
});

describe('assertPqcAfterProduction — `:confirm` 도 같은 판정', () => {
  it('⛔ PQC 인데 실적이 없으면 400', async () => {
    expect(await rejectionOf(() => assertPqcAfterProduction(prismaFor({ results: 0 }).prisma, 1n))).toContain('STATE_LOCKED');
  });

  it('PQC 이고 실적이 있으면 통과, PQC 가 아니면 묻지 않는다', async () => {
    await expect(assertPqcAfterProduction(prismaFor({}).prisma, 1n)).resolves.toBe(true);
    await expect(assertPqcAfterProduction(prismaFor({ type: 'IQC', results: 0 }).prisma, 1n)).resolves.toBe(false);
  });
});

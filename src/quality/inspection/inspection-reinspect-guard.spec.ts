import { ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { assertIqcReinspectable, assertReferences } from './inspection-result-write-rules';
import { InspectionResultCreate } from './inspection-result-write-input';

/** IQC 재검사 회차는 검사 대기 LOT 만(omf-all-around#106 · 3단계 검증) — 처분 전 불량 LOT 의 재검사를 막는다. */
const messageOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return JSON.stringify((error as ContractException).getResponse());
  }
  return 'PASSED';
};

describe('assertIqcReinspectable', () => {
  it('⛔ 처분 전 불합격(불량) LOT 은 재작업 뒤에 재검사하라고 막는다', () => {
    const body = messageOf(() => assertIqcReinspectable('IQC', 'DEFECTIVE'));
    expect(body).toContain('STATE_LOCKED');
    expect(body).toContain('처분 판정(재작업) 뒤에');
  });

  it.each(['NORMAL', 'SCRAPPED'])('⛔ %s LOT 은 다시 검사할 대상이 아니다', (status) => {
    expect(messageOf(() => assertIqcReinspectable('IQC', status))).toContain('검사 대기 중인 LOT 만');
  });

  it('검사 대기(재작업 뒤 · 보류 판정)는 재검사한다', () => {
    expect(messageOf(() => assertIqcReinspectable('IQC', 'INSPECTION_PENDING'))).toBe('PASSED');
  });

  it('PQC·OQC·LOT 없는 의뢰는 지금 동작 그대로다', () => {
    expect(messageOf(() => assertIqcReinspectable('PQC', 'DEFECTIVE'))).toBe('PASSED');
    expect(messageOf(() => assertIqcReinspectable('OQC', 'NORMAL'))).toBe('PASSED');
    expect(messageOf(() => assertIqcReinspectable('IQC', undefined))).toBe('PASSED');
  });
});

describe('assertReferences — 재검사 회차', () => {
  const prismaFor = (lotStatus: string) =>
    ({
      inspection_request: {
        findUnique: async () => ({
          inspection_request_id: 7n,
          version_no: 1,
          inspection_type_code: 'IQC',
          lot: { status_code: lotStatus },
        }),
      },
      uom: { count: async () => 1 },
      inspection_result: {
        findUnique: async () => ({ inspection_request_id: 7n }),
        aggregate: async () => ({ _max: { inspection_round: 1 } }),
      },
    }) as unknown as PrismaService;
  const body = { inspectionRequestId: 7, uomId: 1, previousResultId: 70 } as InspectionResultCreate;

  it('⛔ 처분 전 불량 LOT 이면 회차를 정하기 전에 막는다(작성중 회차가 남지 않는다)', async () => {
    await expect(assertReferences(prismaFor('DEFECTIVE'), body, undefined)).rejects.toBeInstanceOf(ContractException);
  });

  it('검사 대기면 다음 회차(2)를 낸다', async () => {
    await expect(assertReferences(prismaFor('INSPECTION_PENDING'), body, undefined)).resolves.toBe(2);
  });

  it('첫 회차(앞 회차 없음)는 LOT 상태를 보지 않는다', async () => {
    const first = { inspectionRequestId: 7, uomId: 1 } as InspectionResultCreate;
    await expect(assertReferences(prismaFor('DEFECTIVE'), first, undefined)).resolves.toBe(1);
  });
});

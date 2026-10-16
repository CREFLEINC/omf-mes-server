import { ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { InspectionResultWriteContext } from './inspection-result-write-input';
import { resolveInspector } from './inspection-result-write-rules';

/** omf-all-around#104 — 관리웹 계정은 지정된 작업자가 있어야 판정을 저장한다(담당자 검증 2026-10-16). */
describe('resolveInspector — 검사자', () => {
  const prisma = (linked: bigint | null) =>
    ({
      worker: {
        findFirst: jest.fn().mockResolvedValue(linked === null ? null : { worker_id: linked }),
        findUnique: jest.fn().mockResolvedValue({ worker_id: 55n }),
      },
    }) as unknown as PrismaService;
  const context = (extra: Partial<InspectionResultWriteContext>): InspectionResultWriteContext => ({
    workerNo: undefined,
    idempotencyKey: 'k',
    version: undefined,
    appUserId: 9,
    terminalId: null,
    ...extra,
  });

  it('계정에 지정된 작업자가 있으면 그 작업자다', async () => {
    await expect(resolveInspector(prisma(31n), context({}))).resolves.toBe(31n);
  });

  it('⛔ 지정을 해제한 계정은 사번 헤더를 실어도 400 REQUIRED 다', async () => {
    const error = await resolveInspector(prisma(null), context({ workerNo: '901543' })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContractException);
    expect((error as ContractException).errors[0]).toMatchObject({ field: 'X-Worker-No', code: 'REQUIRED' });
  });

  it('지정된 계정의 사번 헤더는 그대로 앞선다(§5-5)', async () => {
    await expect(resolveInspector(prisma(31n), context({ workerNo: '901543' }))).resolves.toBe(55n);
  });

  it('단말은 계정 지정과 무관하게 사번 헤더로 푼다', async () => {
    await expect(
      resolveInspector(prisma(null), context({ appUserId: undefined, terminalId: 7n, workerNo: '901543' })),
    ).resolves.toBe(55n);
  });
});

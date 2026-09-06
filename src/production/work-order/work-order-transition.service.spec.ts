import { ERROR_CODE } from '../../common/errors';
import { DocumentStateService } from '../../core/document-state';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkOrderTransitionService } from './work-order-transition.service';

const WORK_ORDER = 700;

type Row = Record<string, unknown>;

function stub(statusCode = 'RELEASED') {
  const updated: Row[] = [];
  const tx = {
    $queryRaw: () => Promise.resolve([{ status_code: statusCode, released_at: new Date(), version_no: 1 }]),
    work_order: {
      update: ({ data }: { data: Row }) => {
        updated.push(data);
        return Promise.resolve({ version_no: 2 });
      },
    },
  };
  const prisma = {
    $transaction: (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as PrismaService;

  return {
    service: new WorkOrderTransitionService(prisma, new DocumentStateService()),
    updated,
  };
}

describe('W/O 중단·재개 (I-6 PR ④)', () => {
  it('중단 — 사유 코드를 코드값 표와 대조하지 않는다(그룹이 비어 있다 — 문의 035)', async () => {
    const { service, updated } = stub();

    // `WORK_ORDER_HOLD_REASON` 에 값이 0건이라 대조를 켜면 모든 `:hold` 가 400 이 된다.
    // 시드에 없는 아무 문자열이나 통과해야 «본길»이 열린다.
    await service.hold(WORK_ORDER, 1, {
      reasonCode: '시드에-없는-사유',
      occurredAt: '2026-09-06T01:00:00.000Z',
      note: '메모',
    });

    // 사유·발생시각·비고를 담을 칸이 없다 — 상태와 버전만 쓴다(세션에도 손대지 않는다).
    expect(updated).toEqual([{ status_code: 'SUSPENDED', version_no: { increment: 1 } }]);

    // 공백만은 막는다 — 계약이 required 로 적은 칸이고 형식은 우리가 본다.
    await expect(
      service.hold(WORK_ORDER, 1, { reasonCode: '  ', occurredAt: '2026-09-06T01:00:00.000Z' }),
    ).rejects.toMatchObject({ errors: [{ field: 'reasonCode', code: ERROR_CODE.REQUIRED }] });
  });

  it('중단·재개 — If-Match 가 없으면 버전 대조를 건너뛴다(선택 · C-9)', async () => {
    const { service, updated } = stub('SUSPENDED');

    await service.resume(WORK_ORDER, undefined);

    expect(updated).toEqual([{ status_code: 'IN_PROGRESS', version_no: { increment: 1 } }]);
  });
});

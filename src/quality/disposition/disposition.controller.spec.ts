import { DispositionController } from './disposition.controller';
import { DispositionDecisionRow } from './disposition-view';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * `disposition.controller.ts` 단위 시험 — ⭐⭐ 리뷰 Minor-1. `assertFollowUpInvariant` 를
 * «부르는지» 자체는 e2e 로 못 잠근다(오늘 SQL 이 옳아서 그 함수가 실제로 안 던진다 · 순수
 * 부가층). 여기서는 `$queryRawUnsafe` 를 스텁으로 갈아 끼워 「SQL 이 골랐다고 «주장»하는 행」과
 * 「그 행의 실제 판정」이 어긋나게 만든다 — `list()` 안에서 대조 호출이 «빠지면» 이 시험이
 * 통과(=미검출)로 돌아선다(0단계 선례 `health.controller.spec.ts` — 컨트롤러를 fake
 * PrismaService 로 직접 생성한다).
 */
const COMPLETED_SCRAP_ROW: DispositionDecisionRow = {
  disposition_decision_id: 1,
  nonconformance_id: 10,
  disposition_type_code: 'SCRAP',
  decision_qty: '50.000000',
  uom_id: 100,
  reason: '사유',
  decided_by: 200,
  decided_at: new Date('2026-09-01T00:00:00.000Z'),
  approval_request_id: null,
  nonconformance_no: 'NC-0001',
  item_id: 300,
  item_code: 'IT-1',
  item_name: '품목1',
  decided_by_name: '판정자',
  lot_id: 400,
  lot_no: 'LOT-1',
  posted_qty: '50.000000', // 완료(COMPLETED) — SQL 이 followUpPending=true 로 골랐다고 「주장」해도 실제론 아니다
};

function controllerWith(rows: DispositionDecisionRow[], total: number): DispositionController {
  const queryRawUnsafe = jest.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([{ total }]);
  return new DispositionController({ $queryRawUnsafe: queryRawUnsafe } as unknown as PrismaService);
}

describe('DispositionController.list — assertFollowUpInvariant 배선(리뷰 Minor-1)', () => {
  it('⭐⭐ SQL 이 followUpPending=true 로 골랐다고 «주장»하는 행이 실제로는 완료(COMPLETED)면 던진다', async () => {
    // $queryRawUnsafe 가 실제 SQL 텍스트와 무관하게 이 행을 돌려준다 — 「SQL 필터가 골랐다」는
    // 것을 흉내만 낸다. `list()` 가 `assertFollowUpInvariant` 를 안 부르면 그냥 200 이 나간다.
    await expect(controllerWith([COMPLETED_SCRAP_ROW], 1).list({ followUpPending: true })).rejects.toThrow(/followUpPending/);
  });

  it('일치하면 통과한다(양성 대조 — 배선이 있어도 정상 요청까지 막지 않는다)', async () => {
    const partial = { ...COMPLETED_SCRAP_ROW, posted_qty: '10' };
    await expect(controllerWith([partial], 1).list({ followUpPending: true })).resolves.toMatchObject({ page: { total: 1 } });
  });
});

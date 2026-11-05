import { DocumentStateService } from '../../core/document-state';
import { PrismaService } from '../../prisma/prisma.service';
import { RoutingRevisionService } from './routing-revision.service';

/** omf-all-around#231 — 확정은 확정 일시를 함께 적는다(이력 관리 표의 「확정 일시」). */
describe('Routing 확정 — 확정 일시 (omf-all-around#231)', () => {
  it('작성중 → 확정에서 상태와 함께 confirmed_at 을 지금 시각으로 적는다', async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      routing: {
        findUnique: jest.fn().mockResolvedValue({ routing_id: 7n, status_code: 'DRAFT' }),
        update,
      },
      routing_operation: { count: jest.fn().mockResolvedValue(1) },
      audit_event: { create: jest.fn().mockResolvedValue({}) },
    } as unknown as PrismaService & { $transaction: jest.Mock };
    (prisma as unknown as { $transaction: jest.Mock }).$transaction = jest.fn(
      (run: (tx: unknown) => unknown) => run(prisma),
    );
    const documentState = {
      assertTransition: jest.fn().mockReturnValue({ to: 'CONFIRMED' }),
    } as unknown as DocumentStateService;
    const before = Date.now();

    await new RoutingRevisionService(prisma, documentState).confirm(7);

    const data = (update.mock.calls[0]?.[0] as { data: { status_code: string; confirmed_at: Date } })
      .data;
    expect(data.status_code).toBe('CONFIRMED');
    expect(data.confirmed_at).toBeInstanceOf(Date);
    expect(data.confirmed_at.getTime()).toBeGreaterThanOrEqual(before);
  });
});

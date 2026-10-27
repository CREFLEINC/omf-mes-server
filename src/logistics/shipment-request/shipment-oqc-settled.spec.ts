import { oqcSettledLots } from './shipment-oqc-lots';

const T = new Date('2026-10-27T05:00:00.000Z');

function fake(settled: { judgedAt?: Date | null; skippedAt?: Date | null }) {
  const seen: { where?: Record<string, unknown> } = {};
  const prisma = {
    inspection_result: { aggregate: async () => ({ _max: { confirmed_at: settled.judgedAt ?? null, updated_at: null } }) },
    inspection_request: { aggregate: async () => ({ _max: { updated_at: settled.skippedAt ?? null } }) },
    shipment_request_line: { findMany: async () => [{ shipment_request_line_id: 501n }] },
    inventory_reservation: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        seen.where = where;
        return [{ lot_id: 61n }, { lot_id: null }];
      },
    },
  };
  return { prisma: prisma as never, seen };
}

describe('oqcSettledLots — 출하검사가 끝났을 때 검사 대상이던 LOT', () => {
  it('판정도 생략도 없으면 null 이다 — 알릴 것이 없다', async () => {
    expect(await oqcSettledLots(fake({}).prisma, 1n)).toBeNull();
  });

  it('끝난 시각까지 검사 대상 라인이 집은 예약의 LOT 이다 — 그 뒤 집은 LOT 은 들지 않는다', async () => {
    const { prisma, seen } = fake({ judgedAt: T });

    expect(await oqcSettledLots(prisma, 1n)).toEqual(new Set(['61']));
    expect(seen.where).toMatchObject({ created_at: { lte: T }, source_document_id: { in: [501n] } });
  });

  it('생략만 있어도 끝난 것으로 본다 — 둘 다면 늦은 쪽까지', async () => {
    const later = new Date(T.getTime() + 60_000);
    const { prisma, seen } = fake({ judgedAt: T, skippedAt: later });

    await oqcSettledLots(prisma, 1n);

    expect(seen.where).toMatchObject({ created_at: { lte: later } });
  });
});

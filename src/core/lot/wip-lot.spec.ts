import { Prisma } from '@prisma/client';

import { wipQuantities, wipRemaining } from './wip-lot';

const dec = (value: number | string) => new Prisma.Decimal(value);

describe('반제품 남은 투입 가능 수량', () => {
  it('FR-011 — 실적 − 투입이다(실적 100 · 투입 60 → 40)', () => {
    expect(wipRemaining({ produced: dec(100), consumed: dec(60) }).toString()).toBe('40');
  });

  it('FR-011 — 소수도 정확히 뺀다(0.3 − 0.1 = 0.2)', () => {
    expect(wipRemaining({ produced: dec('0.3'), consumed: dec('0.1') }).toString()).toBe('0.2');
  });

  it('FR-011 — 투입이 실적보다 많아도(실적 정정 등) 0 아래로 내려가지 않는다', () => {
    expect(wipRemaining({ produced: dec(50), consumed: dec(60) }).toString()).toBe('0');
  });

  it('FR-011 — 실적이 없으면 0 이다', () => {
    expect(wipRemaining({ produced: dec(0), consumed: dec(0) }).toString()).toBe('0');
  });

  it('LOT 이 없으면 질의하지 않고 빈 결과다', async () => {
    const db = { $queryRaw: jest.fn() };
    expect((await wipQuantities(db as never, [])).size).toBe(0);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});

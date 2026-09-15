import { Prisma } from '@prisma/client';

import { materialLotLabelPng } from './material-lot-label';
import { layoutMaterialLotLabel } from './material-lot-label-layout';
import { materialLotTspl } from './material-lot-tspl';
import { ProductionLotLabelRow, productionLotLabelValues } from './production-lot-label';

const row = (over: Partial<ProductionLotLabelRow> = {}): ProductionLotLabelRow => ({
  issue_seq: 1,
  issued_at: new Date('2026-09-15T09:30:00.000Z'),
  lot: {
    lot_no: 'M00000420260914000001387DCGGNH7LNW',
    status_code: 'INSPECTION_PENDING',
    initial_qty: new Prisma.Decimal(100),
    item: { item_code: 'F534F50200' },
    uom: { uom_code: 'EA' },
    plant: { timezone_code: 'Asia/Ho_Chi_Minh' },
  },
  allocation: { qty: new Prisma.Decimal(100), occurredAt: new Date('2026-09-15T08:00:00.000Z') },
  workOrderNo: 'WO-20260914-0003',
  ...over,
});

const textOf = (values: ReturnType<typeof productionLotLabelValues>): string[] =>
  layoutMaterialLotLabel(values).texts.map((text) => text.content);

describe('생산 LOT 라벨 (D5)', () => {
  it('머리줄에 유형·상태와 W/O 번호를 싣는다', () => {
    const texts = textOf(productionLotLabelValues(row()));

    expect(texts[0]).toContain('PROD');
    expect(texts[0]).toContain('INSPECTION_PENDING');
    expect(texts[0]).toContain('WO-20260914-0003');
  });

  it('품목 코드·수량·LOT 번호를 제자리에 찍는다', () => {
    const texts = textOf(productionLotLabelValues(row()));

    expect(texts[1]).toBe('PART NO.: F534F50200');
    expect(texts[2]).toBe('QTY: 100 EA');
    expect(texts[3]).toContain('LOT NO.: M00000420260914000001387DCGGNH7LNW');
    expect(texts[5]).toBe('ISSUE NO.: 1');
  });

  it('⭐ 수량은 실적 배분 누계다 — 계획 수량이 아니다', () => {
    const partial = productionLotLabelValues(
      row({ allocation: { qty: new Prisma.Decimal(60), occurredAt: new Date('2026-09-15T08:00:00.000Z') } }),
    );

    expect(partial.qty).toBe('60 EA');
  });

  it('배분이 없으면 계획 수량으로, 실적 시각이 없으면 발행 시각으로 갈음한다 — 422 로 막지 않는다', () => {
    const values = productionLotLabelValues(row({ allocation: { qty: null, occurredAt: null } }));

    expect(values.qty).toBe('100 EA');
    // 발행 09:30Z → 공장(UTC+7) 16:30.
    expect(values.mfgDt).toBe('26-09-15 16:30');
  });

  it('생산일은 실적 시각을 공장 시간대로 푼다', () => {
    // 실적 08:00Z → 공장(UTC+7) 15:00.
    expect(productionLotLabelValues(row()).mfgDt).toBe('26-09-15 15:00');
  });

  it('W/O 번호를 못 풀면 머리줄이 자재 라벨과 같은 두 칸으로 남는다', () => {
    const texts = textOf(productionLotLabelValues(row({ workOrderNo: '' })));

    expect(texts[0]).toBe('PROD  INSPECTION_PENDING');
  });

  it('TSPL 은 명령 바이트로, PNG 는 그림으로 난다 — 2D 코드에 LOT 번호를 그대로 싣는다', () => {
    const values = productionLotLabelValues(row());

    const tspl = materialLotTspl(values).toString('ascii');
    expect(tspl.startsWith('SIZE ')).toBe(true);
    expect(tspl).toContain('WO-20260914-0003');
    expect(tspl).toContain(`"${values.lotNo}"`);
    expect(tspl.trimEnd().endsWith('PRINT 1')).toBe(true);

    const png = materialLotLabelPng(values);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.length).toBeGreaterThan(1_000);
  });
});

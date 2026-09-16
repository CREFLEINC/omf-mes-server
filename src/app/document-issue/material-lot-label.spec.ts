import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import { Prisma } from '@prisma/client';

import { LABEL_FONT } from './label-font';
import { DPI } from './label-layout';
import { labelDateTime, labelQty, materialLotLabelPng, materialLotLabelValues } from './material-lot-label';
import { layoutMaterialLotLabel } from './material-lot-label-layout';

describe('material LOT label values', () => {
  const row = {
    issue_seq: 3,
    issued_at: new Date('2026-07-30T17:30:00Z'),
    lot: {
      lot_no: '040101-00022S|12.5|260731|100019|0001',
      lot_type_code: 'MATERIAL',
      status_code: 'NORMAL',
      initial_qty: new Prisma.Decimal('12.500000'),
      manufactured_at: null,
      item: { item_code: '040101-00022S' },
      uom: { uom_code: 'KG' },
      plant: { timezone_code: 'Asia/Ho_Chi_Minh' },
    },
  };

  it('수량은 반올림 없이 천 단위를 끊고 단위 코드를 붙인다', () => {
    expect(labelQty(new Prisma.Decimal('1234567.123456'), 'KG')).toBe('1,234,567.123456 KG');
    expect(labelQty(new Prisma.Decimal('100.000000'), 'EA')).toBe('100 EA');
    expect(labelQty(new Prisma.Decimal('0.5'), 'M')).toBe('0.5 M');
  });

  it('일시는 공장 시간대의 YY-MM-DD HH:mm 이다', () => {
    expect(labelDateTime(new Date('2026-07-30T17:30:00Z'), 'Asia/Ho_Chi_Minh')).toBe('26-07-31 00:30');
  });

  it('자재 LOT 은 RAW 이고, 제조일시가 없으면 발행 일시를 쓴다', () => {
    expect(materialLotLabelValues(row)).toEqual({
      type: 'RAW',
      status: 'NORMAL',
      partNo: '040101-00022S',
      qty: '12.5 KG',
      lotNo: '040101-00022S|12.5|260731|100019|0001',
      mfgDt: '26-07-31 00:30',
      issueSeq: 3,
    });
    const manufactured = { ...row, lot: { ...row.lot, manufactured_at: new Date('2026-07-01T01:05:00Z') } };
    expect(materialLotLabelValues(manufactured).mfgDt).toBe('26-07-01 08:05');
  });

  it('PNG 는 80×30mm(639×240) 이고 QR 칸이 LOT 번호의 QR 모듈과 점 단위로 같다', async () => {
    const values = materialLotLabelValues(row);
    const png = materialLotLabelPng(values);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    const image = await loadImage(png);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    expect([image.width, image.height]).toEqual([639, 240]);

    const { qr } = layoutMaterialLotLabel(values);
    const pixels = ctx.getImageData(qr.x, qr.y, qr.modules.size * qr.cell, qr.modules.size * qr.cell);
    const dark = (x: number, y: number): boolean => pixels.data[(y * pixels.width + x) * 4] < 128;
    const mismatches: string[] = [];
    for (let r = 0; r < qr.modules.size; r += 1) {
      for (let c = 0; c < qr.modules.size; c += 1) {
        if (dark(c * qr.cell + 1, r * qr.cell + 1) !== Boolean(qr.modules.get(r, c))) mismatches.push(`${String(r)},${String(c)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('글자는 등록한 라벨 글꼴로 그린다 — 시스템 글꼴이 없는 운영 이미지에서도 빠지지 않는다', async () => {
    expect(GlobalFonts.has(LABEL_FONT)).toBe(true);
    const values = materialLotLabelValues(row);
    const partNo = layoutMaterialLotLabel(values).texts[1];
    const px = Math.round((partNo.point * DPI) / 72);
    const region = (ctx: SKRSContext2D): number[] => [...ctx.getImageData(partNo.x, partNo.y, partNo.width, px).data];

    const image = await loadImage(materialLotLabelPng(values));
    const actual = createCanvas(image.width, image.height).getContext('2d');
    actual.drawImage(image, 0, 0);

    const expected = createCanvas(image.width, image.height).getContext('2d');
    expected.fillStyle = '#fff';
    expected.fillRect(0, 0, image.width, image.height);
    expected.fillStyle = '#000';
    expected.textBaseline = 'top';
    expected.font = `${String(px)}px ${LABEL_FONT}`;
    expected.fillText(partNo.content, partNo.x, partNo.y, partNo.width);

    expect(region(expected).some((value, index) => index % 4 === 0 && value < 128)).toBe(true);
    expect(region(actual)).toEqual(region(expected));
  });
});

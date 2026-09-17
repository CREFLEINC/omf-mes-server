import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from '@napi-rs/canvas';

import { LABEL_FONT } from './label-font';
import { dots, DPI } from './label-layout';
import { layoutLocationLabel, locationQrPayload, type LocationLabelValues } from './location-label-layout';
import { locationLabelPng, locationLabelValues, type LocationLabelRow } from './location-label';

const STANDARD: LocationLabelValues = {
  warehouseCode: 'S230',
  locationCode: 'S230-01',
  locationName: 'MATERIAL DEFAULT LOC',
  issueSeq: 1,
};

// 위치명 줄의 y — quiet zone 단언에서 QR 의 아래 여백을 재는 기준이다(`ROWS.name`).
const NAME_ROW = dots(30);

// 실측(2026-09-17, 100×60 판 · QR 은 위치 코드만): 페이로드 · 모듈 · 셀 · QR dot · y.
// 영숫자(대문자·숫자·`-`)는 QR 영숫자 모드라 가장 덜 자란다 — 최악은 한글 50자(150바이트)다.
const CASES: Array<{ name: string; values: LocationLabelValues; modules: number; cell: number; qrDot: number; y: number }> = [
  { name: 'S230-01', values: STANDARD, modules: 21, cell: 8, qrDot: 168, y: 40 },
  {
    name: 'A-01-03-C12-SHELF-7-LEVEL-02',
    values: { warehouseCode: 'WH-HANOI-01', locationCode: 'A-01-03-C12-SHELF-7-LEVEL-02', locationName: 'X', issueSeq: 1 },
    modules: 25,
    cell: 7,
    qrDot: 175,
    y: 37,
  },
  {
    name: 'l×50',
    values: { warehouseCode: 'W'.repeat(50), locationCode: 'l'.repeat(50), locationName: 'X', issueSeq: 1 },
    modules: 33,
    cell: 5,
    qrDot: 165,
    y: 40,
  },
  {
    name: '가×50',
    values: { warehouseCode: 'W', locationCode: '가'.repeat(50), locationName: 'X', issueSeq: 1 },
    modules: 49,
    cell: 4,
    qrDot: 196,
    y: 28,
  },
];

describe('위치 라벨 값 (location-label)', () => {
  it('창고 코드·위치 코드·위치명·회차를 옮긴다', () => {
    const row: LocationLabelRow = {
      issue_seq: 7,
      location_code: 'A-01-03',
      location_name: 'RACK A-1-3',
      warehouse: { warehouse_code: 'S230' },
    };

    expect(locationLabelValues(row)).toEqual({
      warehouseCode: 'S230',
      locationCode: 'A-01-03',
      locationName: 'RACK A-1-3',
      issueSeq: 7,
    });
  });
});

describe('위치 라벨 배치 (location-label-layout)', () => {
  // 적치·재고 이동 화면이 스캔 값을 위치 코드 조회에 «그대로» 넣는다 — 창고를 붙이면 0건이다.
  it('QR 페이로드가 위치 코드 그 자체다 — 창고 코드를 붙이지 않는다', () => {
    expect(locationQrPayload(STANDARD)).toBe('S230-01');
    expect(locationQrPayload({ ...STANDARD, warehouseCode: 'S240' })).toBe('S230-01');
  });

  it('표준 입력의 줄 넷이 실측대로다', () => {
    const { texts } = layoutLocationLabel(STANDARD);
    expect(texts.map((text) => [text.content, text.point])).toEqual([
      ['WH: S230', 12],
      ['S230-01', 28],
      ['MATERIAL DEFAULT LOC', 13],
      ['ISSUE NO.: 1', 11],
    ]);
  });

  it('위치 코드가 가장 큰 글씨다', () => {
    const [warehouse, code, name, issue] = layoutLocationLabel(STANDARD).texts;
    expect(code.point).toBeGreaterThan(warehouse.point);
    expect(code.point).toBeGreaterThan(name.point);
    expect(code.point).toBeGreaterThan(issue.point);
  });

  it('QR 셀이 8 dot 이다 — 자재 LOT 라벨(3 dot)보다 커야 거리를 두고 읽힌다', () => {
    expect(layoutLocationLabel(STANDARD).qr.cell).toBe(8);
    expect(layoutLocationLabel(STANDARD).qr.cell).toBeGreaterThan(3);
  });

  it.each(CASES)('$name — 모듈·셀·QR dot·y 가 실측대로다(코드가 길어지면 셀을 줄인다)', ({ values, modules, cell, qrDot, y }) => {
    const { qr } = layoutLocationLabel(values);
    expect(qr.modules.size).toBe(modules);
    expect(qr.cell).toBe(cell);
    expect(qr.modules.size * qr.cell).toBe(qrDot);
    expect(qr.y).toBe(y);
  });

  it.each(CASES)('$name — 사방 여백이 4모듈 이상이다(quiet zone)', ({ values }) => {
    const { width, border, qr } = layoutLocationLabel(values);
    const qrSize = qr.modules.size * qr.cell;
    const right = width - (qr.x + qrSize);
    // 위 여백은 테두리 안쪽부터, 아래 여백은 위치명 줄(`ROWS.name`) 까지 잰다 — QR 이 앉는 칸이
    // 라벨 전체 높이가 아니라 테두리와 위치명 줄 사이이기 때문이다.
    const top = qr.y - border;
    const bottom = NAME_ROW - (qr.y + qrSize);
    expect(right / qr.cell).toBeGreaterThanOrEqual(4);
    expect(top / qr.cell).toBeGreaterThanOrEqual(4);
    expect(bottom / qr.cell).toBeGreaterThanOrEqual(4);
  });

  it('위치명이 길면 글자를 줄이고, 더 줄일 수 없으면 ~ 를 남긴다', () => {
    const base = { warehouseCode: 'S230', locationCode: 'S230-01', issueSeq: 1 };

    // 60자 — 점을 8pt 로 줄이면 칸(735dot, 위치명 줄의 fullWidth)에 그대로 들어간다.
    const reduced = layoutLocationLabel({ ...base, locationName: 'A'.repeat(60) });
    expect(reduced.texts[2].point).toBe(8);
    expect(reduced.texts[2].content).toBe('A'.repeat(60));

    // 80자 — 최소 점(7pt)까지 줄여도 넘쳐 73자 + '~' 로 잘린다.
    const clipped = layoutLocationLabel({ ...base, locationName: 'B'.repeat(80) });
    expect(clipped.texts[2].point).toBe(7);
    expect(clipped.texts[2].content).toBe(`${'B'.repeat(73)}~`);
  });

  it.each([
    ['한글', '자재 기본 위치'],
    ['베트남어 성조 문자', 'Kho Hàng Xưởng'],
  ])('%s 위치명도 그대로 싣는다 — 영문은 권고이지 제약이 아니다', (_label, locationName) => {
    const { texts } = layoutLocationLabel({ ...STANDARD, locationName });

    expect(texts[2].content).toBe(locationName);
  });

  it.each([
    ['따옴표', 'A"B'],
    ['역슬래시', 'A\\B'],
    ['줄바꿈', 'A\nB'],
    ['캐리지 리턴', 'A\rB'],
  ])('⛔ 위치명의 %s 는 422 다 — 모양이 아니라 TSPL 명령이 깨진다', (_label, locationName) => {
    expect(() => layoutLocationLabel({ ...STANDARD, locationName })).toThrow(
      expect.objectContaining({ status: 422 }),
    );
  });
});

describe('위치 라벨 PNG (location-label)', () => {
  it('799×480 PNG 다(매직바이트 + IHDR 폭·높이)', () => {
    const png = locationLabelPng(STANDARD);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // IHDR 은 시그니처(8) 뒤 첫 청크다: 길이(4)+타입(4) 다음이 폭(4)·높이(4).
    expect(png.readUInt32BE(16)).toBe(799);
    expect(png.readUInt32BE(20)).toBe(480);
  });

  it('위치 코드 줄이 등록한 라벨 글꼴로 그려진다 — 글자만 빠진 PNG 를 잡는다', async () => {
    expect(GlobalFonts.has(LABEL_FONT)).toBe(true);
    const code = layoutLocationLabel(STANDARD).texts[1];
    const px = Math.round((code.point * DPI) / 72);
    const region = (ctx: SKRSContext2D): number[] => [...ctx.getImageData(code.x, code.y, code.width, px).data];

    const image = await loadImage(locationLabelPng(STANDARD));
    const actual = createCanvas(image.width, image.height).getContext('2d');
    actual.drawImage(image, 0, 0);

    const expected = createCanvas(image.width, image.height).getContext('2d');
    expected.fillStyle = '#fff';
    expected.fillRect(0, 0, image.width, image.height);
    expected.fillStyle = '#000';
    expected.textBaseline = 'top';
    expected.font = `${String(px)}px ${LABEL_FONT}`;
    expected.fillText(code.content, code.x, code.y, code.width);

    // 기대 그림에 검은 점이 있는지부터 본다 — 둘 다 새하얗기만 해도 통과하는 단언을 막는다.
    expect(region(expected).some((value, index) => index % 4 === 0 && value < 128)).toBe(true);
    expect(region(actual)).toEqual(region(expected));
  });

  it('QR 모듈이 PNG 에 그대로 찍힌다', async () => {
    const png = locationLabelPng(STANDARD);
    const image = await loadImage(png);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);

    const { qr } = layoutLocationLabel(STANDARD);
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
});

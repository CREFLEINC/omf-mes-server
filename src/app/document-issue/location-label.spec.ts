import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from '@napi-rs/canvas';

import { LABEL_FONT, LABEL_FONTS } from './label-font';
import { DPI } from './label-layout';
import { layoutLocationLabel, locationQrPayload, type LocationLabelValues } from './location-label-layout';
import { locationLabelPng, locationLabelValues, type LocationLabelRow } from './location-label';

const STANDARD: LocationLabelValues = {
  warehouseCode: 'S230',
  warehouseName: 'MATERIAL WH',
  locationCode: 'S230-01',
  locationName: 'MATERIAL DEFAULT LOC',
  levelCode: 'CELL',
  issueSeq: 1,
};

// 실측(2026-10-29 배치 개편): 페이로드 · 모듈 · 셀. 영숫자는 QR 영숫자 모드라 가장 덜 자란다 — 최악은 한글 50자(150바이트)다.
const CASES: Array<{ name: string; values: LocationLabelValues; modules: number; cell: number }> = [
  { name: 'S230-01', values: STANDARD, modules: 21, cell: 12 },
  { name: 'A-01-03-C12-SHELF-7-LEVEL-02', values: { ...STANDARD, locationCode: 'A-01-03-C12-SHELF-7-LEVEL-02' }, modules: 25, cell: 12 },
  { name: 'l×50', values: { ...STANDARD, locationCode: 'l'.repeat(50) }, modules: 33, cell: 11 },
  { name: '가×50', values: { ...STANDARD, locationCode: '가'.repeat(50) }, modules: 49, cell: 8 },
];

describe('위치 라벨 값 (location-label)', () => {
  it('별칭이 있으면 이름 줄에 별칭을 싣고 창고명·단계를 옮긴다', () => {
    const row: LocationLabelRow = {
      issue_seq: 7,
      location_code: 'Z01-R003',
      location_name: 'Z01-R003',
      alias_name: '사출 자재 랙',
      location_level_code: 'RACK',
      warehouse: { warehouse_code: 'S230', warehouse_name: 'MATERIAL WH' },
    };

    expect(locationLabelValues(row)).toEqual({
      warehouseCode: 'S230',
      warehouseName: 'MATERIAL WH',
      locationCode: 'Z01-R003',
      locationName: '사출 자재 랙',
      levelCode: 'RACK',
      issueSeq: 7,
    });
    expect(locationLabelValues({ ...row, alias_name: null }).locationName).toBe('Z01-R003');
  });
});

describe('위치 라벨 배치 (location-label-layout)', () => {
  // 적치·재고 이동 화면이 스캔 값을 위치 코드 조회에 «그대로» 넣는다 — 창고를 붙이면 0건이다.
  it('QR 페이로드가 위치 코드 그 자체다 — 창고 코드를 붙이지 않는다', () => {
    expect(locationQrPayload(STANDARD)).toBe('S230-01');
    expect(locationQrPayload({ ...STANDARD, warehouseCode: 'S240' })).toBe('S230-01');
  });

  it('오른쪽 줄 넷이 단계 · 코드 · 이름 · 창고와 회차다 — 영문 머리말이 없다', () => {
    const { texts } = layoutLocationLabel(STANDARD);
    expect(texts.map((text) => text.content)).toEqual(['CELL', 'S230-01', 'MATERIAL DEFAULT LOC', 'S230 | MATERIAL WH | #1']);
    expect(layoutLocationLabel({ ...STANDARD, levelCode: null }).texts.map((text) => text.content))
      .toEqual(['S230-01', 'MATERIAL DEFAULT LOC', 'S230 | MATERIAL WH | #1']);
  });

  it('위치 코드가 가장 큰 글씨다', () => {
    const [level, code, name, footer] = layoutLocationLabel(STANDARD).texts;
    for (const other of [level, name, footer]) expect(code.point).toBeGreaterThan(other.point);
  });

  it('QR 셀이 12 dot 이다 — 종전 8 dot(21mm)보다 크게(2026-10-29)', () => {
    expect(layoutLocationLabel(STANDARD).qr.cell).toBe(12);
  });

  it.each(CASES)('$name — 모듈·셀이 실측대로다(코드가 길어지면 셀을 줄인다)', ({ values, modules, cell }) => {
    const { qr } = layoutLocationLabel(values);
    expect(qr.modules.size).toBe(modules);
    expect(qr.cell).toBe(cell);
  });

  it.each(CASES)('$name — QR 사방 여백이 4모듈 이상이고 글자는 QR 오른쪽 여백 밖에서 시작한다', ({ values }) => {
    const { height, border, qr, texts } = layoutLocationLabel(values);
    const qrSize = qr.modules.size * qr.cell;
    expect((qr.x - border) / qr.cell).toBeGreaterThanOrEqual(4);
    expect((qr.y - border) / qr.cell).toBeGreaterThanOrEqual(4);
    expect((height - border - (qr.y + qrSize)) / qr.cell).toBeGreaterThanOrEqual(4);
    for (const text of texts) expect((text.x - (qr.x + qrSize)) / qr.cell).toBeGreaterThanOrEqual(4);
  });

  it.each(CASES)('$name — 줄들이 QR 의 위 끝부터 아래 끝 사이에 차례로 선다', ({ values }) => {
    const { qr, texts } = layoutLocationLabel(values);
    const bottom = (text: { y: number; point: number }): number => text.y + Math.round((text.point * DPI) / 72);
    expect(texts[0].y).toBe(qr.y);
    expect(Math.abs(bottom(texts[texts.length - 1]) - (qr.y + qr.modules.size * qr.cell))).toBeLessThanOrEqual(1);
    for (let index = 1; index < texts.length; index += 1) expect(texts[index].y).toBeGreaterThan(bottom(texts[index - 1]));
  });

  it('이름이 길면 글자를 줄이고, 더 줄일 수 없으면 ~ 를 남긴다', () => {
    // 40자 — 최소 점(7pt)이면 칸(424dot)에 그대로 들어간다.
    const reduced = layoutLocationLabel({ ...STANDARD, locationName: 'A'.repeat(40) });
    expect(reduced.texts[2].point).toBe(7);
    expect(reduced.texts[2].content).toBe('A'.repeat(40));

    // 60자 — 7pt 로도 넘쳐 41자 + '~' 로 잘린다.
    const clipped = layoutLocationLabel({ ...STANDARD, locationName: 'B'.repeat(60) });
    expect(clipped.texts[2].content).toBe(`${'B'.repeat(41)}~`);
  });

  it.each([
    ['한글', '자재 기본 위치'],
    ['베트남어 성조 문자', 'Kho Hàng Xưởng'],
  ])('%s 이름도 그대로 싣는다 — 영문은 권고이지 제약이 아니다', (_label, locationName) => {
    const { texts } = layoutLocationLabel({ ...STANDARD, locationName });

    expect(texts[2].content).toBe(locationName);
  });

  it.each([
    ['따옴표', 'A"B'],
    ['역슬래시', 'A\\B'],
    ['줄바꿈', 'A\nB'],
    ['캐리지 리턴', 'A\rB'],
  ])('⛔ 이름·창고명의 %s 는 422 다 — 모양이 아니라 TSPL 명령이 깨진다', (_label, bad) => {
    expect(() => layoutLocationLabel({ ...STANDARD, locationName: bad })).toThrow(expect.objectContaining({ status: 422 }));
    expect(() => layoutLocationLabel({ ...STANDARD, warehouseName: bad })).toThrow(expect.objectContaining({ status: 422 }));
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
    expected.font = `${String(px)}px ${LABEL_FONTS}`;
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

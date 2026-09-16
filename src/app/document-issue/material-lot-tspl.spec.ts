import { materialLotTspl } from './material-lot-tspl';

describe('materialLotTspl', () => {
  const values = {
    type: 'RAW',
    status: 'INSPECTION_PENDING',
    partNo: '040101-00022S',
    qty: '12.5 KG',
    lotNo: '040101-00022S|12.5|260731|100019|0001',
    mfgDt: '26-07-31 09:15',
    issueSeq: 2,
  };
  const lines = (bytes: Buffer): string[] => bytes.toString('ascii').split('\r\n');

  it('클라이언트 목업(renderLotTspl)과 같은 머리말·BOX·줄 좌표·글자 크기로 CRLF TSPL 을 낸다', () => {
    // 기대값은 omf-mes-client tools/mock/label-tspl.mjs 를 같은 값으로 돌린 출력에서
    // 품명 줄을 빼고, DMATRIX `L1|…` 묶음을 LOT 번호 그대로의 QRCODE 로 바꾼 것이다.
    expect(materialLotTspl(values).toString('ascii')).toBe([
      'SIZE 100 mm,60 mm',
      'GAP 2 mm,0 mm',
      'DIRECTION 1',
      'CLS',
      'BOX 0,0,638,239,2',
      'TEXT 28,14,"0",0,10,10,"RAW  INSPECTION_PENDING"',
      'TEXT 28,48,"0",0,12,12,"PART NO.: 040101-00022S"',
      'TEXT 28,122,"0",0,12,12,"QTY: 12.5 KG"',
      'TEXT 28,164,"0",0,9,9,"LOT NO.: 040101-00022S|12.5|260731|100019|0001"',
      'TEXT 28,200,"0",0,8,8,"MFG DT: 26-07-31 09:15"',
      'TEXT 326,200,"0",0,8,8,"ISSUE NO.: 2"',
      'QRCODE 536,24,M,3,A,0,M2,S7,"040101-00022S|12.5|260731|100019|0001"',
      'PRINT 1',
      '',
    ].join('\r\n'));
  });

  it('LOT 이 길어 QR 버전이 커져도 오른쪽 여백에 붙어 BOX 안에 선다', () => {
    const lotNo = '040101-00022S|1234.123456|260731|CVNET00006|0001';
    const qr = lines(materialLotTspl({ ...values, lotNo })).find((line) => line.startsWith('QRCODE '));
    // 48자는 버전 4(33칸) — 33×3 = 99dot, 639 - 16 - 99 = 524.
    expect(qr).toBe(`QRCODE 524,24,M,3,A,0,M2,S7,"${lotNo}"`);
  });

  it('7pt 로도 넘치는 줄은 ~ 로 잘라 옆 칸을 덮지 않는다', () => {
    const status = 'VERY_LONG_STATUS_CODE_THAT_DOES_NOT_FIT_IN_THE_TOP_COLUMN_AT_ALL';
    expect(lines(materialLotTspl({ ...values, status }))).toContain(
      'TEXT 28,14,"0",0,7,7,"RAW  VERY_LONG_STATUS_CODE_THAT_DOES_NOT_FIT_IN~"',
    );
  });

  it('공백·#·/ 가 든 품목 코드는 그대로 찍는다', () => {
    expect(lines(materialLotTspl({ ...values, partNo: 'AB 12#3/4' }))).toContain(
      'TEXT 28,48,"0",0,12,12,"PART NO.: AB 12#3/4"',
    );
  });

  it('⛔ 명령을 깨는 값은 명령을 만들지 않고 422 다 — 따옴표·역슬래시·제어문자', () => {
    for (const lotNo of ['LOT-1"\r\nPRINT 2,2', 'LOT-1\\X', 'LOT-1\u0000']) {
      expect(() => materialLotTspl({ ...values, lotNo })).toThrow(expect.objectContaining({ status: 422 }));
    }
    expect(() => materialLotTspl({ ...values, partNo: 'A"B' })).toThrow(expect.objectContaining({ status: 422 }));
  });

  // ERP 품목 코드에 전각 괄호가 섞인 값이 실제로 있다(`FS-536（SD）`). ASCII 를 강제하던 때는
  // 그 품목의 라벨을 아예 못 찍었다 — 모양이 깨지는 것과 명령이 깨지는 것은 다르다.
  it('⭐ ASCII 밖 값도 명령을 만든다 — 바이트를 뭉개지 않는다', () => {
    const partNo = 'FS-536（SD）';
    const bytes = materialLotTspl({ ...values, partNo });

    expect(bytes.includes(Buffer.from(partNo, 'utf8'))).toBe(true);
  });
});

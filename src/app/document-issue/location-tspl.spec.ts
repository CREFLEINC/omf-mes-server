import { layoutLocationLabel, locationQrPayload, type LocationLabelValues } from './location-label-layout';
import { locationTspl } from './location-tspl';

const STANDARD: LocationLabelValues = {
  warehouseCode: 'S230',
  locationCode: 'S230-01',
  locationName: 'MATERIAL DEFAULT LOC',
  issueSeq: 1,
};

const lines = (bytes: Buffer): string[] => bytes.toString('ascii').split('\r\n');

describe('locationTspl', () => {
  it('SIZE·GAP·DIRECTION·CLS 로 시작하고 PRINT 1 로 끝난다 — POP 셸이 SIZE 시그니처를 본다', () => {
    const tspl = locationTspl(STANDARD).toString('ascii');
    expect(tspl.startsWith('SIZE 100 mm,60 mm\r\nGAP 2 mm,0 mm\r\nDIRECTION 1\r\nCLS\r\n')).toBe(true);
    expect(tspl.trimEnd().endsWith('PRINT 1')).toBe(true);
  });

  it('줄 넷이 각각 TEXT 명령으로 나온다', () => {
    const { texts } = layoutLocationLabel(STANDARD);
    const textLines = lines(locationTspl(STANDARD)).filter((line) => line.startsWith('TEXT '));

    expect(textLines).toEqual(
      texts.map(
        (text) => `TEXT ${String(text.x)},${String(text.y)},"0",0,${String(text.point)},${String(text.point)},"${text.content}"`,
      ),
    );
    expect(textLines).toEqual([
      'TEXT 28,24,"0",0,10,10,"WH: S230"',
      'TEXT 28,60,"0",0,20,20,"S230-01"',
      'TEXT 28,128,"0",0,10,10,"MATERIAL DEFAULT LOC"',
      'TEXT 28,172,"0",0,8,8,"ISSUE NO.: 1"',
    ]);
  });

  it('QRCODE 명령에 창고코드/위치코드가 실리고 셀 크기가 배치와 같다', () => {
    const { qr } = layoutLocationLabel(STANDARD);
    const qrLine = lines(locationTspl(STANDARD)).find((line) => line.startsWith('QRCODE '));

    expect(qrLine).toBe(`QRCODE ${String(qr.x)},${String(qr.y)},M,${String(qr.cell)},A,0,M2,S7,"${locationQrPayload(STANDARD)}"`);
    expect(qrLine).toBe('QRCODE 439,36,M,8,A,0,M2,S7,"S230/S230-01"');
  });

  it('BOX 가 라벨 경계다', () => {
    const { width, height, border } = layoutLocationLabel(STANDARD);
    const boxLine = lines(locationTspl(STANDARD)).find((line) => line.startsWith('BOX '));

    expect(boxLine).toBe(`BOX 0,0,${String(width - 1)},${String(height - 1)},${String(border)}`);
    expect(boxLine).toBe('BOX 0,0,638,239,2');
  });

  it('줄을 CRLF 로 잇는다', () => {
    const tspl = locationTspl(STANDARD).toString('ascii');
    // '\n' 은 모두 '\r\n' 의 일부다 — 맨앞에 홀로 선 '\r' 없는 '\n' 이 없다.
    expect(tspl.match(/(?<!\r)\n/)).toBeNull();
    expect(tspl.endsWith('\r\n')).toBe(true);
  });
});

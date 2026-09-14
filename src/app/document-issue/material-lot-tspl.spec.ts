import { materialLotTspl } from './material-lot-tspl';

describe('materialLotTspl', () => {
  const values = {
    itemCode: '990020001', lotNo: '9900200010000001002609111000190001',
    quantity: '100', issueSequence: '2',
  };

  it('emits CRLF-delimited RAW TSPL with the issued lot and issue sequence', () => {
    const bytes = materialLotTspl(values);
    const text = bytes.toString('ascii');
    expect(text.startsWith('SIZE 100 mm, 60 mm\r\n')).toBe(true);
    expect(text).toContain(`QRCODE 600,175,L,5,A,0,M2,S7,"${values.lotNo}"\r\n`);
    expect(text).toContain('QTY 100  ISSUE 2');
    expect(text.endsWith('PRINT 1,1\r\n')).toBe(true);
    expect(text.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('rejects control characters, quotes and backslashes rather than producing commands with changed values', () => {
    for (const lotNo of ['LOT-1"\r\nPRINT 2,2', 'LOT-1\\X', 'LOT-1\u0000']) {
      expect(() => materialLotTspl({ ...values, lotNo })).toThrow();
    }
  });

  it('통보 277 구분자 형식(| 포함) LOT 번호는 통과한다', () => {
    const lotNo = '040101-00022S|100|260911|100019|0001';
    const bytes = materialLotTspl({ ...values, lotNo });
    const text = bytes.toString('ascii');
    expect(text).toContain(`QRCODE 600,175,L,5,A,0,M2,S7,"${lotNo}"\r\n`);
    expect(text).toContain(`LOT ${lotNo}`);
  });
});

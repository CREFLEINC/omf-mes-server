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
});

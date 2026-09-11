import { materialMesLotNo } from './lot-number';

describe('materialMesLotNo', () => {
  it('2026-09-11을 YYMMDD=260911로 넣어 모바일 34자리 분절과 왕복된다', () => {
    const lotNo = materialMesLotNo({
      itemCode: '990020001',
      qty: 100,
      businessDate: '2026-09-11',
      supplierCode: '100019',
      serial: 1,
    });
    expect(lotNo).toBe('9900200010000001002609111000190001');
    expect(lotNo).toHaveLength(34);
    expect(lotNo).toMatch(/^\d{34}$/);
  });
});

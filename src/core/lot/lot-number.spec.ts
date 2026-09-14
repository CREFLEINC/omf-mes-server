import {
  MaterialLotFormatError,
  materialLotPrefix,
  materialMesLotNo,
  normalizeLotQty,
  parseMaterialLotNo,
} from './lot-number';

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

/** `MaterialLotFormatError` 를 잡아 돌려준다 — 안 던지면 그 자체가 실패다. */
function captureFormatError(fn: () => unknown): MaterialLotFormatError {
  try {
    fn();
  } catch (error) {
    if (error instanceof MaterialLotFormatError) return error;
    throw error;
  }
  throw new Error('MaterialLotFormatError 가 던져지지 않았다');
}

describe('normalizeLotQty', () => {
  it('후행 0을 뗀다 — 100.000000 → 100', () => {
    expect(normalizeLotQty(100)).toBe('100');
  });

  it('후행 0을 뗀다 — 12.5 → 12.5(소수점은 남긴다)', () => {
    expect(normalizeLotQty(12.5)).toBe('12.5');
  });

  it('float 함정 — 0.1 + 0.2 가 0.3으로 나온다', () => {
    expect(normalizeLotQty(0.1 + 0.2)).toBe('0.3');
  });

  it('소수 7자리 이상은 DB 스케일(6)로 반올림된다', () => {
    expect(normalizeLotQty(0.1234567)).toBe('0.123457');
  });

  it('0은 거절한다', () => {
    expect(captureFormatError(() => normalizeLotQty(0)).kind).toBe('SEGMENT');
  });

  it('음수는 거절한다', () => {
    expect(captureFormatError(() => normalizeLotQty(-5)).kind).toBe('SEGMENT');
  });

  it('NaN은 거절한다', () => {
    expect(captureFormatError(() => normalizeLotQty(NaN)).kind).toBe('SEGMENT');
  });

  it('Infinity는 거절한다', () => {
    expect(captureFormatError(() => normalizeLotQty(Infinity)).kind).toBe('SEGMENT');
  });

  it('아주 큰 값도 지수 표기로 새지 않는다', () => {
    expect(normalizeLotQty(1_000_000)).toBe('1000000');
  });
});

describe('materialLotPrefix', () => {
  it('실 자재 코드로 접두가 선다 — 040101-00022S(#620 회귀 확인)', () => {
    expect(
      materialLotPrefix({ itemCode: '040101-00022S', qty: 12.5, businessDate: '2026-07-31', supplierCode: '100019' }),
    ).toBe('040101-00022S|12.5|260731|100019|');
  });

  it('제품코드에 구분자 |가 섞이면 SEGMENT 오류다', () => {
    const err = captureFormatError(() =>
      materialLotPrefix({ itemCode: '040101|00022S', qty: 1, businessDate: '2026-07-31', supplierCode: '100019' }),
    );
    expect(err.kind).toBe('SEGMENT');
  });

  it('공급사 코드에 비ASCII 문자가 섞이면 SEGMENT 오류다', () => {
    const err = captureFormatError(() =>
      materialLotPrefix({ itemCode: '040101-00022S', qty: 1, businessDate: '2026-07-31', supplierCode: '공급사001' }),
    );
    expect(err.kind).toBe('SEGMENT');
  });

  it('제품코드에 제어문자가 섞이면 SEGMENT 오류다', () => {
    const err = captureFormatError(() =>
      materialLotPrefix({ itemCode: '040101\t00022S', qty: 1, businessDate: '2026-07-31', supplierCode: '100019' }),
    );
    expect(err.kind).toBe('SEGMENT');
  });

  it('조립 길이가 64자를 넘으면 LENGTH 오류다', () => {
    const err = captureFormatError(() =>
      materialLotPrefix({
        itemCode: 'A'.repeat(30),
        qty: 1,
        businessDate: '2026-07-31',
        supplierCode: 'B'.repeat(30),
      }),
    );
    expect(err.kind).toBe('LENGTH');
  });
});

describe('parseMaterialLotNo', () => {
  it('만든 값을 되읽으면 같은 칸이 나온다(왕복)', () => {
    const prefix = materialLotPrefix({
      itemCode: '040101-00022S',
      qty: 12.5,
      businessDate: '2026-07-31',
      supplierCode: '100019',
    });
    expect(parseMaterialLotNo(`${prefix}0001`)).toEqual({
      itemCode: '040101-00022S',
      qty: '12.5',
      date: '260731',
      supplierCode: '100019',
      serial: 1,
    });
  });

  it('칸이 4개면 거절한다', () => {
    expect(() => parseMaterialLotNo('A|1|260731|100019')).toThrow(MaterialLotFormatError);
  });

  it('칸이 6개면 거절한다', () => {
    expect(() => parseMaterialLotNo('A|1|260731|100019|0001|extra')).toThrow(MaterialLotFormatError);
  });

  it('없는 날짜(260230)는 거절한다', () => {
    expect(() => parseMaterialLotNo('A|1|260230|100019|0001')).toThrow(MaterialLotFormatError);
  });

  it('없는 날짜(261301 — 13월)는 거절한다', () => {
    expect(() => parseMaterialLotNo('A|1|261301|100019|0001')).toThrow(MaterialLotFormatError);
  });

  it('없는 날짜(260732 — 31일 없는 달과 다른 32일)는 거절한다', () => {
    expect(() => parseMaterialLotNo('A|1|260732|100019|0001')).toThrow(MaterialLotFormatError);
  });

  it('번호 칸이 4자리 숫자가 아니면 거절한다 — 001', () => {
    expect(() => parseMaterialLotNo('A|1|260731|100019|001')).toThrow(MaterialLotFormatError);
  });

  it('번호 칸이 4자리 숫자가 아니면 거절한다 — 00001', () => {
    expect(() => parseMaterialLotNo('A|1|260731|100019|00001')).toThrow(MaterialLotFormatError);
  });

  it('번호 칸이 4자리 숫자가 아니면 거절한다 — abcd', () => {
    expect(() => parseMaterialLotNo('A|1|260731|100019|abcd')).toThrow(MaterialLotFormatError);
  });

  it('번호 칸 0000은 거절한다', () => {
    expect(() => parseMaterialLotNo('A|1|260731|100019|0000')).toThrow(MaterialLotFormatError);
  });

  it('정규형이 아닌 수량(12.50)도 파싱은 통과한다 — 비교하지 않는 칸이라 공급사 라벨에 관대하다', () => {
    expect(parseMaterialLotNo('A|12.50|260731|100019|0001').qty).toBe('12.50');
  });

  it('빈 칸(제품코드)은 거절한다', () => {
    expect(() => parseMaterialLotNo('|1|260731|100019|0001')).toThrow(MaterialLotFormatError);
  });

  it('빈 칸(공급사)은 거절한다', () => {
    expect(() => parseMaterialLotNo('A|1|260731||0001')).toThrow(MaterialLotFormatError);
  });
});

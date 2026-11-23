import { legacySkip } from './inbound-lot-reopenable';

/** 마감 취소 판정 — 기본 생략만 «검사 전»으로 본다(omf-all-around#353). */
describe('legacySkip', () => {
  it('기본 생략(DEFAULT)은 옛 생략이 아니다', () => {
    expect(legacySkip('DEFAULT')).toBe(false);
  });

  it.each([['APPROVAL'], [null]])('근거 %s 는 없앤 건별 생략이 남긴 옛 생략이다', (basis) => {
    expect(legacySkip(basis)).toBe(true);
  });
});

import { assertTsplSafe, clip, dots, fit } from './label-layout';

/**
 * 기대치를 «숫자로» 박는다 — 어림 공식(`charWidth`)을 여기서 다시 계산하면 공식이 바뀔 때
 * 기대치도 같이 따라가, 정작 바뀐 것을 못 잡는다. 10pt 한 글자는 약 14.1dot 이다.
 */
describe('label-layout 공통 도구', () => {
  describe('dots', () => {
    it('80mm 을 639 dot 으로 바꾼다 — 8 dots/mm 로 갈음하면 한 점 어긋난다', () => {
      expect(dots(80)).toBe(639);
      expect(dots(80)).not.toBe(80 * 8);
    });
  });

  describe('fit', () => {
    it('칸에 맞을 때까지 point 를 줄인다', () => {
      // 10자가 142dot 에 들어가는 최대 크기는 10pt 다(10pt → 141dot · 11pt → 155dot).
      expect(fit('HELLOWORLD', 14, 142)).toBe(10);
    });

    it('최소 크기(7pt) 아래로는 내려가지 않는다', () => {
      const content = 'X'.repeat(50);
      // 시작 point 도, 칸(1dot)도 다르지만 바닥은 똑같다 — 값을 import 하지 않고 동작으로 잰다.
      expect(fit(content, 30, 1)).toBe(7);
      expect(fit(content, 9, 1)).toBe(7);
    });
  });

  describe('clip', () => {
    it('칸 안이면 그대로 둔다', () => {
      expect(clip('ABC', 10, 1000)).toBe('ABC');
    });

    it('넘치면 끝에 ~ 를 남긴다', () => {
      // 92dot 에는 10pt 글자가 여섯 자 들어간다 — 앞 다섯 자에 `~` 를 붙여 잘린 것을 보인다.
      expect(clip('ABCDEFGHIJ', 10, 92)).toBe('ABCDE~');
    });

    it('방이 아주 좁아도 최소 한 글자 + ~ 를 남긴다', () => {
      expect(clip('ABCDEFGHIJ', 10, 1)).toBe('A~');
    });
  });

  describe('assertTsplSafe', () => {
    it('ASCII 를 통과시킨다', () => {
      expect(() => assertTsplSafe('Hello, World! #123-ABC')).not.toThrow();
    });

    // 프린터가 못 찍는 것과 명령이 깨지는 것은 다르다 — 앞은 «모양», 뒤는 «다른 것이 찍힘» 이다.
    it.each([
      ['한글', '자재 기본 위치'],
      ['베트남어 성조 문자', 'Kho Hàng Xưởng'],
      ['전각 괄호(실제 ERP 품목 코드)', 'FS-536（SD）'],
    ])('%s 도 통과시킨다 — 깨지는 것은 모양뿐이다', (_label, value) => {
      expect(() => assertTsplSafe(value)).not.toThrow();
    });

    it.each([
      ['따옴표', 'A"B'],
      ['역슬래시', 'A\\B'],
      ['줄바꿈', 'A\nB'],
      ['캐리지 리턴', 'A\rB'],
      ['NUL', 'A\u0000B'],
    ])('⛔ %s 는 422 다 — TSPL 명령이 깨진다', (_label, value) => {
      expect(() => assertTsplSafe(value)).toThrow(expect.objectContaining({ status: 422 }));
    });
  });
});

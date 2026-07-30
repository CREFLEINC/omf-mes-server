import { toPositiveInt } from './config.util';

describe('toPositiveInt', () => {
  // 이 함수가 있는 이유. ConfigService 가 '28800' 을 돌려주고 그게 jsonwebtoken 에
  // 그대로 들어가면 ms() 가 밀리초로 읽어 토큰이 28초 만료가 된다.
  it('환경변수에서 온 숫자 문자열을 숫자로 바꾼다', () => {
    expect(toPositiveInt('28800', 1)).toBe(28800);
    expect(typeof toPositiveInt('28800', 1)).toBe('number');
  });

  it('숫자는 그대로 통과시킨다', () => {
    expect(toPositiveInt(28800, 1)).toBe(28800);
  });

  it.each([
    ['빈 문자열', ''],
    ['공백', '   '],
    ['미설정', undefined],
    ['null', null],
    ['숫자 아님', 'eight-hours'],
    ['0', '0'],
    ['음수', '-1'],
    ['소수', '1.5'],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('%s 이면 기본값을 쓴다', (_label, input) => {
    expect(toPositiveInt(input, 28800)).toBe(28800);
  });
});

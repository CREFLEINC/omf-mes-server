import { maskPhone } from './notification-dispatch.service';

describe('maskPhone', () => {
  it('표준형을 국내형으로 바꾸고 가운데를 가린다', () => {
    expect(maskPhone('84912345678')).toBe('091*****78');
    expect(maskPhone('84387654321')).toBe('038*****21');
  });
});

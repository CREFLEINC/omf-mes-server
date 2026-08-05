import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';

describe('기동 시 JWT_SECRET 검증', () => {
  const original = process.env.JWT_SECRET;

  afterEach(() => {
    // process.env 에 undefined 를 넣으면 문자열 'undefined' 가 된다 — 32자 미만이라
    // 뒤따르는 테스트의 기동이 실패한다. 없던 값은 지워서 복원한다.
    if (original === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = original;
  });

  it.each([
    ['없으면', undefined],
    ['빈 문자열이면', ''],
    ['32자 미만이면', 'x'.repeat(31)],
  ])('%s 기동이 실패한다 — 약한 키로 조용히 운영에 올라가면 안 된다', async (_label, value) => {
    if (value === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = value;

    await expect(Test.createTestingModule({ imports: [AppModule] }).compile()).rejects.toThrow(
      /JWT_SECRET/,
    );
  });

  it('32자 이상이면 기동한다', async () => {
    process.env.JWT_SECRET = 'x'.repeat(32);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.close();
  });
});

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

/**
 * 본문 해석은 라우트·인증보다 앞에서 일어난다 — 그래서 토큰 없이 아무 저장 API 로 재현한다.
 * 해석기 원문(「Unexpected token …」)에는 보낸 본문 일부가 섞이므로 응답에 그대로 실리면 안 된다.
 */
describe('요청 본문 해석 오류 (e2e)', () => {
  let app: INestApplication;
  const URL = '/api/production/work-sessions';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (body: string, contentType = 'application/json') =>
    request(app.getHttpServer()).post(URL).set('Content-Type', contentType).send(body);

  it.each([
    ['null', 'null'],
    ['문자열', '"abc"'],
    ['깨진 JSON', '{"workOrderId": 1,'],
  ])('본문이 %s 이면 400 이고 한국어 문구다 — 해석기 원문을 싣지 않는다', async (_label, body) => {
    const response = await post(body).expect(400);

    expect(response.body).toEqual({
      errors: [
        {
          scope: 'screen',
          code: 'BAD_REQUEST',
          message: '요청 본문이 JSON 객체 형식이 아닙니다. 올바른 JSON 객체로 보내세요.',
        },
      ],
    });
  });

  it('본문이 크기 제한을 넘으면 413 이고 줄이라고 알린다', async () => {
    const body = JSON.stringify({ remarks: 'x'.repeat(200 * 1024) });

    const response = await post(body).expect(413);

    expect(response.body).toEqual({
      errors: [
        {
          scope: 'screen',
          code: 'PAYLOAD_TOO_LARGE',
          message: '요청 본문이 너무 큽니다(최대 100kb). 본문을 줄이거나 나눠 보내세요.',
        },
      ],
    });
  });

  it('지원하지 않는 charset 이면 415 이고 UTF-8 로 보내라고 알린다', async () => {
    const response = await post('{}', 'application/json; charset=latin1').expect(415);

    expect(response.body).toEqual({
      errors: [
        {
          scope: 'screen',
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: '요청 본문의 문자 인코딩(charset)을 지원하지 않습니다. UTF-8 로 보내세요.',
        },
      ],
    });
  });

  it('지원하지 않는 Content-Encoding 이면 415 이고 압축 없이 보내라고 알린다', async () => {
    const response = await request(app.getHttpServer())
      .post(URL)
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'compress')
      .send('{}')
      .expect(415);

    expect(response.body).toEqual({
      errors: [
        {
          scope: 'screen',
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: '요청 본문의 압축 방식(Content-Encoding)을 지원하지 않습니다. 압축하지 않거나 gzip·deflate·br 중 하나로 보내세요.',
        },
      ],
    });
  });

  /** `configureBodyParsing` 이 먼저 단 해석기를 Nest 가 `init` 때 또 달면 오류가 바꿈 층을 건너뛴 채 둘째 해석기에서 난다. */
  it('해석기는 하나씩만 달려 있고 정상 본문은 해석기를 지나 다음 단계(인증)로 간다', async () => {
    const stack = (app.getHttpAdapter().getInstance() as { router: { stack: { name: string }[] } }).router.stack;
    expect(stack.filter((layer) => layer.name === 'jsonParser')).toHaveLength(1);
    expect(stack.filter((layer) => layer.name === 'urlencodedParser')).toHaveLength(1);

    await post('{"workOrderId": 1}').expect(401);
  });
});

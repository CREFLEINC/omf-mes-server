import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';
import { configureApp, enableBigIntSerialization } from './app.setup';

enableBigIntSerialization();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  const prefix = config.get<string>('API_PREFIX', 'api');
  configureApp(app, prefix);

  const swaggerConfig = new DocumentBuilder()
    .setTitle('OMF MES API')
    .setDescription(
      '기준정보(마스터)·접근권한 관리 API.\n\n' +
        '**대부분의 엔드포인트가 인증을 요구한다.** 우측 상단 **Authorize**를 누르기 전에 ' +
        '`POST /api/auth/login`으로 토큰을 받아 붙여넣어야 한다(값만, `Bearer` 접두사 없이).\n\n' +
        '기능권한이 없으면 403이 난다 — `GET /api/auth/me`로 내 권한을 확인할 수 있다.',
    )
    .setVersion('0.1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      // addSecurityRequirements의 이름과 맞춰야 자물쇠가 전 엔드포인트에 걸린다.
      'bearer',
    )
    // 개별 컨트롤러마다 @ApiBearerAuth()를 붙이는 대신 전역으로 건다 — 붙이는 걸 깜빡할 여지를 없앤다.
    .addSecurityRequirements('bearer')
    .build();
  SwaggerModule.setup(`${prefix}/docs`, app, SwaggerModule.createDocument(app, swaggerConfig), {
    swaggerOptions: {
      // 새로고침해도 토큰이 유지된다 — 문서를 보며 여러 번 호출할 때 매번 붙이지 않게.
      persistAuthorization: true,
      tagsSorter: 'alpha',
    },
  });

  const port = config.get<number>('PORT', 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`OMF MES API listening on http://localhost:${port}/${prefix} (docs: /${prefix}/docs)`);
}

void bootstrap();

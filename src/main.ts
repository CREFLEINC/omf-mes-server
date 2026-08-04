import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  // 계약(mdm-기준정보.json)의 servers 가 /api 다. 프리픽스를 바꾸면 전 경로가 어긋난다.
  const prefix = config.get<string>('API_PREFIX') ?? 'api';
  app.setGlobalPrefix(prefix);

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('OMF MES API').setVersion('0.1.0').build(),
  );
  SwaggerModule.setup(`${prefix}/docs`, app, document);

  // ConfigService 는 환경변수를 문자열로 돌려준다. 빈 문자열은 0, 잘못된 값은 NaN 이
  // 되는데 둘 다 포트로 쓰면 안 되므로 기본값으로 되돌린다.
  const port = Number(config.get('PORT')) || 3100;
  await app.listen(port);

  // eslint-disable-next-line no-console
  console.log(`OMF MES API listening on http://localhost:${port}/${prefix} (docs: /${prefix}/docs)`);
}

void bootstrap();

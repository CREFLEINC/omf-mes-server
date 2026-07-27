import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';

// 정본 물리 모델의 PK·FK는 전부 bigint라 Prisma가 BigInt를 돌려준다.
// JSON.stringify는 BigInt에서 TypeError를 던지므로 문자열로 직렬화한다.
// (number로 바꾸면 2^53 초과 시 정밀도가 깨진다 — 문자열이 안전하다.)
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint) {
  return this.toString();
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  const prefix = config.get<string>('API_PREFIX', 'api');
  app.setGlobalPrefix(prefix);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // 암묵 변환은 켜지 않는다 — 'false' 문자열을 Boolean(…)=true로 바꿔
      // DTO의 @Transform 결과를 덮어쓴다. 변환은 DTO에서 @Type/@Transform으로 명시한다.
    }),
  );
  app.useGlobalFilters(new PrismaExceptionFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('OMF MES API')
    .setDescription('OMF MES 백엔드 API — 기준정보(마스터) 관리')
    .setVersion('0.1.0')
    .build();
  SwaggerModule.setup(`${prefix}/docs`, app, SwaggerModule.createDocument(app, swaggerConfig));

  const port = config.get<number>('PORT', 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`OMF MES API listening on http://localhost:${port}/${prefix} (docs: /${prefix}/docs)`);
}

void bootstrap();

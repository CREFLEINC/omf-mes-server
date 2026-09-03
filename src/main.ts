import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { buildContractDocument, servedOperations } from './common/contract';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  // 계약(mdm-기준정보.json)의 servers 가 /api 다. 프리픽스를 바꾸면 전 경로가 어긋난다.
  const prefix = config.get<string>('API_PREFIX') ?? 'api';
  const corsOrigins = configureApp(app, prefix);

  // ⛔ 반사 문서는 «무엇이 떠 있는가»를 세는 데만 쓴다. 화면에 보이는 것은 계약 원본이다 —
  // DTO 가 평범한 interface 라 반사 문서에는 스키마가 0개다(실측). 자세한 근거는
  // `contract-document.ts` 머리말에 적었다.
  const reflected = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('OMF MES API').setVersion('0.1.0').build(),
  );
  const contract = buildContractDocument(
    servedOperations(reflected as unknown as { paths?: Record<string, Record<string, unknown>> }, prefix),
  );
  SwaggerModule.setup(`${prefix}/docs`, app, contract as never);

  // ConfigService 는 환경변수를 문자열로 돌려준다. 빈 문자열은 0, 잘못된 값은 NaN 이
  // 되는데 둘 다 포트로 쓰면 안 되므로 기본값으로 되돌린다.
  const port = Number(config.get('PORT')) || 3100;
  // ⛔ 호스트를 «명시로» 준다. 인자를 안 주면 Node 기본값에 기대게 되는데, 그 기본이
  //    루프백으로 바뀌면 LAN 접근이 조용히 끊긴다.
  await app.listen(port, '0.0.0.0');

  const { implemented, total } = contract['x-coverage'];
  // eslint-disable-next-line no-console
  console.log(
    `OMF MES API listening on http://localhost:${port}/${prefix} ` +
      `(docs: /${prefix}/docs — 계약 ${implemented}/${total} 구현)` +
      // 열려 있는지 «로그로» 알린다 — 안 그러면 왜 브라우저가 막히는지 찾기 어렵다.
      (corsOrigins.length === 0 ? ' · CORS 꺼짐' : ` · CORS ${corsOrigins.join(', ')}`),
  );
}

void bootstrap();

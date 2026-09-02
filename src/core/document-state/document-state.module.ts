import { Module } from '@nestjs/common';

import { DocumentStateService } from './document-state.service';

/**
 * ⛔ 팩토리로 만든다. 생성자가 전이표를 «기본값 인자»로 받는데(검사가 다른 표를 넣어
 * 돌리려고 그렇게 두었다), Nest 는 기본값을 모르고 0번 인자를 주입하려다 실패한다.
 * 클래스를 그대로 프로바이더로 두면 부팅이 「의존성을 풀 수 없다」로 죽는다.
 */
@Module({
  providers: [{ provide: DocumentStateService, useFactory: () => new DocumentStateService() }],
  exports: [DocumentStateService],
})
export class DocumentStateModule {}

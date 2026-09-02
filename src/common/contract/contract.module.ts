import { Global, Module, OnModuleInit } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { ContractRegistry } from './contract-registry';
import { ContractValidationGuard } from './contract-validation.guard';
import { ContractValidator } from './contract-validator';

/**
 * 계약 레지스트리·검증기를 한 벌 두고, 검증 가드를 전역으로 단다.
 *
 * `configureApp()` 이 아니라 모듈에 두는 이유 — 가드가 `Reflector` 와 검증기를 주입받아야
 * 하고, 전역 프로바이더로 두면 그 배선을 Nest 가 맡는다. 운영 부팅과 e2e 가 같은
 * `AppModule` 을 쓰므로 둘이 어긋날 자리는 그대로 없다.
 */
@Global()
@Module({
  providers: [
    { provide: ContractRegistry, useFactory: () => ContractRegistry.load() },
    {
      provide: ContractValidator,
      useFactory: (registry: ContractRegistry) => new ContractValidator(registry),
      inject: [ContractRegistry],
    },
    // ⛔ 인증 가드가 서면 «그것을 먼저» 등록한다. Nest 는 APP_GUARD 를 등록 순서대로
    // 돌리므로, 이 가드가 앞서면 인증 안 된 호출자가 401 대신 400 과 함께 계약 스키마의
    // 생김새를 돌려받는다.
    { provide: APP_GUARD, useClass: ContractValidationGuard },
  ],
  exports: [ContractRegistry, ContractValidator],
})
export class ContractModule implements OnModuleInit {
  constructor(private readonly validator: ContractValidator) {}

  /** 부팅 때 전건을 컴파일한다 — 스키마 결함을 첫 요청이 아니라 여기서 드러낸다. */
  onModuleInit(): void {
    this.validator.compileAll();
  }
}

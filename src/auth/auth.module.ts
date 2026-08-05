import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';

import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { JwtConfig, readJwtConfig } from './jwt.config';
import { PasswordService } from './password.service';
import { PrincipalService } from './principal.service';

@Module({
  imports: [
    // 비밀키는 모듈이 만들어질 때 읽는다 — 없거나 짧으면 여기서 기동이 실패한다.
    JwtModule.registerAsync({
      useFactory: () => ({ secret: readJwtConfig(process.env).secret }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    PasswordService,
    PrincipalService,
    AuthService,
    { provide: JwtConfig, useFactory: (): JwtConfig => readJwtConfig(process.env) },
    // 전역 가드. 화이트리스트라 @Public() 이 없는 모든 엔드포인트가 토큰을 요구한다.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [PasswordService],
})
export class AuthModule {}

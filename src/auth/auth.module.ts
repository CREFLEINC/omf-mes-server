import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtConfig, readJwtConfig } from './jwt.config';
import { PasswordService } from './password.service';

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
    AuthService,
    { provide: JwtConfig, useFactory: (): JwtConfig => readJwtConfig(process.env) },
  ],
  exports: [PasswordService],
})
export class AuthModule {}

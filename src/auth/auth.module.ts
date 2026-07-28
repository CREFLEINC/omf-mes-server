import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';

import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET');
        if (!secret || secret.length < 32) {
          // 기본값을 두지 않는다 — 약한 비밀키로 조용히 뜨는 것보다 못 뜨는 편이 낫다.
          throw new Error(
            'JWT_SECRET 환경변수가 없거나 32자 미만입니다. 배포 전에 반드시 설정하십시오.',
          );
        }
        return { secret };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    // 전역 가드 — @Public()이 없는 모든 엔드포인트가 인증을 요구한다.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService, PasswordService],
})
export class AuthModule {}

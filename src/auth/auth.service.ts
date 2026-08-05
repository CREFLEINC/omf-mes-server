import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { PrismaService } from '../prisma/prisma.service';
import { LoginDto, LoginResponseDto } from './auth.dto';
import { JwtConfig } from './jwt.config';
import { PasswordService } from './password.service';

/**
 * 없는 계정에도 실제 검증에 준하는 시간을 쓰기 위한 미끼 해시. 응답 시간 차이로
 * 「이 아이디는 존재한다」가 새면 계정 열거의 출발점이 된다.
 */
const DUMMY_PASSWORD = 'omf-mes-timing-equalizer';

export type JwtPayload = { sub: string; loginId: string };

@Injectable()
export class AuthService {
  private dummyHash?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
    private readonly config: JwtConfig,
  ) {}

  async login(dto: LoginDto): Promise<LoginResponseDto> {
    const user = await this.prisma.app_user.findUnique({
      where: { login_id: dto.loginId },
      include: { user_credential: true },
    });

    const credential = user?.user_credential;
    if (!user || !credential || !user.is_active) {
      await this.burnTime(dto.password);
      throw this.rejected();
    }

    if (!(await this.passwords.verify(dto.password, credential.password_hash))) {
      // 잠금은 아직 걸지 않는다(ADR 0002) — 세어만 둔다. 잠금을 붙일 때 이 값이 근거가 된다.
      await this.prisma.user_credential.update({
        where: { app_user_id: user.app_user_id },
        data: { failed_attempt_count: { increment: 1 } },
      });
      throw this.rejected();
    }

    await this.prisma.user_credential.update({
      where: { app_user_id: user.app_user_id },
      data: { failed_attempt_count: 0, last_login_at: new Date() },
    });

    const payload: JwtPayload = { sub: String(user.app_user_id), loginId: user.login_id };

    return {
      accessToken: await this.jwt.signAsync(payload, { expiresIn: this.config.expiresInSeconds }),
      expiresIn: this.config.expiresInSeconds,
      mustChangePassword: credential.must_change_password,
    };
  }

  /**
   * 없는 계정 · 자격증명 미발급 · 정지된 계정에서도 해시 검증만큼 시간을 쓴다.
   * 미끼 해시는 한 번만 만들어 재사용한다 — 매번 만들면 검증보다 오히려 느려진다.
   */
  private async burnTime(password: string): Promise<void> {
    this.dummyHash ??= await this.passwords.hash(DUMMY_PASSWORD);
    await this.passwords.verify(password, this.dummyHash);
  }

  /** 사유를 구분하지 않는다 — 없는 계정 · 틀린 비밀번호 · 정지가 모두 같은 응답이다. */
  private rejected(): UnauthorizedException {
    return new UnauthorizedException('로그인할 수 없습니다.');
  }
}

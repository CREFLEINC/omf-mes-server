import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { PrismaService } from '../prisma/prisma.service';
import { ChangePasswordDto, LoginDto } from './auth.dto';
import { PasswordService } from './password.service';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export interface AuthPrincipal {
  appUserId: bigint;
  loginId: string;
  userName: string;
  permissions: string[];
  mustChangePassword: boolean;
}

export interface LoginResult {
  accessToken: string;
  expiresIn: number;
  user: {
    loginId: string;
    userName: string;
    permissions: string[];
    mustChangePassword: boolean;
  };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 실패 사유(없는 계정 / 틀린 비밀번호 / 자격증명 미발급)를 구분해 알려주지 않는다 —
   * 계정 존재 여부가 새어나가면 열거 공격의 출발점이 된다. 잠금만 별도로 안내한다.
   */
  async login(dto: LoginDto): Promise<LoginResult> {
    const user = await this.prisma.app_user.findUnique({
      where: { login_id: dto.loginId },
      include: { user_credential: true },
    });

    const credential = user?.user_credential;
    if (!user || !credential) {
      // 계정이 없어도 해시 검증에 준하는 시간을 쓴다(타이밍으로 존재 여부가 드러나지 않게).
      await this.passwords.verify(dto.password, 'scrypt$32768$8$1$AAAA$AAAA');
      throw new UnauthorizedException('로그인 ID 또는 비밀번호가 올바르지 않습니다.');
    }

    if (credential.locked_until && credential.locked_until > new Date()) {
      throw new UnauthorizedException(
        `연속 실패로 잠긴 계정입니다. ${credential.locked_until.toISOString()} 이후 다시 시도하십시오.`,
      );
    }

    const ok = await this.passwords.verify(dto.password, credential.password_hash);
    if (!ok) {
      await this.registerFailure(user.app_user_id, credential.failed_attempt_count);
      throw new UnauthorizedException('로그인 ID 또는 비밀번호가 올바르지 않습니다.');
    }

    if (!user.is_active || user.status_code !== 'ACTIVE') {
      throw new UnauthorizedException('사용할 수 없는 계정입니다. 관리자에게 문의하십시오.');
    }

    await this.prisma.user_credential.update({
      where: { app_user_id: user.app_user_id },
      data: { failed_attempt_count: 0, locked_until: null, last_login_at: new Date() },
    });

    const permissions = await this.loadPermissions(user.app_user_id);
    const expiresIn = this.config.get<number>('JWT_EXPIRES_IN_SECONDS', 8 * 60 * 60);
    const accessToken = await this.jwt.signAsync(
      { sub: user.app_user_id.toString(), loginId: user.login_id },
      { expiresIn },
    );

    return {
      accessToken,
      expiresIn,
      user: {
        loginId: user.login_id,
        userName: user.user_name,
        permissions,
        mustChangePassword: credential.must_change_password,
      },
    };
  }

  /** 토큰의 주체를 매 요청마다 다시 확인한다 — 토큰 발급 뒤 계정이 막혔을 수 있다. */
  async resolvePrincipal(appUserId: bigint): Promise<AuthPrincipal> {
    const user = await this.prisma.app_user.findUnique({
      where: { app_user_id: appUserId },
      include: { user_credential: true },
    });

    if (!user || !user.is_active || user.status_code !== 'ACTIVE') {
      throw new UnauthorizedException('사용할 수 없는 계정입니다.');
    }

    return {
      appUserId: user.app_user_id,
      loginId: user.login_id,
      userName: user.user_name,
      permissions: await this.loadPermissions(user.app_user_id),
      mustChangePassword: user.user_credential?.must_change_password ?? false,
    };
  }

  async changePassword(appUserId: bigint, dto: ChangePasswordDto): Promise<void> {
    const credential = await this.prisma.user_credential.findUnique({
      where: { app_user_id: appUserId },
    });
    if (!credential) {
      throw new BadRequestException('자격증명이 발급되지 않은 계정입니다.');
    }

    const ok = await this.passwords.verify(dto.currentPassword, credential.password_hash);
    if (!ok) {
      throw new UnauthorizedException('현재 비밀번호가 올바르지 않습니다.');
    }
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('새 비밀번호가 현재 비밀번호와 같습니다.');
    }

    await this.prisma.user_credential.update({
      where: { app_user_id: appUserId },
      data: {
        password_hash: await this.passwords.hash(dto.newPassword),
        password_changed_at: new Date(),
        must_change_password: false,
        failed_attempt_count: 0,
        locked_until: null,
        updated_by: appUserId,
        version_no: { increment: 1 },
      },
    });
  }

  /** 관리자가 아는 값이므로 다음 로그인에서 변경을 강제한다. */
  async setPassword(targetUserId: bigint, plain: string, actor?: bigint): Promise<void> {
    const hash = await this.passwords.hash(plain);

    await this.prisma.user_credential.upsert({
      where: { app_user_id: targetUserId },
      update: {
        password_hash: hash,
        password_changed_at: new Date(),
        must_change_password: true,
        failed_attempt_count: 0,
        locked_until: null,
        updated_by: actor,
        version_no: { increment: 1 },
      },
      create: {
        app_user_id: targetUserId,
        password_hash: hash,
        must_change_password: true,
        created_by: actor,
        updated_by: actor,
      },
    });
  }

  private async loadPermissions(appUserId: bigint): Promise<string[]> {
    const rows = await this.prisma.role_permission.findMany({
      where: {
        role: { is_active: true, user_role: { some: { app_user_id: appUserId } } },
      },
      select: { permission_code: true },
      distinct: ['permission_code'],
      orderBy: { permission_code: 'asc' },
    });
    return rows.map((r) => r.permission_code);
  }

  private async registerFailure(appUserId: bigint, current: number): Promise<void> {
    const next = current + 1;
    const shouldLock = next >= MAX_FAILED_ATTEMPTS;

    await this.prisma.user_credential.update({
      where: { app_user_id: appUserId },
      data: {
        failed_attempt_count: shouldLock ? 0 : next,
        locked_until: shouldLock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
      },
    });

    if (shouldLock) {
      this.logger.warn(`연속 로그인 실패로 계정을 잠금: app_user_id=${appUserId}`);
    }
  }
}

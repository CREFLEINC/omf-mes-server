import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    app_user: Record<string, jest.Mock>;
    user_credential: Record<string, jest.Mock>;
    role_permission: Record<string, jest.Mock>;
  };
  const passwords = { verify: jest.fn(), hash: jest.fn() };
  const jwt = { signAsync: jest.fn() };

  const activeUser = {
    app_user_id: 1n,
    login_id: 'admin',
    user_name: '관리자',
    is_active: true,
    status_code: 'ACTIVE',
    user_credential: {
      password_hash: 'scrypt$32768$8$1$c2FsdA==$aGFzaA==',
      failed_attempt_count: 0,
      locked_until: null,
      must_change_password: false,
    },
  };

  beforeEach(async () => {
    passwords.verify.mockResolvedValue(true);
    passwords.hash.mockResolvedValue('hashed');
    jwt.signAsync.mockResolvedValue('token');
    prisma = {
      app_user: { findUnique: jest.fn() },
      user_credential: { findUnique: jest.fn(), update: jest.fn(), upsert: jest.fn() },
      role_permission: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: PasswordService, useValue: passwords },
        { provide: JwtService, useValue: jwt },
        { provide: ConfigService, useValue: { get: (_k: string, d: unknown) => d } },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  describe('로그인', () => {
    it('성공하면 토큰과 유효권한을 준다', async () => {
      prisma.app_user.findUnique.mockResolvedValue(activeUser);
      prisma.role_permission.findMany.mockResolvedValue([{ permission_code: 'MASTER_READ' }]);

      const result = await service.login({ loginId: 'admin', password: 'pw' });

      expect(result.accessToken).toBe('token');
      expect(result.user.permissions).toEqual(['MASTER_READ']);
    });

    // 계정 존재 여부가 새어나가면 열거 공격의 출발점이 된다.
    it('없는 계정과 틀린 비밀번호의 메시지가 같다', async () => {
      prisma.app_user.findUnique.mockResolvedValue(null);
      const noAccount = await service
        .login({ loginId: 'nobody', password: 'pw' })
        .catch((e: Error) => e.message);

      prisma.app_user.findUnique.mockResolvedValue(activeUser);
      passwords.verify.mockResolvedValue(false);
      const wrongPw = await service
        .login({ loginId: 'admin', password: 'bad' })
        .catch((e: Error) => e.message);

      expect(noAccount).toBe(wrongPw);
    });

    it('없는 계정도 해시 검증에 준하는 시간을 쓴다 — 타이밍으로 존재가 드러나지 않게', async () => {
      prisma.app_user.findUnique.mockResolvedValue(null);

      await expect(service.login({ loginId: 'nobody', password: 'pw' })).rejects.toThrow(
        UnauthorizedException,
      );
      expect(passwords.verify).toHaveBeenCalled();
    });

    it('잠긴 계정은 비밀번호가 맞아도 거부한다', async () => {
      prisma.app_user.findUnique.mockResolvedValue({
        ...activeUser,
        user_credential: {
          ...activeUser.user_credential,
          locked_until: new Date(Date.now() + 60_000),
        },
      });

      await expect(service.login({ loginId: 'admin', password: 'pw' })).rejects.toThrow(
        /잠긴 계정/,
      );
    });

    it('비활성·정지 계정은 비밀번호가 맞아도 거부한다', async () => {
      prisma.app_user.findUnique.mockResolvedValue({ ...activeUser, status_code: 'SUSPENDED' });

      await expect(service.login({ loginId: 'admin', password: 'pw' })).rejects.toThrow(
        /사용할 수 없는 계정/,
      );
    });

    it('5회째 실패에서 계정을 잠근다', async () => {
      prisma.app_user.findUnique.mockResolvedValue({
        ...activeUser,
        user_credential: { ...activeUser.user_credential, failed_attempt_count: 4 },
      });
      passwords.verify.mockResolvedValue(false);

      await expect(service.login({ loginId: 'admin', password: 'bad' })).rejects.toThrow();

      expect(prisma.user_credential.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ locked_until: expect.any(Date) }),
        }),
      );
    });

    it('성공하면 실패 횟수와 잠금을 초기화한다', async () => {
      prisma.app_user.findUnique.mockResolvedValue(activeUser);

      await service.login({ loginId: 'admin', password: 'pw' });

      expect(prisma.user_credential.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ failed_attempt_count: 0, locked_until: null }),
        }),
      );
    });
  });

  describe('resolvePrincipal', () => {
    // 토큰 발급 뒤 계정이 정지될 수 있어 매 요청 확인한다.
    it('정지된 계정이면 401', async () => {
      prisma.app_user.findUnique.mockResolvedValue({ ...activeUser, is_active: false });

      await expect(service.resolvePrincipal(1n)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('비밀번호 변경', () => {
    it('현재 비밀번호가 틀리면 401', async () => {
      prisma.user_credential.findUnique.mockResolvedValue(activeUser.user_credential);
      passwords.verify.mockResolvedValue(false);

      await expect(
        service.changePassword(1n, { currentPassword: 'bad', newPassword: 'new-password-1' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('새 비밀번호가 현재와 같으면 400', async () => {
      prisma.user_credential.findUnique.mockResolvedValue(activeUser.user_credential);

      await expect(
        service.changePassword(1n, { currentPassword: 'same-pw-1234', newPassword: 'same-pw-1234' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('성공하면 변경 강제 플래그를 내리고 잠금을 푼다', async () => {
      prisma.user_credential.findUnique.mockResolvedValue(activeUser.user_credential);

      await service.changePassword(1n, { currentPassword: 'old', newPassword: 'new-password-1' });

      expect(prisma.user_credential.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            must_change_password: false,
            failed_attempt_count: 0,
            locked_until: null,
          }),
        }),
      );
    });
  });

  describe('관리자 비밀번호 발급', () => {
    it('발급분은 다음 로그인에서 변경을 강제한다', async () => {
      await service.setPassword(2n, 'issued-password-1', 1n);

      const arg = prisma.user_credential.upsert.mock.calls[0][0];
      expect(arg.update).toEqual(expect.objectContaining({ must_change_password: true }));
      expect(arg.create).toEqual(expect.objectContaining({ must_change_password: true }));
    });
  });
});

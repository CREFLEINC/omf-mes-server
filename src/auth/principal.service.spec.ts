import { PrismaService } from '../prisma/prisma.service';
import { PrincipalService } from './principal.service';

function build(user: unknown) {
  const prisma = {
    app_user: { findUnique: jest.fn().mockResolvedValue(user) },
  } as unknown as PrismaService;

  return new PrincipalService(prisma);
}

function role(isActive: boolean, ...permissions: string[]) {
  return {
    role: {
      is_active: isActive,
      role_permission: permissions.map((permission_code) => ({ permission_code })),
    },
  };
}

const BASE = { app_user_id: 7n, login_id: 'admin', is_active: true };

describe('PrincipalService.load', () => {
  it('계정이 없으면 null 이다', async () => {
    await expect(build(null).load(7n)).resolves.toBeNull();
  });

  it('정지된 계정이면 null 이다 — 토큰이 유효해도 막는다', async () => {
    await expect(build({ ...BASE, is_active: false, user_role: [] }).load(7n)).resolves.toBeNull();
  });

  it('역할이 없으면 권한이 비어 있다', async () => {
    const principal = await build({ ...BASE, user_role: [] }).load(7n);

    expect(principal?.permissions.size).toBe(0);
  });

  it('여러 역할의 권한이 합쳐진다', async () => {
    const principal = await build({
      ...BASE,
      user_role: [role(true, 'MASTER_READ'), role(true, 'MASTER_LOGISTICS_WRITE')],
    }).load(7n);

    expect([...(principal?.permissions ?? [])].sort()).toEqual([
      'MASTER_LOGISTICS_WRITE',
      'MASTER_READ',
    ]);
  });

  it('겹치는 권한을 중복해 담지 않는다', async () => {
    const principal = await build({
      ...BASE,
      user_role: [role(true, 'MASTER_READ'), role(true, 'MASTER_READ')],
    }).load(7n);

    expect(principal?.permissions.size).toBe(1);
  });

  it('사용 중지된 역할의 권한은 세지 않는다 — 중지가 아무 일도 안 한 것이 된다', async () => {
    const principal = await build({
      ...BASE,
      user_role: [role(false, 'MASTER_LOGISTICS_WRITE'), role(true, 'MASTER_READ')],
    }).load(7n);

    expect([...(principal?.permissions ?? [])]).toEqual(['MASTER_READ']);
  });
});

import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { PERMISSION_CODES } from '../../common/permissions';
import { PrismaService } from '../../prisma/prisma.service';
import { assertAdminRemains } from './last-admin';

/** 계약 `RolePermission` 과 동형. */
interface RolePermissionView {
  rolePermissionId: number;
  roleId: number;
  permissionCode: string;
}

@Injectable()
export class RolePermissionService {
  constructor(private readonly prisma: PrismaService) {}

  async list(roleId: number): Promise<RolePermissionView[]> {
    await this.assertRole(roleId);
    return this.read(roleId);
  }

  /**
   * 「개별 부여·회수가 아니라 최종 상태를 통째로 보낸다」(계약 · 공유계약 `B-6`).
   *
   * ⛔ 없는 권한 코드를 받지 않는다. 계약이 그 이유를 적었다 — 「없는 코드를 만들면 그것을
   * 검사하는 자리가 없어 «아무 효과 없는 권한»이 된다」. 어휘는 앱이 소유한 117건이고
   * 공통코드가 아니므로 DB 가 아니라 상수(`PERMISSION_CODES`)로 가른다.
   *
   * ⛔ 치환 뒤에 관리자를 센다 — 이 저장이 관리 권한을 빼면 되돌릴 사람이 없어진다.
   *
   * ⚠ 계약이 이 자리에 `If-Match` 를 선언하지 않았다. 같은 「통째로 교체」인
   * `PUT /mdm/partners/{partnerId}/roles` 에는 선언돼 있다 — 되돌림 §Q 에 적었다.
   * 서버가 계약에 없는 헤더를 요구할 수는 없어 계약대로 간다.
   */
  async replace(
    roleId: number,
    permissionCodes: string[],
    appUserId?: number,
  ): Promise<RolePermissionView[]> {
    await this.assertRole(roleId);
    assertKnown(permissionCodes);
    // 부여는 집합이다 — 중복은 오류가 아니라 같은 뜻이라 접어서 받는다(`uq_role_permission`).
    const unique = [...new Set(permissionCodes)];

    await this.prisma.$transaction(async (tx) => {
      await tx.role_permission.deleteMany({ where: { role_id: roleId } });
      if (unique.length > 0) {
        await tx.role_permission.createMany({
          data: unique.map((permissionCode) => ({
            role_id: roleId,
            permission_code: permissionCode,
            ...(appUserId === undefined ? {} : { created_by: appUserId }),
          })),
        });
      }
      await assertAdminRemains(tx);
    });

    return this.read(roleId);
  }

  private async read(roleId: number): Promise<RolePermissionView[]> {
    const rows = await this.prisma.role_permission.findMany({
      where: { role_id: roleId },
      orderBy: { permission_code: 'asc' },
    });
    return rows.map((row) => ({
      rolePermissionId: Number(row.role_permission_id),
      roleId: Number(row.role_id),
      permissionCode: row.permission_code,
    }));
  }

  private async assertRole(roleId: number): Promise<void> {
    const row = await this.prisma.role.findUnique({
      where: { role_id: roleId },
      select: { role_id: true },
    });
    if (!row) throw new NotFoundException('없는 역할입니다.');
  }
}

/** 어휘 밖 코드는 어느 자리에서 왔는지 짚어 준다 — 격자가 그 열을 표시한다. */
function assertKnown(permissionCodes: string[]): void {
  const errors: ErrorItem[] = permissionCodes.flatMap((code, index) =>
    PERMISSION_CODES.has(code)
      ? []
      : [
          {
            scope: 'field' as const,
            field: `permissionCodes[${index}]`,
            code: ERROR_CODE.INVALID,
            message: '없는 기능 권한입니다.',
          },
        ],
  );
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

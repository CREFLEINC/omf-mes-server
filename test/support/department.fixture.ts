import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * 접두사가 붙은 부서만 지운다.
 *
 * 부서는 자기참조 계층이라 자식이 부모를 가리킨다. 깊이를 모르는 채 지우려면 순서를
 * 맞춰야 하는데, **부모 연결을 먼저 끊으면 깊이와 무관하게 한 번에 지워진다.**
 *
 * `parent_department_id IS NOT NULL` 로 지우면 안 된다 — 접두사와 무관하게 **남이 만든
 * 부서까지 지운다.** 지금은 테이블이 비어 있어 티가 안 나지만, 공용 개발 DB 에 실제
 * 조직이 들어 있으면 계층이 있는 부서가 전부 사라진다.
 */
export async function deleteDepartments(prisma: PrismaService, prefix: string): Promise<void> {
  const where = { department_code: { startsWith: prefix } };

  await prisma.department.updateMany({ where, data: { parent_department_id: null } });
  await prisma.department.deleteMany({ where });
}

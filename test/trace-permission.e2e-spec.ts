/**
 * 피처 015 권한 승계(omf-all-around#355 · FR-019) — 마이그레이션 `20261124130000_lot_trace_split` 이 W-02-09(LOT 생산 이력 조회)를
 * 가진 역할에 W-02-13(자재 기준 생산 추적)·W-02-14(제품 기준 역추적)를 준다. 시험 DB 는 이미 그 마이그레이션을 지났으므로
 * 역할을 만든 뒤 같은 INSERT 를 다시 돌려 본다(ON CONFLICT 라 몇 번 돌아도 같다).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';

import { PERMISSION_CODES } from '../src/common/permissions/permissions';

const PREFIX = 'TPME2E';
const MIGRATION = join(__dirname, '../prisma/migrations/20261124130000_lot_trace_split/migration.sql');

/** 마이그레이션 파일에서 역할 권한 INSERT 문만 꺼낸다 — 인덱스 만들기는 다시 돌릴 수 없다. */
function grantStatement(): string {
  const statements = readFileSync(MIGRATION, 'utf8')
    .split(';')
    .map((part) => part.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim())
    .filter((part) => part.startsWith('INSERT INTO app.role_permission'));
  expect(statements).toHaveLength(1);
  return statements[0];
}

describe('피처 015 권한 승계 (e2e)', () => {
  const prisma = new PrismaClient();
  const roles: Record<string, bigint> = {};

  async function cleanup(): Promise<void> {
    const found = await prisma.role.findMany({ where: { role_code: { startsWith: PREFIX } }, select: { role_id: true } });
    const ids = found.map((role) => role.role_id);
    await prisma.role_permission.deleteMany({ where: { role_id: { in: ids } } });
    await prisma.role.deleteMany({ where: { role_id: { in: ids } } });
  }

  async function role(suffix: string, permissions: string[]): Promise<bigint> {
    const created = await prisma.role.create({ data: { role_code: `${PREFIX}-${suffix}`, role_name: `${PREFIX}-${suffix}` } });
    await prisma.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: created.role_id, permission_code })) });
    return created.role_id;
  }

  async function codesOf(roleId: bigint): Promise<string[]> {
    const rows = await prisma.role_permission.findMany({ where: { role_id: roleId }, select: { permission_code: true } });
    return rows.map((row) => row.permission_code).sort();
  }

  beforeAll(async () => {
    await cleanup();
    roles.legacy = await role('LEGACY', ['W-02-09']);
    roles.partial = await role('PARTIAL', ['W-02-09', 'W-02-13']);
    roles.other = await role('OTHER', ['W-02-08']);
    await prisma.$executeRawUnsafe(grantStatement());
    // 두 번 돌아도 같다 — 배포가 다시 돌거나 시드가 먼저 준 역할도 겹치지 않는다.
    await prisma.$executeRawUnsafe(grantStatement());
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('Q22 FR-019 W-02-09 만 가진 역할이 W-02-13·W-02-14 를 받고 W-02-09 는 남는다', async () => {
    expect(await codesOf(roles.legacy)).toEqual(['W-02-09', 'W-02-13', 'W-02-14']);
    expect(await codesOf(roles.partial)).toEqual(['W-02-09', 'W-02-13', 'W-02-14']);
  });

  it('Q22 W-02-09 가 없던 역할은 그대로다', async () => {
    expect(await codesOf(roles.other)).toEqual(['W-02-08']);
  });

  it('Q22 새 권한 코드 둘이 기능 권한 목록에 있다 — 역할 관리 화면이 고를 수 있다', () => {
    expect(PERMISSION_CODES.has('W-02-13')).toBe(true);
    expect(PERMISSION_CODES.has('W-02-14')).toBe(true);
  });

  it('공급사 LOT 번호 찾기 인덱스가 있다(R-5)', async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'trace' AND indexname = 'ix_lot_external_identifier_value'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain('(identifier_type_code, external_identifier)');
  });
});

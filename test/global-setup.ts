import { PrismaClient } from '@prisma/client';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * e2e 가 도는 DB 의 전제를 **먼저** 확인한다.
 *
 * ⛔ 없어서 한 번에 175건이 깨졌다. 원인은 둘이었고 둘 다 «증상이 원인을 가렸다» —
 *   미적용 마이그레이션은 「The column `target_code` does not exist」로, 없는 조직 행은
 *   「No record was found」로 나온다. 어느 쪽도 「DB 를 세워라」로는 읽히지 않아서
 *   깨진 검사를 하나씩 파고들게 만든다.
 *
 * 두 전제 모두 «검사 밖»에 있다. 스위트가 만들지 않고 있다고 «전제»한다.
 */
export default async function globalSetup(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await assertMigrationsApplied(prisma);
    await assertSeeded(prisma);
    await ensureOrganization(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * ⚠ 적용하지 «않는다» — 확인만 하고 무엇이 밀렸는지 이름으로 알린다.
 * 검사를 돌린 부작용으로 스키마가 바뀌면 그게 더 놀랍다.
 */
async function assertMigrationsApplied(prisma: PrismaClient): Promise<void> {
  const onDisk = readdirSync(join(__dirname, '..', 'prisma', 'migrations'), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const applied = await prisma.$queryRaw<{ migration_name: string }[]>`
    SELECT migration_name FROM _prisma_migrations
     WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  const done = new Set(applied.map((row) => row.migration_name));

  const pending = onDisk.filter((name) => !done.has(name));
  if (pending.length === 0) return;

  throw new Error(
    `이 DB 에 아직 적용되지 않은 마이그레이션이 ${pending.length}건 있습니다.\n` +
      `  ${pending.join('\n  ')}\n` +
      `먼저 실행하세요: pnpm exec prisma migrate deploy`,
  );
}

/**
 * 코드 어휘·단위·역할. `prisma/seed.ts` 가 넣는 «배포 시드»다.
 *
 * ⚠ 마이그레이션과 같은 취급 — 확인만 하고 넣지 «않는다». 시드는 코드 어휘를 통째로
 *   다시 쓰므로 검사를 돌린 부작용으로 도는 것이 아니라 사람이 부르는 것이어야 한다.
 */
async function assertSeeded(prisma: PrismaClient): Promise<void> {
  const missing = (
    await Promise.all([
      empty('uom', prisma.uom.count()),
      empty('code_group', prisma.code_group.count()),
      empty('entity_type_registry', prisma.entity_type_registry.count()),
      empty('role', prisma.role.count()),
    ])
  ).filter((name): name is string => name !== null);
  if (missing.length === 0) return;

  throw new Error(
    `이 DB 에 배포 시드가 들어 있지 않습니다 — 빈 표: ${missing.join(', ')}\n` +
      `먼저 실행하세요: pnpm db:seed`,
  );
}

async function empty(name: string, counting: Promise<number>): Promise<string | null> {
  return (await counting) === 0 ? name : null;
}

/**
 * 법인·사업부·공장. 마이그레이션도 `prisma/seed.ts` 도 만들지 않는다 — 코드 어휘와
 * 달리 «고객 데이터»라 배포 시드에 넣을 것이 아니다. 그래서 검사용으로 여기서 채운다.
 *
 * ⚠ 사업부는 **둘**이 필요하다. 품목의 사업부 매핑이 「보내는 곳 ≠ 받는 곳」을
 *   요구해서(`ck_item_bu_map_distinct`) 하나뿐이면 그 스위트가 못 선다.
 *
 * 모자란 것만 채운다 — 이미 세워 둔 DB 에 같은 행을 또 넣지 않는다.
 */
async function ensureOrganization(prisma: PrismaClient): Promise<void> {
  const legalEntity =
    (await prisma.legal_entity.findFirst({ orderBy: { legal_entity_id: 'asc' } })) ??
    (await prisma.legal_entity.create({
      data: {
        legal_entity_code: 'E2E-LE',
        legal_entity_name: 'e2e 법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    }));

  const businessUnits = await prisma.business_unit.count();
  for (let index = businessUnits; index < 2; index += 1) {
    await prisma.business_unit.create({
      data: {
        business_unit_code: `E2E-BU${index + 1}`,
        business_unit_name: `e2e 사업부 ${index + 1}`,
        legal_entity_id: legalEntity.legal_entity_id,
      },
    });
  }

  if ((await prisma.plant.count()) === 0) {
    const businessUnit = await prisma.business_unit.findFirstOrThrow({
      orderBy: { business_unit_id: 'asc' },
    });
    await prisma.plant.create({
      data: {
        plant_code: 'E2E-P',
        plant_name: 'e2e 공장',
        legal_entity_id: legalEntity.legal_entity_id,
        business_unit_id: businessUnit.business_unit_id,
        // 현장은 하노이다. 서버·DB 는 UTC 고정이고 공장 로컬은 이 값으로만 푼다.
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
  }
}

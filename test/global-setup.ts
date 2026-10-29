import { PrismaClient } from '@prisma/client';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { WORKER_DB_BASE, workerDatabaseUrl } from './worker-db';

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
export default async function globalSetup(globalConfig: { maxWorkers: number }): Promise<void> {
  disableErpSync();
  const prisma = new PrismaClient();
  try {
    await assertMigrationsApplied(prisma);
    await assertSeeded(prisma);
    await ensureOrganization(prisma);
  } finally {
    await prisma.$disconnect();
  }
  if (globalConfig.maxWorkers > 1) await cloneWorkerDatabases(globalConfig.maxWorkers);
}

/**
 * 일꾼마다 자기 DB 를 쓴다 — 스위트가 서로의 흔적을 지우므로(`alphabetical-sequencer.js`) 한 DB 를 나눠 쓰면
 * 동시에 돌릴 수 없다. 위에서 확인한 DB 를 원본으로 일꾼 수만큼 복사하고, 원본은 건드리지 않는다 —
 * 그래서 다음 실행도 깨끗한 복사본에서 시작한다. 한 줄로(`--runInBand`) 돌리면 지금처럼 원본에서 돈다.
 */
async function cloneWorkerDatabases(workers: number): Promise<void> {
  const base = process.env.DATABASE_URL as string;
  const source = new URL(base).pathname.slice(1);
  // CREATE DATABASE … TEMPLATE 은 원본에 붙은 연결이 하나도 없어야 한다 — 다른 DB 에 붙어 명령한다.
  const admin = new URL(base);
  admin.pathname = '/postgres';
  const prisma = new PrismaClient({ datasourceUrl: admin.toString() });
  try {
    for (let worker = 1; worker <= workers; worker += 1) {
      const target = new URL(workerDatabaseUrl(base, String(worker))).pathname.slice(1);
      await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`);
      await prisma.$executeRawUnsafe(`CREATE DATABASE "${target}" TEMPLATE "${source}"`);
    }
  } finally {
    await prisma.$disconnect();
  }
  for (let worker = 1; worker <= workers; worker += 1) await spreadSequences(workerDatabaseUrl(base, String(worker)));
  process.env[WORKER_DB_BASE] = base;
}

/**
 * 순번마다 천씩 띄운다(10만부터) — 갓 복사한 DB 는 모든 표의 id 가 1 부터 시작해 「서로 다른 표의 id 는 다르다」를
 * 기대는 단언(출처가 뒤바뀌면 잡으려고 값을 다르게 둔 자리)이 우연히 같은 값으로 깨진다. 한 DB 를 같이 쓸 때는 앞
 * 스위트가 id 를 먼저 써서 가려져 있었다. ⛔ 백만을 넘기지 않는다 — LOT 번호가 공장 id 를 여섯 자리로 싣는다.
 * 10만부터인 것은 검사가 「없는 id」로 쓰는 9999·99999 를 피하려는 것이다(999999 는 위로 피한다).
 */
async function spreadSequences(url: string): Promise<void> {
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    await prisma.$executeRawUnsafe(`
      DO $$
      DECLARE seq regclass; n int := 0;
      BEGIN
        FOR seq IN SELECT c.oid::regclass FROM pg_class c WHERE c.relkind = 'S' ORDER BY c.relnamespace, c.relname LOOP
          n := n + 1;
          PERFORM setval(seq, 100000 + n * 1000 + coalesce(pg_sequence_last_value(seq), 0));
        END LOOP;
      END $$`);
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * ⛔ e2e 가 띄우는 서버에서는 ERP 연동 실행기를 늘 끈다. 개발 서버용 `.env` 에 `ERP_SYNC_ENABLED=true` 가 있으면
 * 검사마다 실행기가 떠서 중계 DB 의 미반영 행을 시험 DB 로 읽어 가고 「읽음」으로 표시한다 — 개발 서버가 받을 행이 빠진다.
 * 프로세스 환경이 `.env` 보다 앞서므로(`ConfigModule`) 여기서 덮으면 된다. 실행기를 직접 만드는 중계 DB e2e
 * (`ERP_RELAY_E2E=1`)는 이 값을 읽지 않는다.
 */
function disableErpSync(): void {
  process.env.ERP_SYNC_ENABLED = 'false';
  // 보내기도 끈다 — 켜 두면 검사가 마감한 W/O 의 실적을 개발용 중계 DB 에 넣는다.
  process.env.ERP_SEND_ENABLED = 'false';
  // Zalo 발송 러너도 같은 이유로 끈다 — 켜 두면 검사가 만든 발송 대기 건을 실제 Zalo 로 보낸다.
  // 러너 검사는 러너를 직접 만들어 tick 을 부른다(omf-all-around#160).
  process.env.ZALO_DELIVERY_ENABLED = 'false';
  // 연결 정보 저장(W-CO-12)은 암호화 키가 있어야 한다 — 검사용 고정 키(운영 값이 아니다).
  process.env.ZALO_CREDENTIAL_KEY ||= Buffer.alloc(32, 7).toString('base64');
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

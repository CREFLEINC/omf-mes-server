/**
 * ERP 중계 DB e2e 의 공통 준비 — 원본 표와 같은 모양의 사본 표를 만들어 거기서 돈다.
 * 원본(실데이터)을 건드리지 않으려는 것이다. 표를 만드는 권한이 앱 계정에 없어 sa 로 만든다.
 *
 * ⭐ `ERP_RELAY_E2E=1` 일 때만 돈다 — 중계 DB 가 없는 곳에서 «몰래 통과»하지 않고 «건너뜀»으로
 * 보이게 한다. 로컬 중계 DB 는 erp-mock 저장소의 docker/ 로 띄운다.
 */
import * as mssql from 'mssql';

import { RelayConfig } from '../src/integration/erp/relay-client';
import { PrismaService } from '../src/prisma/prisma.service';

export const RELAY: RelayConfig = {
  host: process.env.ERP_E2E_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.ERP_E2E_DB_PORT ?? 1433),
  user: 'mes-system',
  password: process.env.ERP_E2E_DB_PASSWORD ?? 'LocalDev!2026',
  database: 'sample_mes',
  encrypt: true,
};

export const describeRelay = process.env.ERP_RELAY_E2E === '1' ? describe : describe.skip;

export async function connectSa(): Promise<mssql.ConnectionPool> {
  return new mssql.ConnectionPool({
    server: RELAY.host,
    port: RELAY.port,
    user: 'sa',
    password: process.env.ERP_E2E_SA_PASSWORD ?? 'LocalDev!2026',
    database: RELAY.database,
    options: { encrypt: true, trustServerCertificate: true },
  }).connect();
}

/** 원본과 같은 칸·IDENTITY 를 가진 빈 사본. 있으면 지우고 다시 만든다. */
export async function createCopy(
  sa: mssql.ConnectionPool,
  copy: string,
  original: string,
): Promise<void> {
  await sa
    .request()
    .query(
      `IF OBJECT_ID('dbo.${copy}') IS NOT NULL DROP TABLE dbo.${copy}; ` +
        `SELECT TOP 0 * INTO dbo.${copy} FROM dbo.${original};`,
    );
}

export async function dropCopy(sa: mssql.ConnectionPool | undefined, copy: string): Promise<void> {
  await sa?.request().query(`IF OBJECT_ID('dbo.${copy}') IS NOT NULL DROP TABLE dbo.${copy}`);
}

/** 칸 이름 → 값. 값의 타입은 mssql 이 고른다(문자열은 nvarchar). */
export async function insertRow(
  sa: mssql.ConnectionPool,
  copy: string,
  values: Record<string, unknown>,
): Promise<void> {
  const request = sa.request();
  const columns = Object.keys(values);
  columns.forEach((column, index) => request.input(`v${index}`, values[column]));
  await request.query(
    `INSERT INTO dbo.${copy} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `@v${i}`).join(', ')})`,
  );
}

export async function flagsOf(
  sa: mssql.ConnectionPool,
  copy: string,
  key: string,
  flag: string,
): Promise<Record<string, string>> {
  const result = await sa
    .request()
    .query<Record<string, string>>(`SELECT ${key} AS k, ${flag} AS f FROM dbo.${copy}`);
  return Object.fromEntries(result.recordset.map((r) => [r.k, r.f]));
}

/**
 * 공장 코드가 없으면 첫 사업부 밑에 만든다. 만든 것만 `created` 에 담는다 — 끝나면 그것만 지운다.
 * 운영 DB 에는 PL11·PL13 이 미리 있어야 한다(`deploy/seed/mes-initial-data.sql`).
 */
export async function ensurePlant(
  prisma: PrismaService,
  code: string,
  created: bigint[],
): Promise<void> {
  if ((await prisma.plant.count({ where: { plant_code: code } })) > 0) return;
  const businessUnit = await prisma.business_unit.findFirstOrThrow({
    orderBy: { business_unit_id: 'asc' },
  });
  const plant = await prisma.plant.create({
    data: {
      plant_code: code,
      plant_name: `e2e ${code}`,
      legal_entity_id: businessUnit.legal_entity_id,
      business_unit_id: businessUnit.business_unit_id,
      timezone_code: 'Asia/Ho_Chi_Minh',
    },
  });
  created.push(plant.plant_id);
}

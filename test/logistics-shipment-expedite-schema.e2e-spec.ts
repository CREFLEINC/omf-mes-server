import { PrismaClient } from '@prisma/client';

/**
 * I-23 마이그 ⓐ 의 물리 불변식 — 행을 «세우지 않고» 칸·제약·인덱스만 본다.
 *
 * ⭐ 이 PR 은 칸을 세우는 PR 이라 지나는 코드가 채번 한 줄뿐이다. 그래서 「자기 칸을
 * 지나는 시험 0」이 되기 쉽고, I-13 R-15 가 그것을 금지했다. 출하 본길 e2e 는 PR ④ 에
 * 오므로 그때까지 이 파일이 칸을 지킨다.
 *
 * ⛔ 픽스처 사슬(법인→사업장→공장→창고→출하지시서→수주)을 타지 않는다 — 여기서 보는
 * 것은 「행이 어떻게 거부되나」가 아니라 「칸·제약·인덱스가 선언대로 섰나」다.
 */
interface ColumnRow {
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

describe('I-23 출하 긴급 직행 · 재등록 연결 칸의 물리 (e2e)', () => {
  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function column(table: string, name: string): Promise<ColumnRow | undefined> {
    const rows = await prisma.$queryRaw<ColumnRow[]>`
      SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'logistics' AND table_name = ${table} AND column_name = ${name}`;
    return rows[0];
  }

  it('shipment.expedited 은 boolean NOT NULL DEFAULT false 다', async () => {
    // DEFAULT 가 없으면 기존 행 0건이어도 다음 릴리스의 INSERT 가 전부 깨진다(계약 default false).
    expect(await column('shipment', 'expedited')).toEqual({
      data_type: 'boolean',
      is_nullable: 'NO',
      column_default: 'false',
    });
  });

  it('shipment.expedite_reason 은 text nullable 이다 — VarChar 가 아니다', async () => {
    // ⛔ 계약에 maxLength 가 없다. VarChar(n) 로 좁히면 n 자를 넘는 사유가 500 이 된다.
    expect(await column('shipment', 'expedite_reason')).toEqual({
      data_type: 'text',
      is_nullable: 'YES',
      column_default: null,
    });
  });

  it('ck_shipment_expedite 이 짝 불변식을 «DB 에서» 본다', async () => {
    const [found] = await prisma.$queryRaw<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'logistics.shipment'::regclass AND conname = 'ck_shipment_expedite'`;
    // 서버 손검사(400 REQUIRED)와 «둘 다» 둔다 — 계약 required 에 없는 조건이라 손검사가
    // 지워지면 사유 없는 긴급 건이 조용히 선다. 그때 DB 가 막아야 한다.
    expect(found?.definition).toContain('expedite_reason IS NOT NULL');
  });

  it('stock_transfer.disposition_decision_id 는 nullable bigint 이고 처분 결정을 가리킨다', async () => {
    expect(await column('stock_transfer', 'disposition_decision_id')).toEqual({
      data_type: 'bigint',
      is_nullable: 'YES',
      column_default: null,
    });
    const [fk] = await prisma.$queryRaw<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'logistics.stock_transfer'::regclass AND contype = 'f'
        AND pg_get_constraintdef(oid) LIKE '%disposition_decision%'`;
    expect(fk?.definition).toContain('quality.disposition_decision');
  });

  it('ix_stock_transfer_disposition 은 «부분» 인덱스다', async () => {
    const [index] = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'logistics' AND indexname = 'ix_stock_transfer_disposition'`;
    // 일반 이동이 압도적 다수라 NULL 을 담지 않는다 — WHERE 가 빠지면 색인이 표만큼 커진다.
    expect(index?.indexdef).toContain('WHERE (disposition_decision_id IS NOT NULL)');
  });
});

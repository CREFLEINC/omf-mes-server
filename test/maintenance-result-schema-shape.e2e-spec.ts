import { PrismaClient } from "@prisma/client";

interface Column {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

describe("I-31 M2 보전 실적 header 형상 (e2e)", () => {
  const prisma = new PrismaClient();

  afterAll(async () => prisma.$disconnect());

  it("M01 기존 필수 6칸은 완화되고 신규 header 15칸은 정본 타입이다", async () => {
    const columns = await prisma.$queryRaw<Column[]>`
      SELECT column_name,data_type,is_nullable,column_default
      FROM information_schema.columns
      WHERE table_schema='maintenance' AND table_name='maintenance_result'`;
    expect(columns).toHaveLength(26);
    const byName = Object.fromEntries(
      columns.map((column) => [column.column_name, column]),
    );
    for (const name of [
      "maintenance_order_id",
      "result_seq",
      "action_code",
      "action_description",
      "completed_at",
      "result_code",
    ]) {
      expect(byName[name].is_nullable).toBe("YES");
    }
    for (const name of [
      "target_type_code",
      "equipment_id",
      "mold_id",
      "breakdown_id",
      "result_note",
      "performed_by_user_id",
      "is_outsourced",
      "outsource_vendor_name",
      "reset_counter",
      "shot_count_before_reset",
      "shot_count_after_reset",
      "closed",
      "updated_at",
      "updated_by",
    ]) {
      expect(byName[name]).toMatchObject({
        is_nullable: "YES",
        column_default: null,
      });
    }
    expect(byName.version_no).toMatchObject({
      data_type: "integer",
      is_nullable: "NO",
      column_default: "1",
    });
  });
});

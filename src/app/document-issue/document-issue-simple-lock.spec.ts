import { Prisma } from "@prisma/client";

import { PreparedDocumentIssueTarget } from "./document-issue-create-rules";
import { targetKey } from "./document-issue-target-lookup";
import { lockSimpleDocumentIssueTargets } from "./document-issue-simple-lock";

describe("발행 단순 부모 잠금 (I-27 C2a)", () => {
  it("LOT을 ID 순서로 NO KEY UPDATE 잠그고 자격 사실을 보존한다", async () => {
    const setup = fake({
      lots: [
        {
          lot_id: 3n,
          lot_type_code: "MATERIAL",
          status_code: "NORMAL",
          completed_at: null,
        },
        {
          lot_id: 7n,
          lot_type_code: "PRODUCTION",
          status_code: "NORMAL",
          completed_at: new Date("2026-09-09T00:00:00Z"),
        },
      ],
    });

    const facts = await lockSimpleDocumentIssueTargets(
      setup.tx,
      "MATERIAL_LOT_LABEL",
      [target("LOT", 7n), target("LOT", 3n)],
    );

    expect(setup.sql[0]).toMatch(
      /FROM trace\.lot[\s\S]*ORDER BY lot_id FOR NO KEY UPDATE/,
    );
    expect(setup.values[0]).toEqual([3n, 7n]);
    expect(facts.get(targetKey("LOT", 3n))).toMatchObject({
      lotTypeCode: "MATERIAL",
      statusCode: "NORMAL",
    });
  });

  it("개체·금형·위치를 각 부모 표에서 잠그고 LOT 원천을 보존한다", async () => {
    const setup = fake({
      serials: [{ serial_number_id: 11n, lot_id: 31n }],
      molds: [{ target_id: 12n }],
      locations: [{ target_id: 13n }],
    });

    const facts = await lockSimpleDocumentIssueTargets(
      setup.tx,
      "LOCATION_LABEL",
      [
        target("SERIAL_NUMBER", 11n),
        target("MOLD", 12n),
        target("LOCATION", 13n),
      ],
    );

    expect(setup.sql).toEqual([
      expect.stringMatching(/trace\.serial_number[\s\S]*FOR NO KEY UPDATE/),
      expect.stringMatching(/mdm\.mold[\s\S]*FOR NO KEY UPDATE/),
      expect.stringMatching(/mdm\.location[\s\S]*FOR NO KEY UPDATE/),
    ]);
    expect(facts.get(targetKey("SERIAL_NUMBER", 11n))).toMatchObject({
      lotId: 31n,
    });
    expect(facts.has(targetKey("MOLD", 12n))).toBe(true);
    expect(facts.has(targetKey("LOCATION", 13n))).toBe(true);
  });

  it("출고 QR의 HU는 부모 뒤 내용물을 SHARE 잠그고 존재 여부를 기록한다", async () => {
    const setup = fake({
      units: [{ target_id: 21n }, { target_id: 22n }],
      contents: [{ handling_unit_id: 22n }, { handling_unit_id: 22n }],
    });

    const facts = await lockSimpleDocumentIssueTargets(
      setup.tx,
      "GOODS_ISSUE_QR",
      [target("HANDLING_UNIT", 22n), target("HANDLING_UNIT", 21n)],
    );

    expect(setup.sql[0]).toMatch(
      /inventory\.handling_unit[\s\S]*ORDER BY handling_unit_id FOR NO KEY UPDATE/,
    );
    expect(setup.sql[1]).toMatch(
      /handling_unit_content[\s\S]*ORDER BY handling_unit_id,handling_unit_content_id FOR SHARE/,
    );
    expect(facts.get(targetKey("HANDLING_UNIT", 21n))).toMatchObject({
      hasContent: false,
    });
    expect(facts.get(targetKey("HANDLING_UNIT", 22n))).toMatchObject({
      hasContent: true,
    });
  });

  it("포장 라벨은 내용물을 자격으로 쓰거나 잠그지 않는다", async () => {
    const setup = fake({ units: [{ target_id: 21n }] });

    const facts = await lockSimpleDocumentIssueTargets(
      setup.tx,
      "PACKING_LABEL",
      [target("HANDLING_UNIT", 21n)],
    );

    expect(setup.sql).toHaveLength(1);
    expect(setup.sql[0]).not.toContain("handling_unit_content");
    expect(facts.get(targetKey("HANDLING_UNIT", 21n))).not.toHaveProperty(
      "hasContent",
    );
  });

  it("없는 부모를 가짜 사실로 채우지 않는다", async () => {
    const setup = fake();

    const facts = await lockSimpleDocumentIssueTargets(
      setup.tx,
      "LOCATION_LABEL",
      [target("LOCATION", 404n)],
    );

    expect(facts.has(targetKey("LOCATION", 404n))).toBe(false);
  });

  it("대상이 없으면 빈 IN 문장을 실행하지 않는다", async () => {
    const setup = fake();

    await expect(
      lockSimpleDocumentIssueTargets(setup.tx, "LOCATION_LABEL", []),
    ).resolves.toEqual(new Map());
    expect(setup.sql).toEqual([]);
  });
});

interface FakeRows {
  lots?: unknown[];
  serials?: unknown[];
  units?: unknown[];
  contents?: unknown[];
  molds?: unknown[];
  locations?: unknown[];
}

function fake(rows: FakeRows = {}) {
  const sql: string[] = [];
  const values: unknown[][] = [];
  const tx = {
    $queryRaw: jest.fn(async (query: Prisma.Sql) => {
      const text = query.strings.join("?");
      sql.push(text);
      values.push(query.values);
      if (text.includes("FROM trace.lot")) return rows.lots ?? [];
      if (text.includes("FROM trace.serial_number")) return rows.serials ?? [];
      if (text.includes("FROM inventory.handling_unit\n"))
        return rows.units ?? [];
      if (text.includes("FROM inventory.handling_unit_content"))
        return rows.contents ?? [];
      if (text.includes("FROM mdm.mold")) return rows.molds ?? [];
      if (text.includes("FROM mdm.location")) return rows.locations ?? [];
      return [];
    }),
  };
  return { tx: tx as unknown as Prisma.TransactionClient, sql, values };
}

function target(
  targetTypeCode: PreparedDocumentIssueTarget["targetTypeCode"],
  targetId: bigint,
): PreparedDocumentIssueTarget {
  return { index: 0, targetTypeCode, targetId, requestedLotId: null };
}

import { Workbook } from "exceljs";

import {
  parseSparePartWorkbook,
  resolveSparePartImportPlant,
  SparePartImportRow,
} from "./spare-part-import";

describe("예비품 엑셀 파서", () => {
  it("머리글 별명으로 세 칸을 찾고 완전한 빈 행만 건너뛴다", async () => {
    const parsed = await parseSparePartWorkbook(
      await workbook([
        ["공장", "부품코드", "부품명", "계약에 없는 열"],
        ["P1", "SP-1", "씰", "무시"],
        [null, null, null, null],
        ["P1", null, null, null],
      ]),
    );

    expect(parsed.error).toBeUndefined();
    expect(parsed.rows).toEqual([
      {
        index: 0,
        plantCode: "P1",
        values: { sparePartCode: "SP-1", sparePartName: "씰" },
      },
      {
        index: 1,
        plantCode: "P1",
        values: { sparePartCode: "", sparePartName: "" },
      },
    ]);
  });

  it("읽을 수 없는 파일과 필수 머리글 결손을 구분해 400 재료로 돌려준다", async () => {
    expect(
      (await parseSparePartWorkbook(Buffer.from("not-xlsx"))).error?.code,
    ).toBe("INVALID");
    expect(
      (await parseSparePartWorkbook(await workbook([["알 수 없는 열"]]))).error
        ?.code,
    ).toBe("INVALID");
  });

  it("공장 코드가 없을 때 공장이 정확히 하나인 경우에만 자동으로 정한다", () => {
    const row: SparePartImportRow = {
      index: 0,
      plantCode: null,
      values: { sparePartCode: "SP-1", sparePartName: "씰" },
    };
    const onlyPlant = { plant_id: 17n, plant_code: "P1" };

    expect(resolveSparePartImportPlant(row, [onlyPlant])).toBe(17);
    expect(
      resolveSparePartImportPlant(row, [
        onlyPlant,
        { plant_id: 18n, plant_code: "P2" },
      ]),
    ).toBeNull();
    expect(
      resolveSparePartImportPlant({ ...row, plantCode: "UNKNOWN" }, [
        onlyPlant,
      ]),
    ).toBeNull();
  });
});

async function workbook(rows: unknown[][]): Promise<Buffer> {
  const book = new Workbook();
  const sheet = book.addWorksheet("예비품");
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await book.xlsx.writeBuffer());
}

import { Workbook } from 'exceljs';

import { checkGroup, groupRows } from './inspection-plan-import-check';
import { parseInspectionPlanWorkbook } from './inspection-plan-import';

const HEADER = ['기준코드', '기준명', '검사유형', '유효 시작일', '샘플링 방식', '검사 주기', '순서', '항목코드', '항목명', '데이터 유형', '하한', '상한', '필수'];

async function workbook(rows: unknown[][], header = HEADER): Promise<Buffer> {
  const book = new Workbook();
  const sheet = book.addWorksheet('검사기준');
  sheet.addRow(header);
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await book.xlsx.writeBuffer());
}

describe('검사기준 엑셀 읽기', () => {
  it('머리글 이름으로 열을 찾고 코드값은 대문자로, 날짜는 날짜 부분만 읽는다', async () => {
    const buffer = await workbook([
      ['P-1', '기준', 'iqc', new Date(Date.UTC(2026, 9, 1)), 'full', 'lot', 1, 'A', '외관', 'numeric', 1, 2, 'N'],
    ]);
    const { rows, error } = await parseInspectionPlanWorkbook(buffer);
    expect(error).toBeUndefined();
    expect(rows[0]).toMatchObject({
      index: 0,
      plan: { inspectionPlanCode: 'P-1', inspectionTypeCode: 'IQC' },
      version: { effectiveFrom: '2026-10-01', samplingMethodCode: 'FULL' },
      item: { inspectionItemCode: 'A', dataTypeCode: 'NUMERIC', lowerLimit: 1, upperLimit: 2, requiredFlag: false },
    });
  });

  it('빈 행은 건너뛰되 엑셀 행 번호는 그대로 두고, 필수 머리글이 없으면 읽을 수 없다', async () => {
    const parsed = await parseInspectionPlanWorkbook(await workbook([[], ['P-1', '', '', '', '', '', '', 'A', '외관']]));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].rowNumber).toBe(3);
    const missing = await parseInspectionPlanWorkbook(await workbook([['x']], ['아무 열']));
    expect(missing.error?.message).toContain('기준코드');
    const broken = await parseInspectionPlanWorkbook(Buffer.from('not a workbook'));
    expect(broken.error?.code).toBe('INVALID');
  });
});

describe('검사기준 엑셀 묶음 검사', () => {
  it('같은 기준코드를 한 묶음으로, 처음 나온 순서대로 묶는다', async () => {
    const { rows } = await parseInspectionPlanWorkbook(await workbook([
      ['P-1', '기준', 'IQC', '2026-10-01', 'FULL', 'LOT', 1, 'A', '외관', 'TEXT'],
      ['P-2', '기준2', 'IQC', '2026-10-01', 'FULL', 'LOT', 1, 'A', '외관', 'TEXT'],
      ['P-1', '', '', '', '', '', 2, 'B', '치수', 'NUMERIC'],
    ]));
    const groups = groupRows(rows);
    expect(groups.map((g) => [g.key, g.index, g.rows.length])).toEqual([['P-1', 0, 2], ['P-2', 1, 1]]);
    expect(checkGroup(groups[0])).toEqual([]);
  });

  it('버전 필수 칸·형식·범위·첫 행과 다른 값을 엑셀 행 번호와 함께 막는다', async () => {
    const { rows } = await parseInspectionPlanWorkbook(await workbook([
      ['P-1', '기준', 'IQC', '2026-13-01', '', 'LOT', 0, 'A', '외관', ''],
      ['P-1', '기준', 'OQC', '', '', '', 1, '', '', 'TEXT'],
    ]));
    const errors = checkGroup(groupRows(rows)[0]);
    const fields = errors.map((e) => e.field);
    expect(fields).toEqual(expect.arrayContaining([
      'effectiveFrom', 'samplingMethodCode', 'sequenceNo', 'dataTypeCode', 'inspectionTypeCode', 'inspectionItemCode', 'inspectionItemName',
    ]));
    expect(errors.find((e) => e.field === 'effectiveFrom')?.message).toMatch(/^엑셀 2행: /);
    expect(errors.find((e) => e.field === 'inspectionTypeCode')?.message).toMatch(/^엑셀 3행: /);
  });
});

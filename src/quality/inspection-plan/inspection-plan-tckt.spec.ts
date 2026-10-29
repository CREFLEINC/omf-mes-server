import { Workbook } from 'exceljs';

import { checkGroup, groupRows } from './inspection-plan-import-check';
import { parseInspectionPlanWorkbook } from './inspection-plan-import';
import { parseSpec } from './inspection-plan-tckt';

/** 1×1 PNG */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

/** 고객사 기준서와 같은 짜임의 합성 서식 — 칸 위치는 파일마다 달라 라벨로 찾는지를 본다. */
async function tckt(cells: Record<string, unknown>, merges: string[] = []): Promise<Buffer> {
  const book = new Workbook();
  const sheet = book.addWorksheet('TCKT');
  for (const [address, value] of Object.entries(cells)) sheet.getCell(address).value = value as never;
  merges.forEach((range) => sheet.mergeCells(range));
  return Buffer.from(await book.xlsx.writeBuffer());
}

const HEAD = {
  J7: 'Hạng mục kiểm tra', L7: 'Quy cách', N7: 'Phương pháp xác định', R7: 'Thiết bị đo lường', S7: 'Số mẫu', T7: 'Ghi chú',
};

describe('고객사 검사기준서(TCKT) 읽기', () => {
  /* #211 — 부품 IQC 화면이 측정 항목 번호를 도면과 맞춰 본다. 머리 오른쪽 위의 결재 도장 그림은 도면이 아니다. */
  it('⭐ 「Bản vẽ」 아래 · 항목 표 왼쪽의 그림만 도면으로 꺼낸다', async () => {
    const book = new Workbook();
    const sheet = book.addWorksheet('TCKT');
    Object.entries({
      A1: 'Số quản lý', B1: 'SJS-QIQ-315', H1: 'BẢNG TIÊU CHUẨN KIỂM TRA NHẬP HÀNG', A7: 'Bản vẽ', ...HEAD,
      J8: '2. Kích thước', L8: '① 1.0±0.20', R8: '3D', S8: 'n=5c=0', T8: 'Mỗi LOT',
    }).forEach(([address, value]) => { sheet.getCell(address).value = value; });
    const image = book.addImage({ buffer: PNG as never, extension: 'png' });
    sheet.addImage(image, { tl: { col: 0, row: 8 }, ext: { width: 10, height: 10 } });
    sheet.addImage(image, { tl: { col: 18, row: 0 }, ext: { width: 10, height: 10 } });

    const parsed = await parseInspectionPlanWorkbook(Buffer.from(await book.xlsx.writeBuffer()));

    expect(parsed.drawings?.map((d) => d.mime)).toEqual(['image/png']);
    expect(parsed.drawings?.[0].bytes.equals(PNG)).toBe(true);
  });

  it('⭐ 라벨 오른쪽·아래 칸에서 머리를 읽고, 치수는 수치 항목·나머지는 합격/불합격 항목이 된다', async () => {
    const parsed = await parseInspectionPlanWorkbook(await tckt({
      // 관리번호·발행일은 라벨 «아래» 줄에 있다(PQC A865B 짜임). 병합된 제목이 오른쪽 칸을 덮는다.
      A1: 'Số quản lý', D1: 'Ngày ban hành', H1: 'BẢNG TIÊU CHUẨN KIỂM\nTRA XUẤT HÀNG',
      B2: 'SJS-QIQ-30', E2: '25.11.2023',
      F4: 'Tên sản phẩm', G4: 'REAR COVER', K4: 'MODEL', M4: 'FS-534', Q4: 'Code No.', R4: 'P-1',
      ...HEAD,
      J8: '1. Ngoại quan', L8: 'Yêu cầu tốt', R8: 'Mắt nhìn', S8: 'AQL : 0,4', T8: 'MỖI LOT',
      J9: '2. Kích thước', L9: '【2】 169.4 ±0.3', R9: '3D', S9: 'n=4c=0', T9: 'MỖI LOT',
      L10: '(12)(13) 26.40+0.1/-0.5', R10: 'VC', S10: 'n=4c=1', T10: 'MỖI LOT',
      J11: '4.RoHS', L11: 'Phù hợp tiêu chuẩn quản lý RoHS', R11: 'Mỗi LOT',
      J12: 'Vấn đề cần nhớ: 800 ~ 1000LUX', L13: '99 ±1',
    }, ['H1:N2']));

    expect(parsed.error).toBeUndefined();
    const [group] = groupRows(parsed.rows);
    expect(group.key).toBe('SJS-QIQ-30-OQC');
    expect(group.rows[0]).toMatchObject({
      plan: { inspectionPlanName: 'REAR COVER (FS-534)', inspectionTypeCode: 'OQC', itemCode: 'P-1' },
      version: {
        effectiveFrom: '2023-11-25', samplingMethodCode: 'SAMPLE_BY_LOT', samplingRatio: null, samplingQty: 4,
        aqlValue: 0.4, acceptanceNumber: 0, rejectionNumber: 1, inspectionFrequencyCode: 'PRODUCTION_LOT',
      },
    });
    expect(group.rows.map((r) => [r.rowNumber, r.item.inspectionItemCode, r.item.dataTypeCode, r.item.lowerLimit, r.item.targetValue, r.item.upperLimit])).toEqual([
      [8, 'CHK-01', 'BOOLEAN', null, null, null],
      [9, 'DIM-02', 'NUMERIC', 169.1, 169.4, 169.7],
      [10, 'DIM-03', 'NUMERIC', 25.9, 26.4, 26.5],
      [11, 'CHK-04', 'BOOLEAN', null, null, null],
    ]);
    expect(group.rows.map((r) => r.item.inspectionMethodCode)).toEqual(['VISUAL', 'MEASUREMENT', 'MEASUREMENT', null]);
    // 치수 항목은 시료 칸의 n·c 를 항목마다 갖는다(#211) — 같은 장 안에서 c 가 다를 수 있다.
    expect(group.rows.map((r) => [r.item.measurementCount, r.item.acceptanceNumber])).toEqual([[null, null], [4, 0], [4, 1], [null, null]]);
    expect(checkGroup(group)).toEqual([]);
  });

  it('Code No. 가 여럿이면 품목마다 기준을 세우고, 「N lần/ngày」는 24÷N시간 간격이 된다', async () => {
    const parsed = await parseInspectionPlanWorkbook(await tckt({
      A1: 'SỐ QUẢN LÝ', C1: 'SJS-QIQ-113', E1: 'NGÀY BAN HÀNH', F1: '2026.05.11', I1: 'TIÊU CHUẨN KIỂM TRA CÔNG ĐOẠN',
      U6: 'Code No', Z6: 'A1/A2', G6: 'Tên sản Phẩm', I6: 'HOUSING',
      ...HEAD,
      J8: '2. Kích thước', L8: '① 79.22±0.1', R8: 'VC', S8: 'n=1shot', T8: '6 lần/ngày',
    }));
    const groups = groupRows(parsed.rows);
    expect(groups.map((g) => [g.key, g.rows[0].plan.itemCode])).toEqual([['SJS-QIQ-113-PQC-A1', 'A1'], ['SJS-QIQ-113-PQC-A2', 'A2']]);
    expect(groups[0].rows[0].version).toMatchObject({
      samplingMethodCode: 'SAMPLE_BY_UNIT', samplingQty: 1, inspectionFrequencyCode: 'TIME_INTERVAL', frequencyIntervalValue: 4, frequencyIntervalUomCode: 'HOUR',
    });
  });

  it('⛔ 규격이 둘인 칸·모르는 주기는 그 행 번호로 실패하고, 조건만 적힌 줄은 앞 항목에 붙는다', async () => {
    const parsed = await parseInspectionPlanWorkbook(await tckt({
      A1: 'Số quản lý', B1: 'SJS-QIQ-101', D1: 'Ngày ban hành', E1: new Date(Number.NaN), H1: 'BẢNG TIÊU CHUẨN KIỂM TRA ĐẦU VÀO',
      ...HEAD,
      J8: '2.Repot Test', L8: '①Temp; 300°c', R8: 'MI', S8: 'n=2g', T8: '2 lần/tuần',
      L9: '②Weight; 1200g',
      J10: '3. Kích thước', L10: '【38】 3.05±0.05*ф6 ±0.3', R10: 'PG', S10: 'n=1', T10: '2 lần/tuần',
    }));
    const [group] = groupRows(parsed.rows);
    expect(group.rows[0].item.inspectionItemName).toBe('Repot Test ①Temp; 300°c / ②Weight; 1200g');
    // 「n=2g」는 무게라 개수가 아니다 — 다음 줄의 「n=1」을 쓴다.
    expect(group.rows[0].version.samplingQty).toBe(1);
    const errors = checkGroup(group);
    expect(errors.map((e) => [e.field, e.message.slice(0, 7)])).toEqual(expect.arrayContaining([
      ['inspectionFrequencyCode', '엑셀 8행: '],
      ['targetValue', '엑셀 10행:'],
      ['effectiveFrom', '엑셀 8행: '],
    ]));
    // 주기는 읽은 사유 하나만 — 「비어 있다」를 겹쳐 달지 않는다.
    expect(errors.filter((e) => e.field === 'inspectionFrequencyCode')).toHaveLength(1);
  });

  it('관리번호·검사유형을 못 찾으면 파일을 읽을 수 없다', async () => {
    const noTitle = await parseInspectionPlanWorkbook(await tckt({ A1: 'Số quản lý', B1: 'SJS-1', ...HEAD }));
    expect(noTitle.error?.message).toContain('검사유형');
    const noNo = await parseInspectionPlanWorkbook(await tckt({ H1: 'TIÊU CHUẨN KIỂM TRA PQC', ...HEAD }));
    expect(noNo.error?.message).toContain('관리번호');
  });
});

describe('기준서 규격 풀기', () => {
  it.each([
    ['① 1.0±0.20', { target: 1, lower: 0.8, upper: 1.2 }],
    ['① 19.00+0.5/-0.0', { target: 19, lower: 19, upper: 19.5 }],
    ['(14)~(17) R5.5 ± 0.5', { target: 5.5, lower: 5, upper: 6 }],
    ['【25】  ф4.8 ±0.1', { target: 4.8, lower: 4.7, upper: 4.9 }],
    ['⑬ 3-9.40±0.10', { target: 9.4, lower: 9.3, upper: 9.5 }],
    ['[5-A] CONG VÊNH : ±1', { target: 0, lower: -1, upper: 1 }],
    ['( 2 ) 53±1', { target: 53, lower: 52, upper: 54 }],
  ])('%s', (spec, expected) => {
    expect(parseSpec(spec)).toEqual(expected);
  });

  it.each(['【38】【59】 3.05±0.05*ф6 ±0.3', 'Yêu cầu tốt', 'SPEC:>3Kgf'])('%s 는 풀지 않는다', (spec) => {
    expect(parseSpec(spec)).toBeNull();
  });
});

import { Workbook } from 'exceljs';

import { ERROR_CODE, ErrorItem } from '../../common/errors';

/**
 * 검사기준 엑셀 한 장을 읽는다(omf-all-around#199 · 장부 P-131).
 *
 * ⚠ **현장 양식(TCKT)을 그대로 읽지 않는다.** 제품마다 열 위치가 다르고 기준값이 글로 적혀 있다
 * (「19.00+0.5/-0.0」). 툴 엑셀 올리기와 같이 머리글 이름으로 «찾고», 못 찾은 선택 열은 비운다.
 * 한 행 = 검사 항목 하나이고, 같은 기준코드 행들이 기준 하나·버전 하나가 된다.
 */

/** 머리글 별명. 왼쪽이 필드, 오른쪽이 엑셀 머리글로 볼 만한 이름들이다(공백·괄호·_- 무시). */
const HEADERS: Record<string, readonly string[]> = {
  inspectionPlanCode: ['기준코드', '검사기준코드', 'inspectionplancode'],
  inspectionPlanName: ['기준명', '검사기준명', 'inspectionplanname'],
  inspectionTypeCode: ['검사유형', '검사구분', 'inspectiontypecode'],
  itemCode: ['품목코드', '품번', 'itemcode'],
  processCode: ['공정코드', 'processcode'],
  effectiveFrom: ['유효시작일', '적용시작일', 'effectivefrom'],
  effectiveTo: ['유효종료일', '적용종료일', 'effectiveto'],
  samplingMethodCode: ['샘플링방식', '샘플방식', 'samplingmethodcode'],
  samplingRatio: ['샘플비율', '샘플비율%', 'samplingratio'],
  aqlValue: ['aql', 'aqlvalue'],
  acceptanceNumber: ['합격판정개수', 'ac', 'acceptancenumber'],
  rejectionNumber: ['불합격판정개수', 're', 'rejectionnumber'],
  inspectionFrequencyCode: ['검사주기', '주기', 'inspectionfrequencycode'],
  sequenceNo: ['순서', '항목순서', 'sequenceno'],
  inspectionItemCode: ['항목코드', '검사항목코드', 'inspectionitemcode'],
  inspectionItemName: ['항목명', '검사항목', '검사항목명', 'inspectionitemname'],
  nameKo: ['항목명한국어', 'nameko'],
  nameVi: ['항목명베트남어', 'namevi'],
  dataTypeCode: ['데이터유형', 'datatypecode'],
  uomCode: ['단위', '단위코드', 'uomcode'],
  targetValue: ['목표값', '기준값', 'target', 'targetvalue'],
  lowerLimit: ['하한', '하한값', 'lsl', 'lowerlimit'],
  upperLimit: ['상한', '상한값', 'usl', 'upperlimit'],
  measurementCount: ['측정횟수', '측정수', 'measurementcount'],
  inspectionMethodCode: ['검사방법', 'inspectionmethodcode'],
  requiredFlag: ['필수', '필수여부', 'requiredflag'],
  automaticJudgment: ['자동판정', 'automaticjudgment'],
};

/** 없으면 읽을 수 없는 열 — 기준을 가르고 항목을 세우는 최소한이다. */
const REQUIRED_COLUMNS = ['inspectionPlanCode', 'inspectionItemCode', 'inspectionItemName'] as const;

/** 엑셀 자료 행 하나 — 아직 검증하지 않은 날것. 코드 칸은 id 로 풀기 전이다. */
export interface ImportRow {
  /** 머리글을 제외한 자료 행의 순번(0부터). 실패 목록이 이 값을 그대로 돌려준다(계약). */
  index: number;
  /** 엑셀이 매긴 실제 행 번호 — 빈 행을 건너뛰어도 사용자가 엑셀에서 보는 번호와 같다. */
  rowNumber: number;
  plan: {
    inspectionPlanCode: string;
    inspectionPlanName: string | null;
    inspectionTypeCode: string | null;
    itemCode: string | null;
    processCode: string | null;
  };
  version: {
    effectiveFrom: string | null;
    effectiveTo: string | null;
    samplingMethodCode: string | null;
    samplingRatio: number | null;
    aqlValue: number | null;
    acceptanceNumber: number | null;
    rejectionNumber: number | null;
    inspectionFrequencyCode: string | null;
  };
  item: {
    sequenceNo: number | null;
    inspectionItemCode: string;
    inspectionItemName: string;
    nameKo: string | null;
    nameVi: string | null;
    dataTypeCode: string | null;
    uomCode: string | null;
    targetValue: number | null;
    lowerLimit: number | null;
    upperLimit: number | null;
    measurementCount: number | null;
    inspectionMethodCode: string | null;
    requiredFlag: boolean | null;
    automaticJudgment: boolean | null;
  };
}

export interface ImportParse {
  rows: ImportRow[];
  /** 파일을 열지 못했거나 필수 머리글이 없다 — 「파일을 읽을 수 없다」(400). */
  error?: ErrorItem;
}

export async function parseInspectionPlanWorkbook(buffer: Buffer): Promise<ImportParse> {
  const sheet = await firstSheet(buffer);
  if (sheet === null) return { rows: [], error: unreadable('엑셀 파일을 열 수 없습니다. .xlsx 파일인지 확인하세요.') };

  const column = mapColumns(sheet.rows[0]?.cells ?? []);
  const missing = REQUIRED_COLUMNS.filter((field) => column[field] === undefined);
  if (missing.length > 0) {
    return { rows: [], error: unreadable('머리글에서 기준코드·항목코드·항목명 열을 찾지 못했습니다.') };
  }

  const cell = (cells: unknown[], field: string): unknown => cells[column[field] ?? -1];
  const rows = sheet.rows.slice(1).map(({ cells, rowNumber }, index): ImportRow => ({
    index,
    rowNumber,
    plan: {
      inspectionPlanCode: text(cell(cells, 'inspectionPlanCode')) ?? '',
      inspectionPlanName: text(cell(cells, 'inspectionPlanName')),
      inspectionTypeCode: upper(cell(cells, 'inspectionTypeCode')),
      itemCode: text(cell(cells, 'itemCode')),
      processCode: text(cell(cells, 'processCode')),
    },
    version: {
      effectiveFrom: date(cell(cells, 'effectiveFrom')),
      effectiveTo: date(cell(cells, 'effectiveTo')),
      samplingMethodCode: upper(cell(cells, 'samplingMethodCode')),
      samplingRatio: number(cell(cells, 'samplingRatio')),
      aqlValue: number(cell(cells, 'aqlValue')),
      acceptanceNumber: number(cell(cells, 'acceptanceNumber')),
      rejectionNumber: number(cell(cells, 'rejectionNumber')),
      inspectionFrequencyCode: upper(cell(cells, 'inspectionFrequencyCode')),
    },
    item: {
      sequenceNo: number(cell(cells, 'sequenceNo')),
      inspectionItemCode: text(cell(cells, 'inspectionItemCode')) ?? '',
      inspectionItemName: text(cell(cells, 'inspectionItemName')) ?? '',
      nameKo: text(cell(cells, 'nameKo')),
      nameVi: text(cell(cells, 'nameVi')),
      dataTypeCode: upper(cell(cells, 'dataTypeCode')),
      uomCode: text(cell(cells, 'uomCode')),
      targetValue: number(cell(cells, 'targetValue')),
      lowerLimit: number(cell(cells, 'lowerLimit')),
      upperLimit: number(cell(cells, 'upperLimit')),
      measurementCount: number(cell(cells, 'measurementCount')),
      inspectionMethodCode: upper(cell(cells, 'inspectionMethodCode')),
      requiredFlag: flag(cell(cells, 'requiredFlag')),
      automaticJudgment: flag(cell(cells, 'automaticJudgment')),
    },
  }));
  // 엑셀은 아래가 비어 있는 채로 저장되는 일이 흔하다 — 빈 행은 실패가 아니라 없는 행이다.
  return {
    rows: rows.filter(
      (row) =>
        row.plan.inspectionPlanCode !== '' ||
        row.item.inspectionItemCode !== '' ||
        row.item.inspectionItemName !== '',
    ),
  };
}

async function firstSheet(buffer: Buffer): Promise<{ rows: { cells: unknown[]; rowNumber: number }[] } | null> {
  try {
    const workbook = new Workbook();
    // exceljs 가 선언한 `Buffer` 와 이 저장소의 `@types/node` Buffer 가 제네릭까지는 맞지 않는다.
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const sheet = workbook.worksheets[0];
    if (sheet === undefined) return null;
    const rows: { cells: unknown[]; rowNumber: number }[] = [];
    sheet.eachRow((row) => {
      const cells: unknown[] = [];
      row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
        cells[columnNumber - 1] = cell.value;
      });
      rows.push({ cells, rowNumber: row.number });
    });
    return { rows };
  } catch {
    return null;
  }
}

function mapColumns(header: readonly unknown[]): Record<string, number | undefined> {
  const found: Record<string, number | undefined> = {};
  header.forEach((cell, position) => {
    const label = (text(cell) ?? '').replace(/[\s()_-]/g, '').toLowerCase();
    if (label === '') return;
    for (const [field, aliases] of Object.entries(HEADERS)) {
      if (found[field] === undefined && aliases.includes(label)) found[field] = position;
    }
  });
  return found;
}

/** 엑셀 셀은 수식·서식 객체로도 온다 — 사람이 보는 글자만 뽑는다. */
function text(cell: unknown): string | null {
  if (cell === null || cell === undefined) return null;
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  if (typeof cell === 'object' && 'result' in cell) return text((cell as { result: unknown }).result);
  if (typeof cell === 'object' && 'text' in cell) return text((cell as { text: unknown }).text);
  if (typeof cell === 'object' && 'richText' in cell) {
    return text((cell as { richText: { text: string }[] }).richText.map((part) => part.text).join(''));
  }
  const value = String(cell).trim();
  return value === '' ? null : value;
}

/** 코드값은 대문자로 맞춘다 — 손으로 치면 `iqc`·`Numeric` 이 섞인다. */
function upper(cell: unknown): string | null {
  return text(cell)?.toUpperCase() ?? null;
}

function number(cell: unknown): number | null {
  const value = text(cell);
  if (value === null) return null;
  const parsed = Number(value.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 날짜 셀은 exceljs 가 UTC 자정의 `Date` 로 준다 — 날짜 부분만 쓴다(타임존 변환 없음).
 * 글자로 친 `2026.10.01`·`2026/10/01` 도 받는다.
 */
function date(cell: unknown): string | null {
  const value = text(cell);
  if (value === null) return null;
  const normalized = value.replace(/[./]/g, '-');
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : value;
}

/** 필수·자동판정 칸 — 현장에서 쓰는 표기를 받는다. 모르는 값은 `null`(기본값)로 둔다. */
function flag(cell: unknown): boolean | null {
  const value = text(cell)?.toUpperCase();
  if (value === undefined) return null;
  if (['Y', 'YES', 'TRUE', 'O', '예', '1'].includes(value)) return true;
  if (['N', 'NO', 'FALSE', 'X', '아니오', '0'].includes(value)) return false;
  return null;
}

function unreadable(message: string): ErrorItem {
  return { scope: 'screen', code: ERROR_CODE.INVALID, message };
}

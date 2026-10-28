import { ERROR_CODE, ErrorItem } from '../../common/errors';
import { ImportRow } from './inspection-plan-import';

/** 같은 기준코드 행들 — 기준 하나·버전 하나가 되는 반영 단위다. */
export interface ImportGroup {
  /** 묶음 첫 행의 자료 순번 — 실패 목록의 `index` 가 이 값이다. */
  index: number;
  key: string;
  rows: ImportRow[];
}

/** 처음 나온 순서를 지켜 기준코드로 묶는다. 기준코드가 빈 행은 혼자 한 묶음이 되어 실패한다. */
export function groupRows(rows: readonly ImportRow[]): ImportGroup[] {
  const groups = new Map<string, ImportGroup>();
  for (const row of rows) {
    const key = row.plan.inspectionPlanCode === '' ? `#${row.index}` : row.plan.inspectionPlanCode;
    const group = groups.get(key) ?? { index: row.index, key: row.plan.inspectionPlanCode, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * ⛔ 엑셀 경로는 계약 검증 가드를 «지나지 않는다» — 화면 API 라면 가드가 막을 길이·정수·범위를
 * 여기서 막는다. 빠뜨리면 DB CHECK 가 500 으로 새고, 그 뒤 묶음이 하나도 처리되지 않는다.
 */
export function checkGroup(group: ImportGroup): ErrorItem[] {
  const [first] = group.rows;
  const errors: ErrorItem[] = [];
  if (group.key === '') errors.push(fail(first, 'inspectionPlanCode', ERROR_CODE.REQUIRED, '기준코드가 비어 있습니다.'));
  errors.push(...checkVersion(first));
  for (const row of group.rows) {
    errors.push(...sameAsFirst(first, row), ...checkItem(row));
  }
  return errors;
}

function checkVersion(row: ImportRow): ErrorItem[] {
  const v = row.version;
  const errors: ErrorItem[] = [];
  const required: [keyof ImportRow['version'], string][] = [
    ['effectiveFrom', '유효 시작일'],
    ['samplingMethodCode', '샘플링 방식'],
    ['inspectionFrequencyCode', '검사 주기'],
  ];
  for (const [field, label] of required) {
    if (v[field] === null) errors.push(fail(row, field, ERROR_CODE.REQUIRED, `${label}이 비어 있습니다.`));
  }
  for (const field of ['effectiveFrom', 'effectiveTo'] as const) {
    const value = v[field];
    if (value !== null && !isDate(value)) {
      errors.push(fail(row, field, ERROR_CODE.INVALID, `날짜는 2026-10-01 형식이어야 합니다(받은 값: ${value}).`));
    }
  }
  if (v.samplingRatio !== null && !(v.samplingRatio > 0 && v.samplingRatio <= 100)) {
    errors.push(fail(row, 'samplingRatio', ERROR_CODE.INVALID, '샘플 비율(%)은 0 초과 100 이하여야 합니다.'));
  }
  if (v.acceptanceNumber !== null && !(Number.isInteger(v.acceptanceNumber) && v.acceptanceNumber >= 0)) {
    errors.push(fail(row, 'acceptanceNumber', ERROR_CODE.INVALID, '합격판정개수는 0 이상의 정수여야 합니다.'));
  }
  if (v.rejectionNumber !== null && !(Number.isInteger(v.rejectionNumber) && v.rejectionNumber > 0)) {
    errors.push(fail(row, 'rejectionNumber', ERROR_CODE.INVALID, '불합격판정개수는 1 이상의 정수여야 합니다.'));
  }
  errors.push(...tooLong(row, [
    ['inspectionPlanCode', row.plan.inspectionPlanCode, 50],
    ['inspectionPlanName', row.plan.inspectionPlanName, 200],
  ]));
  return errors;
}

/** 기준·버전 칸은 묶음 안에서 같아야 한다 — 다르면 어느 값이 맞는지 서버가 고르지 않는다. */
function sameAsFirst(first: ImportRow, row: ImportRow): ErrorItem[] {
  if (row === first) return [];
  const differs = [
    ...(Object.keys(first.plan) as (keyof ImportRow['plan'])[])
      .filter((field) => row.plan[field] !== null && row.plan[field] !== first.plan[field]),
    ...(Object.keys(first.version) as (keyof ImportRow['version'])[])
      .filter((field) => row.version[field] !== null && row.version[field] !== first.version[field]),
  ];
  return differs.map((field) =>
    fail(row, field, ERROR_CODE.INVALID, '같은 기준코드 안에서 기준·버전 칸 값이 첫 행과 다릅니다. 첫 행과 같게 적거나 비워 두세요.'),
  );
}

function checkItem(row: ImportRow): ErrorItem[] {
  const item = row.item;
  const errors: ErrorItem[] = [];
  if (item.inspectionItemCode === '') errors.push(fail(row, 'inspectionItemCode', ERROR_CODE.REQUIRED, '항목코드가 비어 있습니다.'));
  if (item.inspectionItemName === '') errors.push(fail(row, 'inspectionItemName', ERROR_CODE.REQUIRED, '항목명이 비어 있습니다.'));
  if (item.dataTypeCode === null) errors.push(fail(row, 'dataTypeCode', ERROR_CODE.REQUIRED, '데이터 유형이 비어 있습니다.'));
  if (item.sequenceNo !== null && !(Number.isInteger(item.sequenceNo) && item.sequenceNo >= 1)) {
    errors.push(fail(row, 'sequenceNo', ERROR_CODE.INVALID, '순서는 1 이상의 정수여야 합니다.'));
  }
  if (item.measurementCount !== null && !(Number.isInteger(item.measurementCount) && item.measurementCount >= 1)) {
    errors.push(fail(row, 'measurementCount', ERROR_CODE.INVALID, '측정 횟수는 1 이상의 정수여야 합니다.'));
  }
  errors.push(...tooLong(row, [
    ['inspectionItemCode', item.inspectionItemCode, 50],
    ['inspectionItemName', item.inspectionItemName, 200],
    ['nameKo', item.nameKo, 200],
    ['nameVi', item.nameVi, 200],
  ]));
  return errors;
}

function tooLong(row: ImportRow, fields: [string, string | null, number][]): ErrorItem[] {
  return fields
    .filter(([, value, max]) => value !== null && value.length > max)
    .map(([field, , max]) => fail(row, field, ERROR_CODE.INVALID, `${max}자를 넘을 수 없습니다.`));
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** 엑셀이 매긴 행 번호를 문구에 붙인다 — 사용자가 엑셀에서 찾는 번호다. */
export function fail(row: ImportRow, field: string, code: ErrorItem['code'], message: string): ErrorItem {
  return { scope: 'field', field, code, message: `엑셀 ${row.rowNumber}행: ${message}` };
}

import { Worksheet } from 'exceljs';

import { ERROR_CODE, ErrorItem } from '../../common/errors';
import { cellText } from './inspection-plan-import-cell';
import { fail } from './inspection-plan-import-check';
import type { ImportParse, ImportRow } from './inspection-plan-import';

/**
 * 고객사 검사기준서(TCKT · BẢNG TIÊU CHUẨN KIỂM TRA) 한 장을 읽는다(omf-all-around#199).
 *
 * ⚠ 표가 아니라 «서식»이다 — 파일마다 칸 위치가 다르다. 그래서 위치가 아니라 **라벨 글자**로 찾는다
 *   (「Số quản lý」 오른쪽 또는 바로 아래 칸이 관리번호). 라벨은 베트남어 그대로다.
 * ⚠ 기준서 한 장 = 기준 하나. Code No. 가 여럿(「A/B/C」)이면 같은 항목으로 품목마다 기준을 하나씩 세운다.
 * ⛔ 샘플은 개수(n=5)뿐이라 샘플 비율(%)을 채우지 않는다 — 작성중 버전은 비율 없이 들어가고 확정이 막는다
 *   (사용자 결정 2026-10-28). 개수를 받을지는 omf-all-around#201 이 정한다.
 */

type Grid = Map<number, Map<number, string>>;
interface At {
  row: number;
  col: number;
}

const LABELS = [
  'SỐ QUẢN LÝ', 'NGÀY BAN HÀNH', 'NGÀY SỬA ĐỔI', 'NGÀY', 'REV', 'NHÀ CUNG CẤP', 'KHÁCH HÀNG', 'TÊN KHÁCH HÀNG',
  'TÊN SẢN PHẨM', 'MODEL', 'CODE NO', 'NGÀY CÔNG NHẬN', 'NGÀY KIỂM TRA', 'CHẤT LIỆU', 'QUY CÁCH', 'XỬ LÝ', 'BẢN VẼ',
];

const norm = (value: string): string => value.normalize('NFC').toUpperCase().replace(/\s+/g, ' ').trim();
const isLabel = (value: string): boolean => {
  const key = norm(value).replace(/[.:]+$/, '');
  return LABELS.includes(key);
};

/** 머리글 표가 아니면서 검사 항목 표 머리(「Hạng mục kiểm tra」)가 있으면 기준서로 본다. */
export function isTcktSheet(sheet: Worksheet): boolean {
  return find(readGrid(sheet), (v) => v === 'HẠNG MỤC KIỂM TRA') !== null;
}

export function parseTcktSheet(sheet: Worksheet): ImportParse {
  const grid = readGrid(sheet);
  const docNo = valueOf(grid, 'SỐ QUẢN LÝ', (v) => !v.includes(' '));
  if (docNo === null) return unreadable('기준서에서 관리번호(Số quản lý)를 찾지 못했습니다.');
  const type = typeOf(grid);
  if (type === null) return unreadable('기준서 제목에서 검사유형(IQC·PQC·OQC)을 찾지 못했습니다.');

  const issued = valueOf(grid, 'NGÀY BAN HÀNH', (v) => isoDate(v) !== null);
  const product = valueOf(grid, 'TÊN SẢN PHẨM');
  const model = valueOf(grid, 'MODEL');
  const codes = (valueOf(grid, 'CODE NO') ?? '').split(/[/,]/).map((c) => c.trim()).filter((c) => c !== '' && c !== '-');

  const lines = itemLines(grid);
  if (lines === null) return unreadable('기준서에서 검사 항목 표(Hạng mục kiểm tra)를 찾지 못했습니다.');
  if (lines.length === 0) return unreadable('기준서에 검사 항목이 없습니다.');

  const version = versionOf(lines, type, issued);
  const base = `${docNo}-${type}`;
  const plans = codes.length > 1 ? codes.map((code) => ({ planCode: `${base}-${code}`, code })) : [{ planCode: base, code: codes[0] ?? null }];

  const rows: ImportRow[] = plans.flatMap(({ planCode, code }) =>
    lines.map((line, index): ImportRow => {
      const row: ImportRow = {
        index,
        rowNumber: line.row,
        errors: [],
        plan: {
          inspectionPlanCode: planCode,
          inspectionPlanName: product === null ? model : model === null ? product : `${product} (${model})`,
          inspectionTypeCode: type,
          itemCode: code,
          processCode: null,
        },
        version: version.write,
        item: { ...line.item, sequenceNo: index + 1, inspectionItemCode: `${line.numeric ? 'DIM' : 'CHK'}-${String(index + 1).padStart(2, '0')}` },
      };
      row.errors = line.problems.map((p) => fail(row, p.field, ERROR_CODE.INVALID, p.message));
      if (index === 0) row.errors.push(...version.problems.map((p) => fail(row, p.field, ERROR_CODE.INVALID, p.message)));
      return row;
    }),
  );
  return { rows };
}

// ── 칸 찾기 ─────────────────────────────────────────────────────────────

/** 병합 칸은 첫 칸에만 값을 둔다 — 나머지 칸이 같은 글자를 되풀이하면 라벨 오른쪽 «값»으로 잘못 잡힌다. */
function readGrid(sheet: Worksheet): Grid {
  const grid: Grid = new Map();
  sheet.eachRow((row) => {
    const cells = new Map<number, string>();
    row.eachCell((cell, col) => {
      if (cell.isMerged && cell.master.address !== cell.address) return;
      const value = cellText(cell.value);
      if (value !== null) cells.set(col, value.replace(/\s+/g, ' ').trim());
    });
    if (cells.size > 0) grid.set(row.number, cells);
  });
  return grid;
}

function find(grid: Grid, match: (normalized: string) => boolean): At | null {
  for (const [row, cells] of grid) {
    for (const [col, value] of cells) if (match(norm(value))) return { row, col };
  }
  return null;
}

/**
 * 라벨 칸의 값 — 같은 줄 오른쪽 첫 칸, 없거나 맞지 않으면 바로 아랫줄(라벨 열부터 세 칸).
 * 오른쪽 첫 칸이 다른 라벨이면 값이 비어 있는 것이다.
 */
function valueOf(grid: Grid, label: string, accept: (value: string) => boolean = () => true): string | null {
  const at = find(grid, (v) => v.replace(/[.:]+$/, '') === label);
  if (at === null) return null;
  const right = [...(grid.get(at.row) ?? [])].filter(([col]) => col > at.col).sort(([a], [b]) => a - b)[0]?.[1];
  if (right !== undefined && !isLabel(right) && accept(right)) return right;
  const below = [...(grid.get(at.row + 1) ?? [])].filter(([col]) => col >= at.col && col <= at.col + 3).sort(([a], [b]) => a - b)[0]?.[1];
  if (below !== undefined && !isLabel(below) && accept(below)) return below;
  return null;
}

/** 제목에 유형이 적혀 있으면 그것, 아니면 제목 말(입고·공정·출하)로 정한다. */
function typeOf(grid: Grid): string | null {
  const at = find(grid, (v) => v.includes('TIÊU CHUẨN KIỂM TRA'));
  if (at === null) return null;
  const title = norm(grid.get(at.row)?.get(at.col) ?? '');
  const explicit = /\b(IQC|PQC|OQC)\b/.exec(title);
  if (explicit) return explicit[1];
  if (title.includes('NHẬP HÀNG') || title.includes('ĐẦU VÀO')) return 'IQC';
  if (title.includes('XUẤT HÀNG')) return 'OQC';
  if (title.includes('CÔNG ĐOẠN')) return 'PQC';
  return null;
}

// ── 검사 항목 ───────────────────────────────────────────────────────────

interface Line {
  row: number;
  numeric: boolean;
  sample: string | null;
  frequency: string | null;
  item: ImportRow['item'];
  problems: { field: string; message: string }[];
}

/**
 * 항목 표를 읽는다. 「Hạng mục kiểm tra」 칸이 있는 줄이 머리이고, 「Vấn đề cần nhớ」·「Lưu ý」 줄에서 끝난다.
 *   - 「Kích thước(치수)」 아래 규격 한 줄 = 수치 항목 하나
 *   - 그 밖의 구분(외관·RoHS·CTQ…)은 규격 줄마다 합격/불합격 항목 하나. 규격 없이 설명만 이어지는 줄은 앞 항목의 설명이다.
 */
function itemLines(grid: Grid): Line[] | null {
  const head = find(grid, (v) => v === 'HẠNG MỤC KIỂM TRA');
  if (head === null) return null;
  const header = grid.get(head.row) ?? new Map<number, string>();
  const columnOf = (label: string): number | undefined =>
    [...header].find(([col, value]) => col > head.col && norm(value).startsWith(label))?.[0];
  const col = {
    spec: columnOf('QUY CÁCH'),
    equipment: columnOf('THIẾT BỊ'),
    sample: columnOf('SỐ MẪU'),
    frequency: columnOf('GHI CHÚ'),
  };

  const lines: Line[] = [];
  let category: string | null = null;
  const rows = [...grid.keys()].filter((r) => r > head.row).sort((a, b) => a - b);
  for (const row of rows) {
    const cells = grid.get(row) ?? new Map<number, string>();
    if ([...cells.values()].some((v) => /^(VẤN ĐỀ CẦN NHỚ|LƯU Ý)/.test(norm(v)))) break;
    const at = (c: number | undefined): string | null => (c === undefined ? null : cells.get(c) ?? null);
    const named = at(head.col);
    if (named !== null) category = named.replace(/^\s*\d+\s*[.,)]?\s*/, '').trim();
    const spec = at(col.spec);
    if (category === null || (spec === null && named === null)) continue;

    const numeric = norm(category).includes('KÍCH THƯỚC') && spec !== null;
    const parsed = numeric ? parseSpec(spec) : null;
    const equipment = at(col.equipment);
    // 측정기·샘플·주기 없이 규격 글만 있는 줄은 앞 항목의 조건이다(RESIN 「②Weight; 1200g」).
    const previous = lines.at(-1);
    if (!numeric && named === null && spec !== null && equipment === null && at(col.sample) === null && at(col.frequency) === null && previous !== undefined && !previous.numeric) {
      previous.item.inspectionItemName = `${previous.item.inspectionItemName} / ${spec}`.slice(0, 200);
      continue;
    }
    lines.push({
      row,
      numeric,
      sample: at(col.sample),
      frequency: at(col.frequency),
      problems: numeric && parsed === null
        ? [{ field: 'targetValue', message: `치수 규격을 읽을 수 없습니다: ${spec}. 「1.0±0.2」·「19.00+0.5/-0.0」처럼 한 칸에 규격 하나만 적으세요.` }]
        : [],
      item: {
        sequenceNo: null,
        inspectionItemCode: '',
        inspectionItemName: (spec === null ? category : `${category} ${spec}`).slice(0, 200),
        nameKo: null,
        nameVi: null,
        dataTypeCode: numeric ? 'NUMERIC' : 'BOOLEAN',
        uomCode: null,
        targetValue: parsed?.target ?? null,
        lowerLimit: parsed?.lower ?? null,
        upperLimit: parsed?.upper ?? null,
        measurementCount: null,
        inspectionMethodCode: equipment !== null && norm(equipment) === 'MẮT NHÌN' ? 'VISUAL' : numeric ? 'MEASUREMENT' : null,
        requiredFlag: null,
        automaticJudgment: null,
      },
    });
  }
  return lines;
}

const NUMBER = '(\\d+(?:\\.\\d+)?)';
/** 도면 풍선 번호(①, (1), (14)~(17), 【2】, [5-A])와 앞 설명(「CONG VÊNH :」)을 떼고 남은 규격 */
const MARKER = /^(?:[①-⑳]|\(\s*\d+\s*\)(?:\s*~\s*\(\s*\d+\s*\))?|【\s*\d+\s*】|\[[^\]]*\])\s*/u;
const SPEC = new RegExp(
  `^(?:\\d+\\s*-\\s*(?=\\d))?(?:[RФфΦøØ]\\s*)?${NUMBER}?\\s*(?:±\\s*${NUMBER}|\\+\\s*${NUMBER}\\s*/\\s*-\\s*${NUMBER})$`,
  'u',
);

/**
 * 「1.0±0.20」 「28.00+0.1/-0.5」 「R5.5 ± 0.5」 「ф4.8 ±0.1」 「3-9.40±0.10」(3곳) 「CONG VÊNH : ±1」(목표 0).
 * 한 칸에 규격이 둘이면(「3.05±0.05*ф6 ±0.3」) 어느 값인지 고르지 않는다 — `null`.
 */
export function parseSpec(spec: string): { target: number; lower: number; upper: number } | null {
  let rest = spec.trim();
  while (MARKER.test(rest)) rest = rest.replace(MARKER, '').trim();
  if (rest.includes(':')) rest = rest.slice(rest.lastIndexOf(':') + 1).trim();
  const m = SPEC.exec(rest);
  if (m === null) return null;
  const target = Number(m[1] ?? 0);
  const plus = Number(m[2] ?? m[3]);
  const minus = Number(m[2] ?? m[4]);
  const round = (v: number): number => Number(v.toFixed(6));
  return { target, lower: round(target - minus), upper: round(target + plus) };
}

// ── 버전 설정 ───────────────────────────────────────────────────────────

/**
 * 버전 하나에 샘플·주기가 하나뿐이다 — 기준서는 항목마다 다르므로 **치수 항목**을 따른다(없으면 첫 항목).
 * AQL 은 어느 항목이든 적힌 값(보통 외관), 합격판정개수는 「c=0」의 수, 불합격판정개수는 그다음 수다.
 */
function versionOf(lines: Line[], type: string, issued: string | null): { write: ImportRow['version']; problems: { field: string; message: string }[] } {
  const lead = lines.find((l) => l.numeric && l.frequency !== null) ?? lines.find((l) => l.frequency !== null) ?? lines[0];
  const aql = lines.map((l) => l.sample ?? '').find((s) => /AQL/i.test(s));
  const aqlValue = aql === undefined ? null : Number((aql.match(/\d+(?:[.,]\d+)?/g) ?? []).at(-1)?.replace(',', '.') ?? NaN);
  const c = /c\s*=\s*(\d+)/i.exec(lead.sample ?? '') ?? lines.map((l) => /c\s*=\s*(\d+)/i.exec(l.sample ?? '')).find((m) => m !== null) ?? null;
  const acceptance = c === null ? null : Number(c[1]);
  const frequency = frequencyOf(lead.frequency, type);
  return {
    write: {
      effectiveFrom: issued === null ? null : isoDate(issued),
      effectiveTo: null,
      samplingMethodCode: /SHOT/i.test(lead.sample ?? '') ? 'SAMPLE_BY_UNIT' : 'SAMPLE_BY_LOT',
      samplingRatio: null,
      aqlValue: aqlValue === null || Number.isNaN(aqlValue) ? null : aqlValue,
      acceptanceNumber: acceptance,
      rejectionNumber: acceptance === null ? null : acceptance + 1,
      inspectionFrequencyCode: frequency?.code ?? null,
      frequencyIntervalValue: frequency?.interval ?? null,
      frequencyIntervalUomCode: frequency?.interval == null ? null : 'HOUR',
    },
    problems: frequency === null
      ? [{ field: 'inspectionFrequencyCode', message: `검사 주기를 읽을 수 없습니다: ${lead.frequency ?? '(빈 칸)'}. 「Mỗi LOT」·「6 lần/ngày」·「2 lần/ca」 중 하나로 적으세요.` }]
      : [],
  };
}

/** 「Mỗi LOT」=LOT마다(IQC 는 자재 LOT), 「N lần/ngày」=24÷N시간마다, 「N lần/ca」=근무조별 */
function frequencyOf(text: string | null, type: string): { code: string; interval: number | null } | null {
  const value = norm(text ?? '');
  if (value.startsWith('MỖI LOT')) return { code: type === 'IQC' ? 'MATERIAL_LOT' : 'PRODUCTION_LOT', interval: null };
  const perDay = /^(\d+)\s*LẦN\s*\/\s*NGÀY/.exec(value);
  if (perDay && Number(perDay[1]) > 0) return { code: 'TIME_INTERVAL', interval: Number((24 / Number(perDay[1])).toFixed(6)) };
  if (/^\d+\s*LẦN\s*\/\s*CA/.test(value)) return { code: 'SHIFT', interval: null };
  return null;
}

/** 「2026.07.13」「2023-11-07」(년 먼저) · 「04.09.2025」(베트남식 일.월.년) */
function isoDate(value: string): string | null {
  const pad = (v: string): string => v.padStart(2, '0');
  const ymd = /^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})$/.exec(value);
  if (ymd) return `${ymd[1]}-${pad(ymd[2])}-${pad(ymd[3])}`;
  const dmy = /^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$/.exec(value);
  if (dmy) return `${dmy[3]}-${pad(dmy[2])}-${pad(dmy[1])}`;
  return null;
}

function unreadable(message: string): ImportParse {
  const error: ErrorItem = { scope: 'screen', code: ERROR_CODE.INVALID, message };
  return { rows: [], error };
}

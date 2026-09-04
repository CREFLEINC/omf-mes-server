import { Workbook } from 'exceljs';

import { ERROR_CODE, ErrorItem } from '../../common/errors';
import { MoldCreate } from './mold.service';

/**
 * 툴 엑셀 대장 한 장을 읽는다.
 *
 * ⚠ **받을 열이 아직 정해지지 않았다.** 계약이 적었다 — 「받을 열은 현행 엑셀 실물을
 * 수집해야 정해진다. 지금은 코드·명칭만 확실하다」. 그래서 머리글 이름으로 «찾고»,
 * 못 찾은 선택 열은 비운다. 열이 확정되면 아래 별명표만 고친다.
 *
 * ⛔ 통째로 되돌리지 않는다 — 성공한 행은 남기고 거부한 행만 돌려준다(공유계약 C-2).
 */

/** 머리글 별명. 왼쪽이 계약 필드, 오른쪽이 현장 대장에서 볼 만한 이름들이다. */
const HEADERS: Record<string, readonly string[]> = {
  plantCode: ['공장코드', '공장', 'plantcode'],
  moldCode: ['툴코드', '금형코드', '코드', 'moldcode'],
  moldName: ['툴명', '금형명', '명칭', '이름', 'moldname'],
  toolTypeCode: ['도구유형', '툴유형', '유형', 'tooltypecode'],
  cavityCount: ['캐비티', '캐비티수', 'cavitycount'],
  guaranteedShotCount: ['적정타수', '보증타수', 'guaranteedshotcount'],
};

/** 엑셀 자료 행 하나 — 아직 검증하지 않은 날것. */
export interface ImportRow {
  /** 머리글을 제외한 자료 행의 순번(0부터). 실패 목록이 이 값을 그대로 돌려준다(계약). */
  index: number;
  plantCode: string | null;
  values: Omit<MoldCreate, 'plantId'>;
}

export interface ImportParse {
  rows: ImportRow[];
  /** 파일을 열지 못했거나 머리글에 코드·명칭이 없다 — 「파일을 읽을 수 없다」(400). */
  error?: ErrorItem;
}

export async function parseMoldWorkbook(buffer: Buffer): Promise<ImportParse> {
  const sheet = await firstSheet(buffer);
  if (sheet === null) return { rows: [], error: unreadable('엑셀 파일을 열 수 없습니다.') };

  const header = sheet.rows[0] ?? [];
  const column = mapColumns(header);
  if (column.moldCode === undefined || column.moldName === undefined) {
    return {
      rows: [],
      // 코드·명칭 둘만은 계약이 「확실하다」고 못박은 열이라 없으면 읽을 수 없다.
      error: unreadable('머리글에서 툴 코드·명칭 열을 찾지 못했습니다.'),
    };
  }

  const rows = sheet.rows.slice(1).map((cells, index) => ({
    index,
    plantCode: text(cells[column.plantCode ?? -1]),
    values: {
      moldCode: text(cells[column.moldCode as number]) ?? '',
      moldName: text(cells[column.moldName as number]) ?? '',
      // 유형 열이 없는 대장이 대부분이다 — 금형으로 둔다(표 이름이 곧 기본 유형이다).
      toolTypeCode: text(cells[column.toolTypeCode ?? -1]) ?? 'MOLD',
      cavityCount: number(cells[column.cavityCount ?? -1]) ?? 1,
      guaranteedShotCount: number(cells[column.guaranteedShotCount ?? -1]),
    },
  }));
  // 엑셀 대장은 아래가 비어 있는 채로 저장되는 일이 흔하다 — 빈 행은 실패가 아니라 없는 행이다.
  return { rows: rows.filter((row) => row.values.moldCode !== '' || row.values.moldName !== '') };
}

async function firstSheet(buffer: Buffer): Promise<{ rows: unknown[][] } | null> {
  try {
    const workbook = new Workbook();
    // exceljs 가 선언한 `Buffer` 와 이 저장소의 `@types/node` Buffer 가 제네릭까지는
    // 맞지 않는다. 값은 같은 바이트열이라 한 번만 좁혀 준다.
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const sheet = workbook.worksheets[0];
    if (sheet === undefined) return null;
    const rows: unknown[][] = [];
    sheet.eachRow((row) => {
      const cells: unknown[] = [];
      row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
        cells[columnNumber - 1] = cell.value;
      });
      rows.push(cells);
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
  if (typeof cell === 'object' && 'result' in cell) return text((cell as { result: unknown }).result);
  if (typeof cell === 'object' && 'text' in cell) return text((cell as { text: unknown }).text);
  const value = String(cell).trim();
  return value === '' ? null : value;
}

function number(cell: unknown): number | null {
  const value = text(cell);
  if (value === null) return null;
  const parsed = Number(value.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function unreadable(message: string): ErrorItem {
  return { scope: 'screen', code: ERROR_CODE.INVALID, message };
}

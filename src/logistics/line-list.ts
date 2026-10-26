import { PagedResponse } from '../common/pagination';

/** 줄 목록이 짚는 마스터 — 화면이 이름을 따로 찾지 않게 코드·이름을 함께 싣는다. */
export interface Named {
  id: number;
  code: string;
  name: string;
}

export interface BuiltSql {
  sql: string;
  params: unknown[];
}

export function named(id: bigint, code: string, name: string): Named {
  return { id: Number(id), code, name };
}

/** 현황 목록의 합계 — 쪽과 무관하게 필터 전체를 센다. 단위가 섞이면 더할 수 없어 단위마다 둔다. */
export interface LineTotals {
  lineCount: number;
  qtyByUom: { uomId: number; uomCode: string; qty: number }[];
}

export type PagedWithTotals<T> = PagedResponse<T> & { totals: LineTotals };

export interface UomTotalRow {
  uom_id: bigint;
  uom_code: string;
  qty: unknown;
  line_count: bigint;
}

export function lineTotals(rows: UomTotalRow[]): LineTotals {
  return {
    lineCount: rows.reduce((sum, row) => sum + Number(row.line_count), 0),
    qtyByUom: rows.map((row) => ({ uomId: Number(row.uom_id), uomCode: row.uom_code, qty: Number(row.qty) })),
  };
}

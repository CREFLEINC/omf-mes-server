import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';

/**
 * 입하 줄 ↔ 자재 LOT(피처 005). 새 흐름은 줄 하나에 LOT 이 여럿이고 `inbound_receipt_line.lot_id` 를 비운다 —
 * 그 줄의 LOT 은 원천(`trace.lot.source_type_code`·`source_id`)으로 잇는다. 옛 줄(`lot_id` 있음)은 그 칸을 그대로 따른다:
 * 옛 데이터·시험 데이터에는 `lot_id` 의 LOT 원천이 그 줄이 아니거나, 같은 줄을 원천으로 한 LOT 이 더 있는 줄이 있다.
 * `trace.lot.inbound_lot_id` 로 잇지 않는다 — 선별 자식(`LOT_SPLIT`)도 같은 입하 LOT 을 가진다.
 */
export const INBOUND_RECEIPT_LINE_SOURCE = 'INBOUND_RECEIPT_LINE';

type LotReader = { lot: { findMany: Prisma.TransactionClient['lot']['findMany'] } };
type LineRef = { inbound_receipt_line_id: bigint; lot_id: bigint | null };
type LineLot<S extends Prisma.lotSelect> = Prisma.lotGetPayload<{ select: S }> & {
  lot_id: bigint;
  source_type_code: string;
  source_id: bigint;
};

/** 줄마다 그 줄의 LOT(`lot_id` 오름차순) — 옛 줄은 `lot_id` 하나, 새 흐름의 줄은 원천 LOT 전부. 없으면 빈 배열. */
export async function lotsOfInboundLines<S extends Prisma.lotSelect>(
  db: LotReader,
  lines: readonly LineRef[],
  select: S,
): Promise<Map<bigint, LineLot<S>[]>> {
  const byLine = new Map<bigint, LineLot<S>[]>(lines.map((line) => [line.inbound_receipt_line_id, []]));
  if (lines.length === 0) return byLine;
  const legacy = [...new Set(lines.flatMap((line) => (line.lot_id === null ? [] : [line.lot_id])))];
  const sourced = new Set(lines.flatMap((line) => (line.lot_id === null ? [line.inbound_receipt_line_id] : [])));
  const rows = (await db.lot.findMany({
    where: {
      OR: [
        ...(legacy.length === 0 ? [] : [{ lot_id: { in: legacy } }]),
        ...(sourced.size === 0 ? [] : [{ source_type_code: INBOUND_RECEIPT_LINE_SOURCE, source_id: { in: [...sourced] } }]),
      ],
    },
    select: { ...select, lot_id: true, source_type_code: true, source_id: true } as Prisma.lotSelect,
    orderBy: { lot_id: 'asc' },
  })) as unknown as LineLot<S>[];
  const byId = new Map(rows.map((row) => [row.lot_id, row]));
  for (const line of lines) {
    const lot = line.lot_id === null ? undefined : byId.get(line.lot_id);
    if (lot !== undefined) byLine.get(line.inbound_receipt_line_id)?.push(lot);
  }
  for (const row of rows) {
    if (row.source_type_code === INBOUND_RECEIPT_LINE_SOURCE && sourced.has(row.source_id)) byLine.get(row.source_id)?.push(row);
  }
  return byLine;
}

/** 줄의 대표 LOT — 응답에 줄당 LOT 칸이 하나뿐인 자리(`lotId`·`lotNo`). 옛 줄은 `lot_id` 의 LOT, 새 흐름은 맨 앞. */
export function representativeLot<T>(lots: readonly T[] | undefined): T | null {
  return lots?.[0] ?? null;
}

/**
 * 원시 SQL 의 연결 조건 — `lotAlias` LOT 이 `lineAlias` 입하 줄의 LOT 이다(`lotsOfInboundLines` 와 같은 규칙).
 * 별칭은 코드 상수만 넘긴다.
 */
export function inboundLineLotSql(lotAlias: string, lineAlias: string): string {
  return `(${lineAlias}.lot_id = ${lotAlias}.lot_id OR (${lineAlias}.lot_id IS NULL
    AND ${lotAlias}.source_type_code = '${INBOUND_RECEIPT_LINE_SOURCE}' AND ${lotAlias}.source_id = ${lineAlias}.inbound_receipt_line_id))`;
}

/**
 * 옛 입하 쓰기(`POST /logistics/inbound-receipts`·`:split`·`:per-line`·입하 원천 `POST /trace/lots`)는 닫혔다 — 남겨 두면
 * 「입하 줄 1 = LOT 1」 데이터가 계속 생긴다(피처 005 FR-036 · R-6). 멱등 처리 «안»에서 던진다: 닫기 전에 성공한 요청의
 * 재전송(PDA 대기 전송)은 저장된 응답을 그대로 받는다.
 */
export function legacyInboundWriteClosed(): ContractException {
  return new ContractException(HttpStatus.CONFLICT, [
    { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '옛 입하 등록은 닫혔습니다. 입하 LOT 받기를 쓰세요.' },
  ]);
}

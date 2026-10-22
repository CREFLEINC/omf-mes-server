import { Prisma, erp_outbound_row } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { RcvTable } from './rcv-tables';

/** 중계 표 칸 값. 날짜·시각은 바꾸개가 공장 현지 문자열로 만든다 — mssql 드라이버는 Date 를 UTC 로 바꿔 넣는다. */
export type RelayValue = string | number | null;
export type RelayValues = Record<string, RelayValue>;

/** 바꾸개가 만든 행 하나 — 업무 칸만. IF_SEQ·CREATE_TYPE·처리 표시는 예약이 채운다. */
export interface RowDraft {
  table: RcvTable;
  values: RelayValues;
}

/** `integration.erp_outbound_row.status_code` — DB CHECK 와 같은 넷. */
export const OUTBOUND_ROW_STATUS = {
  /** 키를 정해 적었다. 중계 DB 에는 아직 없거나, 넣다 끊겨 들어갔는지 모른다. */
  RESERVED: 'RESERVED',
  INSERTED: 'INSERTED',
  APPLIED: 'APPLIED',
  REJECTED: 'REJECTED',
} as const;

/** CREATE_TYPE — A 생성, C 취소. */
const CREATE = 'A';

export interface ReservedRow {
  id: bigint;
  tableName: string;
  relayKey: string;
  /** 넣을 칸과 값 전부 — 업무 칸에 IF_SEQ·CREATE_TYPE·처리 표시를 더한 것. */
  values: RelayValues;
  statusCode: string;
  relayInfId: bigint | null;
}

/** 중계 표에 이미 있는 그 건의 마지막 IF_SEQ. 없으면 0. */
export type RelayLastIfSeq = (table: RcvTable, documentNo: string) => number;

/** 건 하나를 가르는 값 — `relay_key` 처럼 칸 값을 '|' 로 잇는다. */
export function documentNoOf(table: RcvTable, values: RelayValues): string {
  return joinValues(table, table.documentColumns, values);
}

export class OutboundRows {
  constructor(private readonly prisma: PrismaService) {}

  /** 그 메시지에 이미 적은 행. 없으면 []. */
  async of(messageId: bigint): Promise<ReservedRow[]> {
    const rows = await this.prisma.erp_outbound_row.findMany({
      where: { integration_message_id: messageId },
      orderBy: { erp_outbound_row_id: 'asc' },
    });
    return rows.map(reservedRow);
  }

  /** 중계 DB 에 넣었다 — 그 행의 MES_INF_ID 와 함께. */
  async markInserted(rows: readonly { id: bigint; relayInfId: bigint }[], at: Date): Promise<void> {
    await this.prisma.$transaction(
      rows.map((row) =>
        this.prisma.erp_outbound_row.update({
          where: { erp_outbound_row_id: row.id },
          data: { status_code: OUTBOUND_ROW_STATUS.INSERTED, relay_inf_id: row.relayInfId, inserted_at: at },
        }),
      ),
    );
  }

  /**
   * 중계 DB 가 거절한 묶음의 예약을 지운다 — 한 트랜잭션이라 하나도 들어가지 않았다. 남겨 두면 재처리가 같은 값을
   * 다시 넣다 같은 이유로 또 거절당한다. 지우면 재처리가 고친 데이터로 새로 바꾼다.
   */
  async discard(messageId: bigint): Promise<void> {
    await this.prisma.erp_outbound_row.deleteMany({
      where: { integration_message_id: messageId, status_code: OUTBOUND_ROW_STATUS.RESERVED },
    });
  }

  /**
   * 메시지 하나의 행에 키를 매겨 적는다 — 중계 DB 에 넣기 «전에» 부른다.
   * 이미 적은 메시지면 적은 그대로 돌려준다 — 넣다 끊겨 다시 잡혀도 키도 값도 바뀌지 않는다.
   *
   * IF_SEQ 는 MES 기록과 중계 표(`relayLast`) 중 큰 쪽의 다음이다. MES DB 를 새로 세웠는데 중계 표에 시험 행이
   * 남아 있으면 같은 키가 생기고, 넣기는 그 행을 «이미 넣었다»로 건너뛰어 보낼 행이 사라진다.
   */
  async reserve(
    messageId: bigint,
    drafts: RowDraft[],
    relayLast: RelayLastIfSeq,
  ): Promise<ReservedRow[]> {
    return this.prisma.$transaction(async (tx) => {
      const reserved = await tx.erp_outbound_row.findMany({
        where: { integration_message_id: messageId },
        orderBy: { erp_outbound_row_id: 'asc' },
      });
      if (reserved.length > 0) return reserved.map(reservedRow);

      const issued = new Map<string, number>();
      const data: Prisma.erp_outbound_rowCreateManyInput[] = [];
      for (const { table, values: fields } of drafts) {
        const documentNo = documentNoOf(table, fields);
        const counter = `${table.name}|${documentNo}`;
        const previous = issued.get(counter);
        const ifSeq =
          previous === undefined
            ? Math.max(await lastIfSeq(tx, table, documentNo), relayLast(table, documentNo)) + 1
            : table.ifSeq === 'perRow'
              ? previous + 1
              : previous;
        issued.set(counter, ifSeq);
        const values: RelayValues = { ...fields, IF_SEQ: ifSeq, CREATE_TYPE: CREATE, ...table.initialFlags };
        data.push({
          integration_message_id: messageId,
          relay_table_name: table.name,
          document_no: documentNo,
          relay_key: joinValues(table, table.keyColumns, values),
          if_seq: ifSeq,
          create_type_code: CREATE,
          row_values: values,
          status_code: OUTBOUND_ROW_STATUS.RESERVED,
        });
      }
      const created = await tx.erp_outbound_row.createManyAndReturn({ data });
      return created
        .sort((a, b) => (a.erp_outbound_row_id < b.erp_outbound_row_id ? -1 : 1))
        .map(reservedRow);
    });
  }
}

async function lastIfSeq(
  tx: Prisma.TransactionClient,
  table: RcvTable,
  documentNo: string,
): Promise<number> {
  const last = await tx.erp_outbound_row.aggregate({
    where: { relay_table_name: table.name, document_no: documentNo },
    _max: { if_seq: true },
  });
  return last._max.if_seq ?? 0;
}

function joinValues(table: RcvTable, columns: readonly string[], values: RelayValues): string {
  return columns
    .map((column) => {
      const value = values[column];
      if (value === null || value === undefined || value === '') {
        throw new Error(`${table.name}.${column} 이 비었다 — 키 칸이다`);
      }
      return String(value);
    })
    .join('|');
}

function reservedRow(row: erp_outbound_row): ReservedRow {
  return {
    id: row.erp_outbound_row_id,
    tableName: row.relay_table_name,
    relayKey: row.relay_key,
    values: row.row_values as RelayValues,
    statusCode: row.status_code,
    relayInfId: row.relay_inf_id,
  };
}

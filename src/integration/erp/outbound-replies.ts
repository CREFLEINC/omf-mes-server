import { PrismaService } from '../../prisma/prisma.service';
import { MESSAGE_STATUS } from '../message/integration-message.service';
import { OUTBOUND_ROW_STATUS, OutboundRows, ReservedRow, RowReply } from './outbound-rows';
import { RcvTable, tableNamed } from './rcv-tables';
import { RelayClient } from './relay-client';

/** 한 회차에 회신을 읽는 행 수 — 오래된 것부터. */
export const REPLY_BATCH = 200;

/**
 * ERP 회신 읽기 — 넣은 행을 ERP 가 반영했는지·거절했는지 읽어 행과 메시지에 적는다.
 * - 행: 처리 표시가 Y 면 APPLIED(전표번호), 오류가 적혀 있으면 REJECTED, 둘 다 아니면 INSERTED(ERP 가 아직 안 집었거나
 *   오류를 지우고 다시 처리 중).
 * - 메시지: 행이 전부 반영되면 DONE, 하나라도 거절이면 FAILED, 거절이 풀리면 다시 PROCESSING.
 * ⛔ 다시 보내려고 대기·잡힌 메시지는 바꾸지 않는다 — 그쪽이 끝난 뒤 다음 회차가 맞춘다.
 */
export class OutboundReplies {
  private readonly rows: OutboundRows;

  constructor(
    private readonly prisma: PrismaService,
    private readonly relay: Pick<RelayClient, 'replies'>,
    private readonly tables: readonly RcvTable[],
  ) {
    this.rows = new OutboundRows(prisma);
  }

  async read(): Promise<void> {
    const changed: { row: ReservedRow; reply: RowReply }[] = [];
    const waiting = await this.rows.waiting(
      this.tables.map((table) => table.name),
      REPLY_BATCH,
    );
    for (const [name, rows] of byTable(waiting)) {
      const replies = await this.relay.replies(
        tableNamed(this.tables, name),
        rows.map((row) => row.values),
      );
      for (const row of rows) {
        const found = replies.get(row.relayKey);
        // 중계 표에서 사라진 행 — 그대로 둔다.
        if (found === undefined) continue;
        const reply: RowReply = {
          id: row.id,
          statusCode: found.applied
            ? OUTBOUND_ROW_STATUS.APPLIED
            : found.error !== null
              ? OUTBOUND_ROW_STATUS.REJECTED
              : OUTBOUND_ROW_STATUS.INSERTED,
          erpDocumentNo: found.documentNo,
          erpErrorMessage: found.applied ? null : found.error,
        };
        if (
          reply.statusCode !== row.statusCode ||
          reply.erpDocumentNo !== row.erpDocumentNo ||
          reply.erpErrorMessage !== row.erpErrorMessage
        ) {
          changed.push({ row, reply });
        }
      }
    }
    if (changed.length === 0) return;
    await this.rows.recordReplies(
      changed.map(({ reply }) => reply),
      new Date(),
    );
    for (const messageId of new Set(changed.map(({ row }) => row.messageId))) await this.settle(messageId);
  }

  private async settle(messageId: bigint): Promise<void> {
    const rows = await this.rows.of(messageId);
    const where = { integration_message_id: messageId, locked_by: null };
    const rejected = rows.find((row) => row.statusCode === OUTBOUND_ROW_STATUS.REJECTED);
    if (rows.every((row) => row.statusCode === OUTBOUND_ROW_STATUS.APPLIED)) {
      await this.prisma.integration_message.updateMany({
        where: { ...where, status_code: { in: [MESSAGE_STATUS.PROCESSING, MESSAGE_STATUS.FAILED] } },
        data: { status_code: MESSAGE_STATUS.DONE, completed_at: new Date(), last_error_message: null },
      });
    } else if (rejected !== undefined) {
      await this.prisma.integration_message.updateMany({
        where: { ...where, status_code: MESSAGE_STATUS.PROCESSING },
        data: {
          status_code: MESSAGE_STATUS.FAILED,
          retry_count: { increment: 1 },
          last_error_message: `ERP 가 거절했다 — ${rejected.erpErrorMessage}`,
        },
      });
    } else {
      await this.prisma.integration_message.updateMany({
        where: { ...where, status_code: MESSAGE_STATUS.FAILED },
        data: { status_code: MESSAGE_STATUS.PROCESSING, last_error_message: null },
      });
    }
  }
}

function byTable(rows: ReservedRow[]): Map<string, ReservedRow[]> {
  const grouped = new Map<string, ReservedRow[]>();
  for (const row of rows) grouped.set(row.tableName, [...(grouped.get(row.tableName) ?? []), row]);
  return grouped;
}

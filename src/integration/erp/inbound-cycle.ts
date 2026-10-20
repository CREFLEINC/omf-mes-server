import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { MESSAGE_STATUS } from '../message/integration-message.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RelayClient } from './relay-client';
import { RelayRow, RelayTable, businessKey, orderColumns } from './relay-tables';

export type Tx = Prisma.TransactionClient;

/** 받는 표 하나 — 원본 표와 MES 에 옮기는 법. */
export interface InboundTable {
  readonly source: RelayTable;
  /** ⛔ 값이 그대로면 아무것도 바꾸지 않는다 — 같은 행이 다시 와도 결과가 같아야 한다. */
  apply(tx: Tx, row: RelayRow): Promise<void>;
}

export interface InboundResult {
  read: number;
  applied: number;
  failed: number;
  held: number;
}

export const INBOUND = 'INBOUND';
/** 이만큼 실패한 행은 사람이 `:retry` 하기 전까지 건너뛴다. */
export const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 500;

/**
 * 표 하나의 한 회차 — 읽기 → 반영 → 'Y' 표시, 남은 행이 없을 때까지.
 *
 * ⭐ 순서가 «MES 저장 → ERP 표시» 다. 사이에서 죽으면 같은 행이 다음 회차에 다시 오고,
 * 반영과 기록이 둘 다 같은 결과를 내므로 해가 없다. 거꾸로면 표시만 되고 반영이 빠진다.
 */
export class InboundCycle {
  private readonly logger = new Logger(InboundCycle.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly relay: RelayClient,
  ) {}

  async run(table: InboundTable): Promise<InboundResult> {
    const { source } = table;
    const quarantined = await this.quarantined(source);
    const blocked = new Set(quarantined.values());
    const result: InboundResult = { read: 0, applied: 0, failed: 0, held: 0 };

    for (let after: unknown[] | undefined; ;) {
      const rows = await this.relay.fetchPending(source, after, BATCH_SIZE);
      if (rows.length === 0) break;
      result.read += rows.length;
      after = orderColumns(source).map((column) => rows[rows.length - 1][column]);

      const applied: number[] = [];
      for (const row of rows) {
        const key = businessKey(source, row);
        if (quarantined.has(row.MES_INF_ID) || blocked.has(key)) {
          blocked.add(key);
          result.held += 1;
          continue;
        }
        try {
          await this.prisma.$transaction(async (tx) => {
            await table.apply(tx, row);
            await recordDone(tx, source, row);
          });
          applied.push(row.MES_INF_ID);
          result.applied += 1;
        } catch (error) {
          blocked.add(key);
          result.failed += 1;
          await recordFailure(this.prisma, source, row, error);
        }
      }

      await this.relay.ack(source, applied);
      if (rows.length < BATCH_SIZE) break;
    }

    this.logger.log(
      `${source.name} 읽음 ${result.read} · 반영 ${result.applied} · 실패 ${result.failed} · 보류 ${result.held}`,
    );
    return result;
  }

  /** 격리된 행 → 그 업무 키. `:retry` 가 PENDING 으로 돌리면 여기서 빠진다. */
  private async quarantined(source: RelayTable): Promise<Map<number, string>> {
    const messages = await this.prisma.integration_message.findMany({
      where: {
        interface_code: source.interfaceCode,
        direction_code: INBOUND,
        status_code: MESSAGE_STATUS.FAILED,
        retry_count: { gte: MAX_ATTEMPTS },
      },
      select: { target_id: true, payload: true },
    });
    return new Map(messages.map((m) => [Number(m.target_id), (m.payload as { key: string }).key]));
  }
}

function messageKey(source: RelayTable, row: RelayRow): string {
  return `${source.interfaceCode}:${row.MES_INF_ID}`;
}

/** ⛔ 원본 행에는 Date 가 섞여 있다 — JSON 으로 한 번 펴서 싣는다. */
function payloadOf(source: RelayTable, row: RelayRow): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify({
      key: businessKey(source, row),
      seq: row[source.versionColumn],
      row,
    }),
  ) as Prisma.InputJsonValue;
}

async function recordDone(tx: Tx, source: RelayTable, row: RelayRow): Promise<void> {
  const now = new Date();
  const payload = payloadOf(source, row);
  await tx.integration_message.upsert({
    where: { message_key: messageKey(source, row) },
    create: {
      message_key: messageKey(source, row),
      interface_code: source.interfaceCode,
      direction_code: INBOUND,
      // 원본 행이 대상이다 — 반영 전에는 MES 쪽 id 가 없다.
      target_type_code: source.name,
      target_id: row.MES_INF_ID,
      payload,
      status_code: MESSAGE_STATUS.DONE,
      completed_at: now,
    },
    update: {
      payload,
      status_code: MESSAGE_STATUS.DONE,
      completed_at: now,
      last_error_message: null,
    },
  });
}

async function recordFailure(
  prisma: PrismaService,
  source: RelayTable,
  row: RelayRow,
  error: unknown,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  const payload = payloadOf(source, row);
  await prisma.integration_message.upsert({
    where: { message_key: messageKey(source, row) },
    create: {
      message_key: messageKey(source, row),
      interface_code: source.interfaceCode,
      direction_code: INBOUND,
      target_type_code: source.name,
      target_id: row.MES_INF_ID,
      payload,
      status_code: MESSAGE_STATUS.FAILED,
      retry_count: 1,
      last_error_message: message,
    },
    update: {
      payload,
      status_code: MESSAGE_STATUS.FAILED,
      retry_count: { increment: 1 },
      last_error_message: message,
    },
  });
}

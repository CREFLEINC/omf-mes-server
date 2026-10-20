import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { MESSAGE_STATUS } from '../message/integration-message.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RelayClient } from './relay-client';
import { RelayRow, RelayTable, businessKey, orderColumns } from './relay-tables';

export type Tx = Prisma.TransactionClient;

/**
 * 받는 표 하나 — 원본 표와 MES 에 옮기는 법. 보통은 행 하나씩 반영하고, BOM 처럼 여러 행이
 * 한 MES 행(모품목의 BOM 판)을 이루면 `unitOf` 로 묶어 한 트랜잭션에 반영한다.
 * ⛔ 값이 그대로면 아무것도 바꾸지 않는다 — 같은 행이 다시 와도 결과가 같아야 한다.
 */
export type InboundTable = RowTable | UnitTable;

export interface RowTable {
  readonly source: RelayTable;
  /** 커밋 뒤에 할 일을 돌려줄 수 있다 — 반영 트랜잭션을 길게 잡거나 그 실패로 반영을 되돌리지 않게. */
  apply(tx: Tx, row: RelayRow): Promise<void | AfterCommit>;
}

export type AfterCommit = () => Promise<void>;

export interface UnitTable {
  readonly source: RelayTable;
  /** 함께 반영할 행의 열쇠. 읽는 순서가 업무 키 순이라 같은 열쇠의 행은 붙어서 온다. */
  unitOf(row: RelayRow): string;
  applyUnit(tx: Tx, rows: RelayRow[]): Promise<void>;
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
/** 커밋 뒤 할 일을 이만큼 할 때마다 `afterBatch` 로 리스를 늘린다 — 한 건이 길어(자동 계획) 묶음 하나가 리스를 넘기지 않게. */
const AFTER_COMMIT_RENEW_EVERY = 20;

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

  /** `afterBatch` 는 묶음마다 부른다 — 실행기가 리스를 늘리고 멈출 때인지 보는 자리다. */
  async run(table: InboundTable, afterBatch?: () => Promise<void>): Promise<InboundResult> {
    const { source } = table;
    const quarantined = await this.quarantined(source);
    const blocked = new Set(quarantined.values());
    const result: InboundResult = { read: 0, applied: 0, failed: 0, held: 0 };

    for (let after: unknown[] | undefined; ;) {
      const rows = await this.relay.fetchPending(source, after, BATCH_SIZE);
      if (rows.length === 0) break;
      const full = rows.length === BATCH_SIZE;
      const units = unitsOf(table, rows, full);
      const taken = units.flat();
      result.read += taken.length;
      after = orderColumns(source).map((column) => taken[taken.length - 1][column]);

      const applied: number[] = [];
      const failures: [number, string][] = [];
      const afterCommits: AfterCommit[] = [];
      for (const unit of units) {
        const keys = unit.map((row) => businessKey(source, row));
        if (
          unit.some((row) => quarantined.has(row.MES_INF_ID)) ||
          keys.some((key) => blocked.has(key))
        ) {
          keys.forEach((key) => blocked.add(key));
          result.held += unit.length;
          continue;
        }
        try {
          const afterCommit = await this.prisma.$transaction(async (tx) => {
            const after = await ('applyUnit' in table ? table.applyUnit(tx, unit) : table.apply(tx, unit[0]));
            for (const row of unit) await recordDone(tx, source, row);
            return after;
          });
          applied.push(...unit.map((row) => row.MES_INF_ID));
          result.applied += unit.length;
          if (afterCommit) afterCommits.push(afterCommit);
        } catch (error) {
          keys.forEach((key) => blocked.add(key));
          result.failed += unit.length;
          for (const row of unit) {
            failures.push([row.MES_INF_ID, await recordFailure(this.prisma, source, row, error)]);
          }
        }
      }

      await this.relay.ack(source, applied);
      for (const [id, message] of failures) await this.relay.writeError(source, id, message);
      await afterBatch?.();
      await this.runAfterCommits(source, afterCommits, afterBatch);
      if (!full) break;
    }

    this.logger.log(
      `${source.name} 읽음 ${result.read} · 반영 ${result.applied} · 실패 ${result.failed} · 보류 ${result.held}`,
    );
    return result;
  }

  /**
   * 확인 표시를 마친 «뒤»에 돈다 — 반영은 이미 커밋·표시됐다. ⛔ 실패해도 그 행을 실패로 돌리지 않는다.
   * `afterBatch` 가 멈춤·리스 상실로 던지면 남은 일은 하지 않는다 — 자동 계획이면 그 오더는 「확인 필요」로 남는다.
   */
  private async runAfterCommits(source: RelayTable, afterCommits: AfterCommit[], afterBatch?: () => Promise<void>): Promise<void> {
    for (let index = 0; index < afterCommits.length; index += 1) {
      if (index > 0 && index % AFTER_COMMIT_RENEW_EVERY === 0) await afterBatch?.();
      await afterCommits[index]().catch((error: unknown) =>
        this.logger.warn(`${source.name} 반영 뒤 처리 실패 — ${error instanceof Error ? error.message : String(error)}`),
      );
    }
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

/**
 * 반영 단위로 나눈다. 꽉 찬 묶음의 마지막 단위는 다음 묶음에 이어질 수 있어 미룬다 — 커서가
 * 그 앞에서 멈추므로 다음 묶음이 처음부터 다시 읽는다. 묶음 전체가 한 단위면 미룰 곳이 없다
 * (모품목 하나의 구성품은 263행이 가장 많았다).
 */
export function unitsOf(table: InboundTable, rows: RelayRow[], full: boolean): RelayRow[][] {
  if (!('unitOf' in table)) return rows.map((row) => [row]);
  const units: RelayRow[][] = [];
  let current: string | undefined;
  for (const row of rows) {
    const unit = table.unitOf(row);
    if (unit !== current) units.push([]);
    units[units.length - 1].push(row);
    current = unit;
  }
  return full && units.length > 1 ? units.slice(0, -1) : units;
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
      // id 는 원본 행의 것이다 — 반영 전에는 MES 쪽 id 가 없다(계약: FK 가 아니다).
      target_type_code: source.targetTypeCode,
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
): Promise<string> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  const payload = payloadOf(source, row);
  await prisma.integration_message.upsert({
    where: { message_key: messageKey(source, row) },
    create: {
      message_key: messageKey(source, row),
      interface_code: source.interfaceCode,
      direction_code: INBOUND,
      target_type_code: source.targetTypeCode,
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
  return message;
}

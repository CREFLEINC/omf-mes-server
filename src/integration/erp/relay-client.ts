import * as mssql from 'mssql';

import { RelayRow, RelayTable, orderColumns } from './relay-tables';

export interface RelayConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  encrypt: boolean;
}

/** 이어 읽을 자리 — 마지막으로 읽은 행의 `orderColumns()` 값. */
export type RelayCursor = unknown[];

/**
 * ERP 중계 DB 연결.
 *
 * ⛔ Postgres 트랜잭션 안에서 부르지 않는다. ERP 가 느리면 그동안 PG 연결이 묶여 화면 요청이
 * 쓸 연결이 바닥난다.
 * 표·칸 이름은 `relay-tables.ts` 의 상수만 들어온다 — 값만 매개변수로 넘긴다.
 */
export class RelayClient {
  private pool?: Promise<mssql.ConnectionPool>;

  constructor(private readonly config: RelayConfig) {}

  /**
   * 미반영 행을 업무 키 순서로 `limit` 개. `after` 를 주면 그 뒤부터다.
   * 한 회차 안에서는 이 커서로 앞으로만 간다 — 실패·보류로 'N' 에 남은 행을 같은 회차에
   * 다시 읽지 않아 반복이 끝난다. 다음 회차는 처음부터 다시 읽는다.
   */
  async fetchPending(
    table: RelayTable,
    after: RelayCursor | undefined,
    limit: number,
  ): Promise<RelayRow[]> {
    const request = (await this.connect()).request();
    request.input('limit', mssql.Int, limit);
    const columns = orderColumns(table);
    const where = [`${table.flagColumn} = 'N'`];
    if (after !== undefined) where.push(keysetAfter(columns, after, request));
    const result = await request.query<RelayRow>(
      `SELECT TOP (@limit) * FROM dbo.${table.name} WHERE ${where.join(' AND ')} ORDER BY ${columns.join(', ')}`,
    );
    return result.recordset;
  }

  /** 반영한 행을 'Y' 로. 이미 'Y' 인 행은 건드리지 않는다. */
  async ack(table: RelayTable, ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const request = (await this.connect()).request();
    const params = ids.map((id, index) => {
      request.input(`id${index}`, mssql.BigInt, id);
      return `@id${index}`;
    });
    await request.query(
      `UPDATE dbo.${table.name} SET ${table.flagColumn} = 'Y' ` +
        `WHERE MES_INF_ID IN (${params.join(', ')}) AND ${table.flagColumn} = 'N'`,
    );
  }

  async close(): Promise<void> {
    const pool = this.pool;
    this.pool = undefined;
    if (pool !== undefined) await (await pool).close();
  }

  private connect(): Promise<mssql.ConnectionPool> {
    this.pool ??= new mssql.ConnectionPool({
      server: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      // 한 번에 한 표씩 순서대로 돈다 — 둘이면 충분하다.
      pool: { min: 0, max: 2 },
      connectionTimeout: 15_000,
      requestTimeout: 30_000,
      // 고객사 SQL Server 는 자체 서명 인증서다. 끄는 것은 ERP_DB_ENCRYPT=false 로만.
      options: { encrypt: this.config.encrypt, trustServerCertificate: true },
    })
      .connect()
      .catch((error: unknown) => {
        // 실패한 연결을 붙들고 있으면 다음 회차도 같은 실패를 돌려받는다.
        this.pool = undefined;
        throw error;
      });
    return this.pool;
  }
}

/**
 * `(c1, c2, …) > (v1, v2, …)` — SQL Server 에 행 값 비교가 없어 풀어 쓴다.
 * `c1 > v1 OR (c1 = v1 AND c2 > v2) OR …`. 비교는 ORDER BY 와 같은 정렬 규칙(DB 기본)을 따른다.
 */
export function keysetAfter(columns: string[], after: RelayCursor, request: mssql.Request): string {
  columns.forEach((_, index) => request.input(`after${index}`, after[index]));
  const terms = columns.map((column, index) => {
    const equals = columns.slice(0, index).map((previous, at) => `${previous} = @after${at}`);
    return `(${[...equals, `${column} > @after${index}`].join(' AND ')})`;
  });
  return `(${terms.join(' OR ')})`;
}

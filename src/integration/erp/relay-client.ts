import * as mssql from 'mssql';

import { RelayValue, RelayValues, relayKeyOf } from './outbound-rows';
import { RcvTable } from './rcv-tables';
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

/** 넣을 행 하나 — 예약이 키까지 채운 값. 작성·수정 칸은 넣을 때 붙인다. */
export interface RelayInsert {
  table: RcvTable;
  values: RelayValues;
}

/** 넣은 행의 ERP 처리 결과. */
export interface RelayReply {
  applied: boolean;
  documentNo: string | null;
  error: string | null;
}

/** 한 번에 키로 찾는 행 수 — 키 칸 7개(구매입고) × 50 = 매개변수 350, SQL Server 상한 2100 안이다. */
const REPLY_CHUNK = 50;

/** 중계 DB 에 남는 MES 쪽 작성·수정자. */
const MES_USER = 'MES';

/**
 * ERP 중계 DB 연결.
 *
 * ⛔ Postgres 트랜잭션 안에서 부르지 않는다. ERP 가 느리면 그동안 PG 연결이 묶여 화면 요청이
 * 쓸 연결이 바닥난다.
 * 표·칸 이름은 `relay-tables.ts`·`rcv-tables.ts` 의 상수만 들어온다 — 값만 매개변수로 넘긴다. 넣을 행의 칸 이름은
 * `columnName` 이 거른다.
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
    const applied = isSnd(table)
      ? `, MES_APPLY_DT = GETDATE(), MES_APPLY_ERROR = NULL${touched(request)}`
      : '';
    await request.query(
      `UPDATE dbo.${table.name} SET ${table.flagColumn} = 'Y'${applied} ` +
        `WHERE MES_INF_ID IN (${params.join(', ')}) AND ${table.flagColumn} = 'N'`,
    );
  }

  /**
   * 반영 실패 사유를 원본 행에 남긴다 — 플래그는 'N' 그대로라 다음 회차에 다시 잡힌다
   * (중계 DB 규약에 실패 플래그 값이 없다). TIG_DOWN 계열은 사유 칸이 없어 MES 기록에만 남는다.
   */
  async writeError(table: RelayTable, id: number, message: string): Promise<void> {
    if (!isSnd(table)) return;
    const request = (await this.connect()).request();
    request.input('id', mssql.BigInt, id);
    // varchar(500) 이다. 넘치면 UPDATE 가 통째로 실패한다.
    request.input('error', mssql.VarChar(500), message.slice(0, 500));
    await request.query(
      `UPDATE dbo.${table.name} SET MES_APPLY_ERROR = @error${touched(request)} ` +
        `WHERE MES_INF_ID = @id AND ${table.flagColumn} = 'N'`,
    );
  }

  /**
   * 묶음 하나(연계 메시지 하나)의 행을 한 트랜잭션으로 넣는다 — ERP 가 반쯤 들어간 묶음을 집어 가지 않게.
   * 키가 이미 있는 행은 넣지 않고 그 행의 MES_INF_ID 를 돌려준다 — 앞선 시도가 넣고 끊긴 것이다(키는 예약 때 정했다).
   * 돌려주는 MES_INF_ID 는 `rows` 순서다.
   */
  async insertRows(rows: readonly RelayInsert[]): Promise<number[]> {
    const transaction = new mssql.Transaction(await this.connect());
    await transaction.begin();
    try {
      const ids: number[] = [];
      for (const row of rows) ids.push(await insertOnce(transaction, row));
      await transaction.commit();
      return ids;
    } catch (error) {
      // 연결이 끊겼으면 되돌리기도 실패한다 — 그때는 서버가 트랜잭션을 버린다.
      await transaction.rollback().catch(() => undefined);
      throw error;
    }
  }

  /**
   * ERP 가 거절한 행을 그 자리에서 고친다 — 키 칸 밖의 값을 덮고 오류 칸을 비운다. 처리 표시가 처음 값 그대로인 행만
   * 고친다: 그 사이 ERP 가 처리했으면 돌려주는 수가 0 이다. 한 트랜잭션이다.
   */
  async updateRows(rows: readonly RelayInsert[]): Promise<number[]> {
    const transaction = new mssql.Transaction(await this.connect());
    await transaction.begin();
    try {
      const counts: number[] = [];
      for (const row of rows) counts.push(await updateUntouched(transaction, row));
      await transaction.commit();
      return counts;
    } catch (error) {
      await transaction.rollback().catch(() => undefined);
      throw error;
    }
  }

  /** 그 건(`documentColumns`)의 마지막 IF_SEQ. 없으면 0. */
  async lastIfSeq(table: RcvTable, values: RelayValues): Promise<number> {
    const request = (await this.connect()).request();
    const where = table.documentColumns.map((column, index) => {
      bind(request, `d${index}`, values[column] ?? null);
      return `${column} = @d${index}`;
    });
    const result = await request.query<{ LAST_IF_SEQ: number | null }>(
      `SELECT MAX(IF_SEQ) AS LAST_IF_SEQ FROM dbo.${table.name} WHERE ${where.join(' AND ')}`,
    );
    return Number(result.recordset[0]?.LAST_IF_SEQ ?? 0);
  }

  /**
   * 넣은 행의 ERP 처리 결과 — `relay_key` → 결과. 행마다 PK 로 찾는다: MES_INF_ID 에는 인덱스가 없어 그것으로 찾으면
   * 고객 표를 통째로 훑는다. 중계 표에서 사라진 행은 결과에 없다.
   */
  async replies(table: RcvTable, rows: readonly RelayValues[]): Promise<Map<string, RelayReply>> {
    const replies = new Map<string, RelayReply>();
    const pool = await this.connect();
    for (let start = 0; start < rows.length; start += REPLY_CHUNK) {
      const request = pool.request();
      const where = rows.slice(start, start + REPLY_CHUNK).map((values, row) => {
        const terms = table.keyColumns.map((column, index) => {
          bind(request, `k${row}_${index}`, values[column] ?? null);
          return `${column} = @k${row}_${index}`;
        });
        return `(${terms.join(' AND ')})`;
      });
      const result = await request.query<RelayValues>(
        `SELECT ${table.keyColumns.join(', ')}, ${table.appliedFlag} AS APPLIED_FLAG, ` +
          `${table.replyColumn} AS REPLY_NO, ERP_APPLY_ERROR FROM dbo.${table.name} WHERE ${where.join(' OR ')}`,
      );
      for (const found of result.recordset) {
        replies.set(relayKeyOf(table, found), {
          applied: found.APPLIED_FLAG === 'Y',
          documentNo: blankToNull(found.REPLY_NO),
          error: blankToNull(found.ERP_APPLY_ERROR),
        });
      }
    }
    return replies;
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

function isSnd(table: RelayTable): boolean {
  return table.flagColumn === 'MES_APPLY_FLAG';
}

/** SND 계열은 행을 고친 쪽을 남긴다(NOT NULL). ERP 쪽에서 «MES 가 손댄 행»으로 보인다. */
function touched(request: mssql.Request): string {
  request.input('updtUser', mssql.VarChar(20), 'MES');
  return ', UPDT_USER_ID = @updtUser, UPDT_DT = GETDATE()';
}

/**
 * 키로 먼저 찾고(잠근 채) 없을 때만 넣는다.
 * 새 MES_INF_ID 는 `SCOPE_IDENTITY()` 로 읽는다 — `OUTPUT` 절은 표에 트리거가 있으면 실패하는데 고객 DB 의 트리거는 모른다.
 */
async function insertOnce(transaction: mssql.Transaction, { table, values }: RelayInsert): Promise<number> {
  const columns = Object.keys(values).map(columnName);
  const missing = table.keyColumns.filter((column) => !columns.includes(column));
  if (missing.length > 0) throw new Error(`${table.name} 에 키 칸 ${missing.join(', ')} 이 없다`);
  const bound = (): mssql.Request => {
    const request = transaction.request();
    columns.forEach((column, index) => bind(request, `v${index}`, values[column]));
    return request;
  };
  const param = (column: string): string => `@v${columns.indexOf(column)}`;

  const found = await bound().query<{ MES_INF_ID: number }>(
    `SELECT MES_INF_ID FROM dbo.${table.name} WITH (UPDLOCK, HOLDLOCK) ` +
      `WHERE ${table.keyColumns.map((column) => `${column} = ${param(column)}`).join(' AND ')}`,
  );
  if (found.recordset.length > 0) return Number(found.recordset[0].MES_INF_ID);

  const request = bound();
  request.input('user', mssql.VarChar(20), MES_USER);
  const inserted = await request.query<{ MES_INF_ID: number }>(
    `INSERT INTO dbo.${table.name} (${columns.join(', ')}, INSRT_USER_ID, INSRT_DT, UPDT_USER_ID, UPDT_DT) ` +
      `VALUES (${columns.map(param).join(', ')}, @user, GETDATE(), @user, GETDATE()); ` +
      'SELECT CAST(SCOPE_IDENTITY() AS bigint) AS MES_INF_ID',
  );
  return Number(inserted.recordset[0].MES_INF_ID);
}

/**
 * 중계 DB 에 못 닿았거나 도중에 끊겼다 — 다시 하면 될 일이다. SQL Server 가 «거절»한 것(`EREQUEST` — 칸 길이·형식 등)은
 * 데이터 문제라 사람이 본다. 교착(1205)·잠금 시간 초과(1222)는 거절이 아니라 다시 할 일이다.
 */
export function relayUnreachable(error: unknown): boolean {
  if (error instanceof mssql.ConnectionError || error instanceof mssql.TransactionError) return true;
  if (error instanceof mssql.RequestError) {
    return error.code !== 'EREQUEST' || error.number === 1205 || error.number === 1222;
  }
  return false;
}

function blankToNull(value: RelayValue): string | null {
  return value === null || String(value).trim() === '' ? null : String(value).trim();
}

async function updateUntouched(transaction: mssql.Transaction, { table, values }: RelayInsert): Promise<number> {
  const request = transaction.request();
  const columns = Object.keys(values).map(columnName);
  columns.forEach((column, index) => bind(request, `v${index}`, values[column]));
  const param = (column: string): string => `@v${columns.indexOf(column)}`;
  const flags = Object.keys(table.initialFlags);
  const set = columns.filter((column) => !table.keyColumns.includes(column) && !flags.includes(column));
  const where = [...table.keyColumns, ...flags].map((column) => `${column} = ${param(column)}`);
  request.input('user', mssql.VarChar(20), MES_USER);
  const result = await request.query(
    `UPDATE dbo.${table.name} SET ${set.map((column) => `${column} = ${param(column)}`).join(', ')}, ` +
      `ERP_APPLY_ERROR = NULL, UPDT_USER_ID = @user, UPDT_DT = GETDATE() WHERE ${where.join(' AND ')}`,
  );
  return result.rowsAffected[0] ?? 0;
}

/** 칸 이름은 SQL 에 그대로 들어간다 — 바꾸개가 만든 이름이라도 대문자·숫자·밑줄만 받는다. */
function columnName(column: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(column)) throw new Error(`중계 칸 이름이 아니다: ${column}`);
  return column;
}

/**
 * 문자열은 varchar 로 묶는다 — nvarchar 로 넘기면 varchar 키 칸 쪽이 변환돼 PK 를 못 탄다.
 * 정수가 아닌 수는 numeric(18,6)(중계 표의 수량 칸)이다. 바꾸개는 소수를 문자열로 넘기는 편이 정확하다.
 */
function bind(request: mssql.Request, name: string, value: RelayValue): void {
  if (value === null) request.input(name, mssql.VarChar(1), null);
  else if (typeof value === 'string') request.input(name, mssql.VarChar(8000), value);
  else if (Number.isInteger(value)) request.input(name, mssql.BigInt, value);
  else request.input(name, mssql.Decimal(18, 6), value);
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

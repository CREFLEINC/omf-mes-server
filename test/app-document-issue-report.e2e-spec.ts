import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { TOKEN_TYPE } from '../src/auth/session-resolver.service';
import { PrismaService } from '../src/prisma/prisma.service';

const TOKEN = randomUUID().replace(/-/g, '').slice(0, 8);
const PREFIX = `E2E_I27P3_${TOKEN}`;
const TARGET_BASE = 8_027_300_000_000n + BigInt(`0x${TOKEN}`);

function responseValidator(status: 200 | 422): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/app-공통.json'), 'utf8'),
  ) as object;
  const pointer =
    `/paths/~1app~1document-issues~1{documentIssueLogId}:report-print/post/` +
    `responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of [
    'int64',
    'int32',
    'double',
    'float',
    'binary',
    'password',
  ]) {
    ajv.addFormat(format, true);
  }
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({
    $ref: `https://omf-mes.invalid/contract#${pointer}`,
  });
}

describe('발행 인쇄 결과 보고 (I-27 P3 e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let issuerId: bigint;
  let reporterId: bigint;
  let otherReporterId: bigint;
  let issuerWorkerId: bigint;
  let reporterWorkerId: bigint;
  let reporterWorkerNo: string;
  let otherWorkerNo: string;
  let reporterCookie: string;
  let otherReporterCookie: string;
  let terminalToken: string;
  let otherTerminalToken: string;
  let issueOrdinal = 0n;
  const keys: string[] = [];
  const validateSuccess = responseValidator(200);
  const validateUnprocessable = responseValidator(422);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await makeFixture(app.get(JwtService));
  });

  afterAll(async () => {
    try {
      await cleanup();
      expect(
        await Promise.all([
          prisma.document_issue_log.count({
            where: { remarks: { startsWith: PREFIX } },
          }),
          prisma.idempotency_record.count({
            where: { idempotency_key: { in: keys } },
          }),
          prisma.worker.count({
            where: { worker_no: { startsWith: PREFIX } },
          }),
          prisma.app_user.count({
            where: { login_id: { startsWith: PREFIX } },
          }),
          prisma.terminal.count({
            where: { terminal_code: { startsWith: PREFIX } },
          }),
        ]),
      ).toEqual([0, 0, 0, 0, 0]);
    } finally {
      await app?.close();
    }
  });

  it('권한 역할 없이 PENDING을 SUCCEEDED로 보고하고 발행·보고 귀속과 계약 응답을 보존한다', async () => {
    const issue = await createIssue();
    const before = new Date();
    const response = await report(issue.document_issue_log_id, {
      outcome: 'SUCCEEDED',
      failureReason: ' \t ',
    }).expect(200);
    const after = new Date();

    expect(validateSuccess(response.body)).toBe(true);
    expect(validateSuccess.errors ?? []).toEqual([]);
    expect(response.body).toMatchObject({
      documentIssueLogId: Number(issue.document_issue_log_id),
      issuedBy: Number(issuerId),
      issuedByName: 'P3 발행 계정',
      printOutcome: 'SUCCEEDED',
    });
    const stored = await storedIssue(issue.document_issue_log_id);
    expect(stored).toMatchObject({
      issued_by: issuerId,
      issued_worker_id: issuerWorkerId,
      print_outcome_code: 'SUCCEEDED',
      print_failure_reason: null,
      print_reported_worker_id: reporterWorkerId,
      print_reported_by: reporterId,
    });
    expect(stored.print_reported_at).not.toBeNull();
    expect(stored.print_reported_at?.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
    expect(stored.print_reported_at?.getTime()).toBeLessThanOrEqual(
      after.getTime(),
    );
  });

  /**
   * ⭐ D7 — 「한 번만」이 아니라 「성공만 잠근다」다. `P-02-04` 의 [발행된 라벨 다시 인쇄]는
   * 새 회차를 만들지 않고 같은 발행 기록을 다시 찍으므로, 그 결과를 보고할 길이 없으면
   * 프린터가 한 번 죽은 LOT 은 영영 마감되지 않는다.
   */
  it('⭐ FAILED 뒤 SUCCEEDED 보고는 200 이고 사유가 지워진다', async () => {
    const issue = await createIssue();
    await report(issue.document_issue_log_id, {
      outcome: 'FAILED',
      failureReason: '프린터 응답 없음',
    }).expect(200);

    const retried = await report(issue.document_issue_log_id, { outcome: 'SUCCEEDED' }).expect(200);

    expect(retried.body.printOutcome).toBe('SUCCEEDED');
    expect(await storedIssue(issue.document_issue_log_id)).toMatchObject({
      print_outcome_code: 'SUCCEEDED',
      print_failure_reason: null,
    });
  });

  it('⭐ FAILED 뒤 새 사유의 FAILED 보고도 200 이고 사유가 갱신된다', async () => {
    const issue = await createIssue();
    await report(issue.document_issue_log_id, {
      outcome: 'FAILED',
      failureReason: '프린터 응답 없음',
    }).expect(200);

    await report(issue.document_issue_log_id, {
      outcome: 'FAILED',
      failureReason: '용지 없음',
    }).expect(200);

    expect(await storedIssue(issue.document_issue_log_id)).toMatchObject({
      print_outcome_code: 'FAILED',
      print_failure_reason: '용지 없음',
    });
  });

  it('⛔ SUCCEEDED 뒤의 보고는 422 STATE_LOCKED 이고 기록이 그대로다', async () => {
    const issue = await createIssue();
    await report(issue.document_issue_log_id, { outcome: 'SUCCEEDED' }).expect(200);

    const rejected = await report(issue.document_issue_log_id, {
      outcome: 'FAILED',
      failureReason: '되돌리기 시도',
    }).expect(422);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'outcome', code: 'STATE_LOCKED' });
    expect(await storedIssue(issue.document_issue_log_id)).toMatchObject({
      print_outcome_code: 'SUCCEEDED',
      print_failure_reason: null,
    });
  });

  it('FAILED 사유 원문을 보존하고 후속 재발행 PENDING이 이전 실패를 덮지 않는다', async () => {
    const first = await createIssue();
    await report(first.document_issue_log_id, {
      outcome: 'FAILED',
      failureReason: '  용지 걸림  ',
    }).expect(200);
    const second = await createIssue({
      targetId: first.target_id,
      issueSeq: 2,
    });
    expect(await storedIssue(first.document_issue_log_id)).toMatchObject({
      print_outcome_code: 'FAILED',
      print_failure_reason: '  용지 걸림  ',
    });
    expect(second).toMatchObject({
      issue_seq: 2,
      print_outcome_code: 'PENDING',
    });
  });

  it.each([
    [{ outcome: 'FAILED' }, 'REQUIRED'],
    [{ outcome: 'FAILED', failureReason: null }, 'REQUIRED'],
    [{ outcome: 'FAILED', failureReason: '\t\n' }, 'REQUIRED'],
    [{ outcome: 'SUCCEEDED', failureReason: '용지 걸림' }, 'INVALID'],
  ])(
    '사유 교차 규칙 %p는 422 %s이며 행을 바꾸지 않는다',
    async (body, code) => {
      const issue = await createIssue();
      const response = await report(issue.document_issue_log_id, body).expect(
        422,
      );
      expect(validateUnprocessable(response.body)).toBe(true);
      expect(response.body.errors).toEqual([
        expect.objectContaining({ field: 'failureReason', code }),
      ]);
      expect(await storedIssue(issue.document_issue_log_id)).toMatchObject({
        print_outcome_code: 'PENDING',
        print_reported_at: null,
        print_reported_worker_id: null,
        print_reported_by: null,
      });
    },
  );

  it('과거 NULL 결과는 500 저장 결손이고, 없는 행은 404다', async () => {
    const legacy = await createIssue({ outcome: null });
    const legacyKey = newKey();
    await report(
      legacy.document_issue_log_id,
      { outcome: 'SUCCEEDED' },
      { key: legacyKey },
    ).expect(500);
    expect(
      await prisma.idempotency_record.findUnique({
        where: { idempotency_key: legacyKey },
      }),
    ).toBeNull();
    await report(TARGET_BASE + 9_000_000n, { outcome: 'SUCCEEDED' }).expect(
      404,
    );
  });

  it('이미 완료된 행은 새 키로 422 STATE_LOCKED, 같은 키로 저장된 200을 재생한다', async () => {
    const issue = await createIssue();
    const key = newKey();
    const first = await report(
      issue.document_issue_log_id,
      { outcome: 'SUCCEEDED' },
      { key },
    ).expect(200);
    const replay = await report(
      issue.document_issue_log_id,
      { outcome: 'SUCCEEDED' },
      { key },
    ).expect(200);
    expect(replay.body).toEqual(first.body);

    const locked = await report(issue.document_issue_log_id, {
      outcome: 'SUCCEEDED',
    }).expect(422);
    expect(locked.body.errors).toEqual([
      expect.objectContaining({ field: 'outcome', code: 'STATE_LOCKED' }),
    ]);
  });

  it('같은 키의 body·계정·작업자·단말·path 변경은 모두 409다', async () => {
    const issue = await createIssue();
    const otherIssue = await createIssue();
    const key = newKey();
    await report(
      issue.document_issue_log_id,
      { outcome: 'SUCCEEDED' },
      { key, terminal: terminalToken },
    ).expect(200);

    await report(
      issue.document_issue_log_id,
      { outcome: 'FAILED', failureReason: '다른 본문' },
      { key, terminal: terminalToken },
    ).expect(409);
    await report(
      issue.document_issue_log_id,
      { outcome: 'SUCCEEDED' },
      { key, cookie: otherReporterCookie, terminal: terminalToken },
    ).expect(409);
    await report(
      issue.document_issue_log_id,
      { outcome: 'SUCCEEDED' },
      { key, workerNo: otherWorkerNo, terminal: terminalToken },
    ).expect(409);
    await report(
      issue.document_issue_log_id,
      { outcome: 'SUCCEEDED' },
      { key, terminal: otherTerminalToken },
    ).expect(409);
    await report(
      otherIssue.document_issue_log_id,
      { outcome: 'SUCCEEDED' },
      { key, terminal: terminalToken },
    ).expect(409);
    expect(
      (await storedIssue(otherIssue.document_issue_log_id)).print_outcome_code,
    ).toBe('PENDING');
  });

  it('유효하지 않은 단말 토큰은 완료 키 재생보다 먼저 400으로 거부한다', async () => {
    const issue = await createIssue();
    const key = newKey();
    await report(
      issue.document_issue_log_id,
      { outcome: 'SUCCEEDED' },
      { key, terminal: terminalToken },
    ).expect(200);
    await report(
      issue.document_issue_log_id,
      { outcome: 'SUCCEEDED' },
      { key, terminal: `${terminalToken}broken` },
    ).expect(400);
  });

  it('작업자 헤더는 필수·50자 제한이며 미존재 사번은 업무 트랜잭션 안에서 400이다', async () => {
    const issue = await createIssue();
    await report(
      issue.document_issue_log_id,
      { outcome: 'SUCCEEDED' },
      {
        workerNo: undefined,
      },
    ).expect(400);
    await report(
      issue.document_issue_log_id,
      { outcome: 'SUCCEEDED' },
      {
        workerNo: 'X'.repeat(51),
      },
    ).expect(400);
    const key = newKey();
    const missing = await report(
      issue.document_issue_log_id,
      { outcome: 'SUCCEEDED' },
      { key, workerNo: `${PREFIX}_MISSING` },
    ).expect(400);
    expect(missing.body.errors).toEqual([
      expect.objectContaining({ field: 'X-Worker-No', code: 'INVALID' }),
    ]);
    expect(
      await prisma.idempotency_record.findUnique({
        where: { idempotency_key: key },
      }),
    ).toBeNull();
    expect(
      (await storedIssue(issue.document_issue_log_id)).print_outcome_code,
    ).toBe('PENDING');
  });

  it('서로 다른 키의 동시 상반 보고는 한 건만 200이고 다른 한 건은 422다', async () => {
    const issue = await createIssue();
    const firstKey = newKey();
    const secondKey = newKey();
    const responses = await Promise.all([
      report(
        issue.document_issue_log_id,
        { outcome: 'SUCCEEDED' },
        { key: firstKey },
      ),
      report(
        issue.document_issue_log_id,
        { outcome: 'FAILED', failureReason: '동시 실패' },
        { key: secondKey },
      ),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 422,
    ]);
    expect(['SUCCEEDED', 'FAILED']).toContain(
      (await storedIssue(issue.document_issue_log_id)).print_outcome_code,
    );
    expect(
      await prisma.idempotency_record.count({
        where: {
          idempotency_key: { in: [firstKey, secondKey] },
          status: 'COMPLETED',
        },
      }),
    ).toBe(1);
  });

  it('멱등 완료 응답 저장 실패는 보고까지 롤백하고 같은 키 재시도가 실행된다', async () => {
    const issue = await createIssue();
    const key = newKey();
    const runTransaction = prisma.$transaction.bind(prisma);
    const transactionSpy = jest
      .spyOn(prisma, '$transaction')
      .mockImplementationOnce(async (work) =>
        runTransaction(async (tx) => {
          const completionSpy = jest
            .spyOn(tx.idempotency_record, 'update')
            .mockRejectedValueOnce(new Error('I27_P3_COMPLETION_FAILURE'));
          try {
            return await (
              work as (
                transaction: Prisma.TransactionClient,
              ) => Promise<unknown>
            )(tx);
          } finally {
            expect(completionSpy).toHaveBeenCalledWith({
              where: { idempotency_key: key },
              data: expect.objectContaining({
                status: 'COMPLETED',
                response_status: 200,
              }),
            });
            completionSpy.mockRestore();
          }
        }),
      );
    try {
      await report(
        issue.document_issue_log_id,
        { outcome: 'SUCCEEDED' },
        { key },
      ).expect(500);
    } finally {
      transactionSpy.mockRestore();
    }
    expect(
      (await storedIssue(issue.document_issue_log_id)).print_outcome_code,
    ).toBe('PENDING');
    expect(
      await prisma.idempotency_record.findUnique({
        where: { idempotency_key: key },
      }),
    ).toBeNull();
    await report(
      issue.document_issue_log_id,
      { outcome: 'SUCCEEDED' },
      { key },
    ).expect(200);
  });

  it('인증·계약·멱등 헤더 검증은 업무 처리 전에 각각 401·400으로 끝난다', async () => {
    const issue = await createIssue();
    await report(
      issue.document_issue_log_id,
      { outcome: 'SUCCEEDED' },
      {
        cookie: undefined,
      },
    ).expect(401);
    await report(issue.document_issue_log_id, { outcome: 'UNKNOWN' }).expect(
      400,
    );
    await request(app.getHttpServer())
      .post(pathOf(issue.document_issue_log_id))
      .set('Cookie', reporterCookie)
      .set('X-Worker-No', reporterWorkerNo)
      .send({ outcome: 'SUCCEEDED' })
      .expect(400);
    await report(9_007_199_254_740_992n, { outcome: 'SUCCEEDED' }).expect(400);
    expect(
      (await storedIssue(issue.document_issue_log_id)).print_outcome_code,
    ).toBe('PENDING');
  });

  function report(
    id: bigint,
    body: Record<string, unknown>,
    options: {
      key?: string;
      cookie?: string;
      workerNo?: string;
      terminal?: string;
    } = {},
  ): request.Test {
    const operation = request(app.getHttpServer())
      .post(pathOf(id))
      .set('Idempotency-Key', options.key ?? newKey())
      .send(body);
    const cookie = Object.prototype.hasOwnProperty.call(options, 'cookie')
      ? options.cookie
      : reporterCookie;
    const workerNo = Object.prototype.hasOwnProperty.call(options, 'workerNo')
      ? options.workerNo
      : reporterWorkerNo;
    if (cookie !== undefined) operation.set('Cookie', cookie);
    if (workerNo !== undefined) operation.set('X-Worker-No', workerNo);
    if (options.terminal !== undefined) {
      operation.set('Authorization', `Bearer ${options.terminal}`);
    }
    return operation;
  }

  function pathOf(id: bigint): string {
    return `/api/app/document-issues/${id}:report-print`;
  }

  function newKey(): string {
    const key = randomUUID();
    keys.push(key);
    return key;
  }

  async function createIssue(
    options: {
      targetId?: bigint;
      issueSeq?: number;
      outcome?: 'PENDING' | null;
    } = {},
  ) {
    issueOrdinal += 1n;
    return prisma.document_issue_log.create({
      data: {
        document_type_code: 'LOCATION_LABEL',
        target_type_code: 'LOCATION',
        target_id: options.targetId ?? TARGET_BASE + issueOrdinal,
        issue_seq: options.issueSeq ?? 1,
        reissue_reason_code:
          (options.issueSeq ?? 1) >= 2 ? 'PRINT_FAILURE' : null,
        issued_by: issuerId,
        issued_worker_id: issuerWorkerId,
        printer_name: `${PREFIX}_PRINTER`,
        remarks: `${PREFIX}_${issueOrdinal}`,
        print_outcome_code:
          options.outcome === undefined ? 'PENDING' : options.outcome,
      },
    });
  }

  function storedIssue(id: bigint) {
    return prisma.document_issue_log.findUniqueOrThrow({
      where: { document_issue_log_id: id },
    });
  }

  async function makeFixture(jwt: JwtService): Promise<void> {
    const plant = await prisma.plant.findFirstOrThrow({
      orderBy: { plant_id: 'asc' },
    });
    const businessUnit = await prisma.business_unit.findFirstOrThrow({
      orderBy: { business_unit_id: 'asc' },
    });
    const users = await Promise.all(
      [
        ['ISSUER', 'P3 발행 계정'],
        ['REPORTER', 'P3 보고 계정'],
        ['OTHER', 'P3 다른 보고 계정'],
      ].map(([suffix, name]) =>
        prisma.app_user.create({
          data: {
            login_id: `${PREFIX}_${suffix}`,
            user_name: name,
            status_code: 'EMPLOYED',
          },
        }),
      ),
    );
    [issuerId, reporterId, otherReporterId] = users.map(
      (user) => user.app_user_id,
    );
    reporterCookie = `${SESSION_COOKIE}=${jwt.sign({
      sub: Number(reporterId),
      typ: TOKEN_TYPE.SESSION,
    })}`;
    otherReporterCookie = `${SESSION_COOKIE}=${jwt.sign({
      sub: Number(otherReporterId),
      typ: TOKEN_TYPE.SESSION,
    })}`;

    const issuer = await prisma.worker.create({
      data: {
        worker_no: `${PREFIX}_ISSUER`,
        worker_name: 'P3 발행 작업자',
        business_unit_id: businessUnit.business_unit_id,
        plant_id: plant.plant_id,
        app_user_id: issuerId,
        status_code: 'EMPLOYED',
      },
    });
    issuerWorkerId = issuer.worker_id;
    reporterWorkerNo = `${PREFIX}_REPORTER`;
    const reporter = await prisma.worker.create({
      data: {
        worker_no: reporterWorkerNo,
        worker_name: 'P3 보고 작업자',
        business_unit_id: businessUnit.business_unit_id,
        plant_id: plant.plant_id,
        app_user_id: null,
        status_code: 'TERMINATED',
        is_active: false,
      },
    });
    reporterWorkerId = reporter.worker_id;
    otherWorkerNo = `${PREFIX}_OTHER`;
    await prisma.worker.create({
      data: {
        worker_no: otherWorkerNo,
        worker_name: 'P3 다른 작업자',
        business_unit_id: businessUnit.business_unit_id,
        plant_id: plant.plant_id,
        status_code: 'EMPLOYED',
      },
    });

    const terminals = await Promise.all(
      ['T1', 'T2'].map((suffix) =>
        prisma.terminal.create({
          data: {
            terminal_code: `${PREFIX}_${suffix}`,
            plant_id: plant.plant_id,
            terminal_type_code: 'POP',
            status_code: 'ACTIVE',
          },
        }),
      ),
    );
    [terminalToken, otherTerminalToken] = terminals.map((terminal) =>
      jwt.sign({
        sub: Number(terminal.terminal_id),
        typ: TOKEN_TYPE.TERMINAL,
        tv: terminal.token_version,
      }),
    );
  }

  async function cleanup(): Promise<void> {
    if (!prisma) return;
    const users = await prisma.app_user.findMany({
      where: { login_id: { startsWith: PREFIX } },
      select: { app_user_id: true },
    });
    const userIds = users.map((user) => user.app_user_id);
    await prisma.idempotency_record.deleteMany({
      where: {
        OR: [
          { idempotency_key: { in: keys } },
          { app_user_id: { in: userIds } },
        ],
      },
    });
    await prisma.document_issue_log.deleteMany({
      where: {
        OR: [
          { remarks: { startsWith: PREFIX } },
          { issued_by: { in: userIds } },
          { print_reported_by: { in: userIds } },
        ],
      },
    });
    await prisma.terminal.deleteMany({
      where: { terminal_code: { startsWith: PREFIX } },
    });
    await prisma.worker.deleteMany({
      where: { worker_no: { startsWith: PREFIX } },
    });
    await prisma.app_user.deleteMany({
      where: { login_id: { startsWith: PREFIX } },
    });
  }
});

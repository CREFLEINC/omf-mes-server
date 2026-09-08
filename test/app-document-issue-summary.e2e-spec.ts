import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

const TOKEN = randomUUID().replace(/-/g, '').slice(0, 8);
const PREFIX = `E2E_I27S_${TOKEN}`;
const PATH = '/api/app/document-issues/summary';
const BASE = 8_027_200_000_000n + BigInt(`0x${TOKEN}`);
const FIRST = BASE + 1n;
const LEGACY = BASE + 2n;
const MISSING = BASE + 3n;

interface SummaryItem {
  targetTypeCode: string;
  targetId: number;
  issueCount: number;
  lastIssueSeq: number | null;
  lastIssuedAt: string | null;
  lastPrintOutcome: string | null;
}

function responseValidator(): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/app-공통.json'), 'utf8'),
  ) as object;
  const pointer =
    '/paths/~1app~1document-issues~1summary/get/responses/200/content/application~1json/schema';
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

describe('발행 이력 요약 (I-27 P2 e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  let userId: bigint;

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
    } finally {
      await app?.close();
    }
  });

  it('정적 summary 경로와 scalar CSV 한 건이 실제 AppModule에서 계약 응답을 낸다', async () => {
    const body = await summary([FIRST]);
    expect(body.items).toHaveLength(1);
    const validate = responseValidator();
    expect(validate(body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('입력 ordinal과 중복 multiplicity를 그대로 보존한다', async () => {
    const body = await summary([LEGACY, FIRST, LEGACY]);
    expect(body.items.map((item) => item.targetId)).toEqual([
      Number(LEGACY),
      Number(FIRST),
      Number(LEGACY),
    ]);
  });

  it('미존재 대상과 0은 존재 조회 없이 count 0·last null이다', async () => {
    const body = await summary([MISSING, 0]);
    expect(body.items).toEqual([emptyItem(Number(MISSING)), emptyItem(0)]);
  });

  it('issueCount는 행 수이고 최신 세 필드는 tie-break된 같은 행에서 온다', async () => {
    const body = await summary([FIRST], 'MATERIAL_LOT_LABEL');
    expect(body.items[0]).toEqual({
      targetTypeCode: 'LOT',
      targetId: Number(FIRST),
      issueCount: 3,
      lastIssueSeq: 3,
      lastIssuedAt: '2091-01-02T00:00:00.000Z',
      lastPrintOutcome: 'PENDING',
    });
  });

  it('documentTypeCode를 빼면 모든 문서 종류를 세고 주면 정확히 거른다', async () => {
    const all = await summary([FIRST]);
    const material = await summary([FIRST], 'MATERIAL_LOT_LABEL');
    expect(all.items[0]).toMatchObject({ issueCount: 4, lastIssueSeq: 50 });
    expect(material.items[0]).toMatchObject({ issueCount: 3, lastIssueSeq: 3 });
  });

  it('같은 숫자의 다른 targetType 로그는 섞지 않는다', async () => {
    const body = await summary([FIRST], 'LOCATION_LABEL');
    expect(body.items).toEqual([emptyItem(Number(FIRST))]);
  });

  it('과거 NULL outcome은 count·seq·time을 보존한 정상 null이다', async () => {
    const body = await summary([LEGACY]);
    expect(body.items[0]).toEqual({
      targetTypeCode: 'LOT',
      targetId: Number(LEGACY),
      issueCount: 1,
      lastIssueSeq: 1,
      lastIssuedAt: '2091-01-04T00:00:00.000Z',
      lastPrintOutcome: null,
    });
  });

  it.each([
    ['', '빈 targetIds'],
    [`,${FIRST}`, '빈 token'],
  ])('%s는 token을 버리지 않고 계약 400으로 보낸다', async (targetIds) => {
    await request(app.getHttpServer())
      .get(PATH)
      .query({ targetTypeCode: 'LOT', targetIds })
      .set('Cookie', cookie)
      .expect(400);
  });

  it('repeated-key 배열 원소 안 CSV는 중첩 분해하지 않는다', async () => {
    await request(app.getHttpServer())
      .get(
        `${PATH}?targetTypeCode=LOT&targetIds=${FIRST}&targetIds=${LEGACY},${MISSING}`,
      )
      .set('Cookie', cookie)
      .expect(400);
  });

  it('CSV가 없는 repeated-key 배열은 그대로 검증해 원래 순서로 응답한다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${PATH}?targetTypeCode=LOT&targetIds=${LEGACY}&targetIds=${FIRST}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(
      response.body.items.map((item: SummaryItem) => item.targetId),
    ).toEqual([Number(LEGACY), Number(FIRST)]);
  });

  it.each([
    [`${PATH}?targetIds=${FIRST}`, 'targetTypeCode'],
    [`${PATH}?targetTypeCode=LOT`, 'targetIds'],
  ])('필수 query 누락은 400이다: %s', async (url, field) => {
    const response = await request(app.getHttpServer())
      .get(url)
      .set('Cookie', cookie)
      .expect(400);
    expect(response.body.errors).toEqual([
      expect.objectContaining({ field, code: 'REQUIRED' }),
    ]);
  });

  it('1000개는 한 SQL이고 원순서를 반환하며 1001개는 SQL 전 400이다', async () => {
    const thousand = Array.from({ length: 1000 }, (_, index) => index + 1);
    const raw = jest.spyOn(prisma, '$queryRaw');
    try {
      const body = await summary(thousand, undefined, 'INSPECTION_RESULT');
      expect(body.items.map((item) => item.targetId)).toEqual(thousand);
      expect(raw).toHaveBeenCalledTimes(1);
      raw.mockClear();
      await request(app.getHttpServer())
        .get(PATH)
        .query({
          targetTypeCode: 'INSPECTION_RESULT',
          targetIds: [...thousand, 1001].join(','),
        })
        .set('Cookie', cookie)
        .expect(400);
      expect(raw).not.toHaveBeenCalled();
    } finally {
      raw.mockRestore();
    }
  });

  it('JS 안전 정수 밖 int64 query는 SQL 전 400 RANGE다', async () => {
    const response = await request(app.getHttpServer())
      .get(PATH)
      .query({ targetTypeCode: 'LOT', targetIds: '9007199254740992' })
      .set('Cookie', cookie)
      .expect(400);
    expect(response.body.errors).toEqual([
      expect.objectContaining({ field: 'targetIds', code: 'RANGE' }),
    ]);
  });

  it('미인증 요청은 CSV 미들웨어를 지나도 계약 정보 대신 401이다', async () => {
    await request(app.getHttpServer())
      .get(PATH)
      .query({ targetTypeCode: 'LOT', targetIds: `${FIRST},${LEGACY}` })
      .expect(401);
  });

  async function summary(
    targetIds: (number | bigint)[],
    documentTypeCode?: string,
    targetTypeCode = 'LOT',
  ): Promise<{ items: SummaryItem[] }> {
    const response = await request(app.getHttpServer())
      .get(PATH)
      .query({
        targetTypeCode,
        targetIds: targetIds.join(','),
        ...(documentTypeCode === undefined ? {} : { documentTypeCode }),
      })
      .set('Cookie', cookie)
      .expect(200);
    return response.body;
  }

  function emptyItem(targetId: number): SummaryItem {
    return {
      targetTypeCode: 'LOT',
      targetId,
      issueCount: 0,
      lastIssueSeq: null,
      lastIssuedAt: null,
      lastPrintOutcome: null,
    };
  }

  async function makeFixture(jwt: JwtService): Promise<void> {
    const user = await prisma.app_user.create({
      data: {
        login_id: PREFIX,
        user_name: '발행요약검사 계정',
        status_code: 'EMPLOYED',
      },
    });
    userId = user.app_user_id;
    cookie = `${SESSION_COOKIE}=${jwt.sign({ sub: Number(userId), typ: 'session' })}`;
    await createLog(
      'MATERIAL_LOT_LABEL',
      FIRST,
      1,
      '2091-01-01T00:00:00Z',
      'PENDING',
    );
    await createLog(
      'MATERIAL_LOT_LABEL',
      FIRST,
      7,
      '2091-01-02T00:00:00Z',
      null,
    );
    await createLog(
      'MATERIAL_LOT_LABEL',
      FIRST,
      3,
      '2091-01-02T00:00:00Z',
      'PENDING',
    );
    await createLog('TOOL_LABEL', FIRST, 50, '2091-01-03T00:00:00Z', 'PENDING');
    await createLog(
      'MATERIAL_LOT_LABEL',
      LEGACY,
      1,
      '2091-01-04T00:00:00Z',
      null,
    );
    await prisma.document_issue_log.create({
      data: {
        document_type_code: 'LOCATION_LABEL',
        target_type_code: 'LOCATION',
        target_id: FIRST,
        issue_seq: 1,
        issued_by: userId,
        issued_at: new Date('2091-01-05T00:00:00Z'),
        remarks: PREFIX,
        print_outcome_code: 'PENDING',
      },
    });
  }

  async function createLog(
    documentType: string,
    targetId: bigint,
    issueSeq: number,
    issuedAt: string,
    outcome: 'PENDING' | 'SUCCEEDED' | 'FAILED' | null,
  ): Promise<void> {
    await prisma.document_issue_log.create({
      data: {
        document_type_code: documentType,
        target_type_code: 'LOT',
        target_id: targetId,
        issue_seq: issueSeq,
        reissue_reason_code: issueSeq === 1 ? null : 'PRINT_FAILURE',
        issued_by: userId,
        issued_at: new Date(issuedAt),
        remarks: PREFIX,
        print_outcome_code: outcome,
      },
    });
  }

  async function cleanup(): Promise<void> {
    if (!prisma) return;
    await prisma.document_issue_log.deleteMany({ where: { remarks: PREFIX } });
    await prisma.app_user.deleteMany({ where: { login_id: PREFIX } });
  }
});

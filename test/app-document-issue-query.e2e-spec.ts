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

const PREFIX = `E2E_I27_${randomUUID().slice(0, 8)}`;
const PATH = '/api/app/document-issues';
const JAN_FROM = '2090-01-01T00:00:00Z';
const JAN_TO = '2090-01-02T00:00:00Z';
const REASON = `${PREFIX}_R`;
const FALLBACK_BASE = 8_027_000_000_000n;

interface IssueBody {
  documentIssueLogId: number;
  documentTypeCode: string;
  target: {
    targetTypeCode: string;
    targetId: number;
    displayName: string;
    screenId?: string;
  };
  lotId: number | null;
  lotNo: string | null;
  issueSeq: number;
  reissueReasonCode: string | null;
  reissueReasonName: string | null;
  issuedBy: number;
  issuedByName: string;
  issuedAt: string;
  terminalId: number | null;
  printerName: string | null;
  printOutcome: string;
  remarks: string | null;
}

function validator(operation: string, status = 200): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/app-공통.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
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
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('발행 이력 목록·상세 (I-27 P1 e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  let userId: bigint;
  let workerId: bigint;
  let terminalId: bigint;
  let itemId: bigint;
  let lotId: bigint;
  let longLotId: bigint;
  let serialId: bigint;
  let handlingUnitId: bigint;
  let issueLineId: bigint;
  let moldId: bigint;
  let locationId: bigint;
  let inspectionResultId: bigint;
  let firstLotLogId: bigint;
  let secondLotLogId: bigint;
  let thirdLotLogId: bigint;
  let boundaryMiddleLogId: bigint;
  let fallbackLogId: bigint;
  let legacyLogId: bigint;
  let invalidLotLogId: bigint;
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

  it('target 쌍 중 하나만 주면 400 PAIR다', async () => {
    for (const query of ['targetTypeCode=LOT', `targetId=${lotId}`]) {
      const response = await request(app.getHttpServer())
        .get(`${PATH}?${query}`)
        .set('Cookie', cookie)
        .expect(400);
      expect(response.body.errors).toEqual([
        expect.objectContaining({ code: 'PAIR' }),
      ]);
    }
  });

  it('문서·대상쌍·LOT·기간·결과 필터를 AND로 적용한다', async () => {
    const response = await list({
      documentTypeCode: 'MATERIAL_LOT_LABEL',
      targetTypeCode: 'LOT',
      targetId: Number(lotId),
      lotId: Number(lotId),
      issuedFrom: JAN_FROM,
      issuedTo: JAN_TO,
      printOutcome: 'PENDING',
    });
    expect(response.items.map((item) => item.documentIssueLogId)).toEqual([
      Number(firstLotLogId),
    ]);

    const impossible = await list({
      documentTypeCode: 'LOCATION_LABEL',
      targetTypeCode: 'LOT',
      targetId: Number(lotId),
      printOutcome: 'SUCCEEDED',
    });
    expect(impossible.items).toEqual([]);
  });

  it('target 유형과 ID를 각각 적용해 숫자가 겹치는 다른 유형을 섞지 않는다', async () => {
    const response = await list({
      targetTypeCode: 'LOT',
      targetId: Number(lotId),
    });
    expect(response.items.map((item) => item.documentIssueLogId)).toEqual([
      Number(thirdLotLogId),
      Number(secondLotLogId),
      Number(firstLotLogId),
    ]);
  });

  it('같은 issued_at은 document_issue_log_id DESC로 닫고 inactive 과거 사유명도 표시한다', async () => {
    const response = await list({
      targetTypeCode: 'LOT',
      targetId: Number(lotId),
      issuedFrom: JAN_FROM,
      issuedTo: JAN_TO,
    });
    expect(response.items.map((item) => item.documentIssueLogId)).toEqual([
      Number(thirdLotLogId),
      Number(secondLotLogId),
      Number(firstLotLogId),
    ]);
    expect(
      response.items.find(
        (item) => item.documentIssueLogId === Number(secondLotLogId),
      ),
    ).toMatchObject({
      issueSeq: 2,
      reissueReasonCode: REASON,
      reissueReasonName: '비활성 과거 사유',
      printOutcome: 'FAILED',
    });
  });

  it('7종 대상 이름과 screenId를 묶어 내고 응답 계약·선택 필드를 지킨다', async () => {
    const response = await list({
      issuedFrom: JAN_FROM,
      issuedTo: JAN_TO,
      size: 50,
    });
    const byType = new Map(
      response.items.map((item) => [item.target.targetTypeCode, item.target]),
    );
    expect(byType).toEqual(
      new Map([
        [
          'LOT',
          expect.objectContaining({
            displayName: `${PREFIX}-LOT`,
            screenId: 'P-02-07',
          }),
        ],
        [
          'SERIAL_NUMBER',
          expect.objectContaining({
            displayName: `${PREFIX}-SERIAL`,
            screenId: 'P-02-05',
          }),
        ],
        [
          'HANDLING_UNIT',
          expect.objectContaining({
            displayName: `${PREFIX}-HU`,
            screenId: 'P-02-09',
          }),
        ],
        [
          'GOODS_ISSUE_LINE',
          expect.objectContaining({
            displayName: `${PREFIX}-GI #1`,
            screenId: 'P-01-02',
          }),
        ],
        [
          'MOLD',
          expect.objectContaining({
            displayName: `${PREFIX}-MOLD-NAME`,
            screenId: 'W-05-13',
          }),
        ],
        [
          'LOCATION',
          expect.objectContaining({
            displayName: `${PREFIX}-LOCATION-NAME`,
            screenId: 'W-06-07',
          }),
        ],
        [
          'INSPECTION_RESULT',
          expect.objectContaining({
            displayName: `${PREFIX}-IR`,
            screenId: 'W-04-03',
          }),
        ],
      ]),
    );
    const validate = validator('GET /app/document-issues');
    expect(validate(response)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    const lot = response.items.find(
      (item) => item.documentIssueLogId === Number(firstLotLogId),
    );
    expect(lot).toMatchObject({
      lotId: Number(lotId),
      lotNo: `${PREFIX}-LOT`,
      issuedBy: Number(userId),
      issuedByName: '발행이력검사 계정',
      terminalId: Number(terminalId),
      printerName: `${PREFIX}-PRINTER`,
      printOutcome: 'PENDING',
    });
    expect(lot && 'terminalName' in lot).toBe(false);
  });

  it('LOT 필터는 저장 lot_id만 보고 HU 내용물을 역추적하지 않는다', async () => {
    const response = await list({
      lotId: Number(lotId),
      issuedFrom: JAN_FROM,
      issuedTo: JAN_TO,
    });
    const types = response.items.map((item) => item.target.targetTypeCode);
    expect(types).toContain('SERIAL_NUMBER');
    expect(types).toContain('GOODS_ISSUE_LINE');
    expect(types).not.toContain('HANDLING_UNIT');
  });

  it('삭제된 대상은 TYPE #id fallback이고 screenId를 생략한다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${PATH}/${fallbackLogId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(response.body.target).toEqual({
      targetTypeCode: 'MOLD',
      targetId: Number(FALLBACK_BASE),
      displayName: `MOLD #${FALLBACK_BASE}`,
    });
  });

  it('상세는 계약을 만족하고 없는 기록은 404다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${PATH}/${secondLotLogId}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /app/document-issues/{documentIssueLogId}');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    await request(app.getHttpServer())
      .get(`${PATH}/${FALLBACK_BASE + 999n}`)
      .set('Cookie', cookie)
      .expect(404);
  });

  it('µs 이상 offset 경계도 >= from, < to로 보존한다', async () => {
    const response = await list({
      targetTypeCode: 'LOCATION',
      targetId: Number(FALLBACK_BASE + 3_000n),
      issuedFrom: '2090-07-01T07:00:00.0000001+07:00',
      issuedTo: '2090-07-01T07:00:00.0000011+07:00',
    });
    expect(response.items.map((item) => item.documentIssueLogId)).toEqual([
      Number(boundaryMiddleLogId),
    ]);
  });

  it('200행 페이지와 total을 함께 내고 다음 페이지에는 나머지 5행만 둔다', async () => {
    const query = {
      documentTypeCode: 'LOCATION_LABEL',
      issuedFrom: '2090-02-01T00:00:00Z',
      issuedTo: '2090-02-02T00:00:00Z',
      size: 200,
    };
    const first = await list(query);
    const second = await list({ ...query, page: 2 });
    expect(first.items).toHaveLength(200);
    expect(first.page).toEqual({ page: 1, size: 200, total: 205 });
    expect(second.items).toHaveLength(5);
    expect(second.page).toEqual({ page: 2, size: 200, total: 205 });
  });

  it.each([
    [`${PATH}?targetTypeCode=LOT&targetId=9007199254740992`, 'targetId'],
    [`${PATH}?lotId=9007199254740992`, 'lotId'],
    [`${PATH}/9007199254740992`, 'documentIssueLogId'],
  ])('unsafe query/path ID는 400 RANGE다: %s', async (url, field) => {
    const response = await request(app.getHttpServer())
      .get(url)
      .set('Cookie', cookie)
      .expect(400);
    expect(response.body.errors).toEqual([
      expect.objectContaining({ field, code: 'RANGE' }),
    ]);
  });

  it.each([
    ['legacy NULL printOutcome', () => `${PATH}/${legacyLogId}`],
    ['lotNo 61자', () => `${PATH}/${invalidLotLogId}`],
    [
      'DB unsafe bigint',
      () =>
        `${PATH}?issuedFrom=2090-06-01T00:00:00Z&issuedTo=2090-06-02T00:00:00Z`,
    ],
  ])('%s 저장 결손은 숨기거나 보정하지 않고 500이다', async (_name, url) => {
    await request(app.getHttpServer())
      .get(url())
      .set('Cookie', cookie)
      .expect(500);
  });

  async function list(query: Record<string, string | number>): Promise<{
    items: IssueBody[];
    page: { page: number; size: number; total: number };
  }> {
    const response = await request(app.getHttpServer())
      .get(PATH)
      .query(query)
      .set('Cookie', cookie)
      .expect(200);
    return response.body;
  }

  async function makeFixture(jwt: JwtService): Promise<void> {
    const plant = await prisma.plant.findFirstOrThrow({
      orderBy: { plant_id: 'asc' },
    });
    const businessUnit = await prisma.business_unit.findFirstOrThrow({
      orderBy: { business_unit_id: 'asc' },
    });
    const uom = await prisma.uom.findFirstOrThrow({
      orderBy: { uom_id: 'asc' },
    });
    const user = await prisma.app_user.create({
      data: {
        login_id: PREFIX,
        user_name: '발행이력검사 계정',
        status_code: 'EMPLOYED',
      },
    });
    userId = user.app_user_id;
    cookie = `${SESSION_COOKIE}=${jwt.sign({ sub: Number(userId), typ: 'session' })}`;
    const worker = await prisma.worker.create({
      data: {
        worker_no: PREFIX,
        worker_name: '발행이력검사 작업자',
        business_unit_id: businessUnit.business_unit_id,
        plant_id: plant.plant_id,
        app_user_id: userId,
        status_code: 'EMPLOYED',
      },
    });
    workerId = worker.worker_id;
    const terminal = await prisma.terminal.create({
      data: {
        terminal_code: PREFIX,
        plant_id: plant.plant_id,
        terminal_type_code: 'POP',
        status_code: 'ACTIVE',
      },
    });
    terminalId = terminal.terminal_id;
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: businessUnit.business_unit_id,
        warehouse_code: PREFIX,
        warehouse_name: PREFIX,
        warehouse_type_code: 'RAW_MATERIAL',
        management_level_code: 'LOCATION',
      },
    });
    const location = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: PREFIX,
        location_name: `${PREFIX}-LOCATION-NAME`,
        location_type_code: 'STORAGE',
      },
    });
    locationId = location.location_id;
    const item = await prisma.item.create({
      data: {
        item_code: PREFIX,
        item_name: PREFIX,
        item_type_code: 'FINISHED_GOOD',
        base_uom_id: uom.uom_id,
        lot_control_type_code: 'LOT',
      },
    });
    itemId = item.item_id;
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT`,
        item_id: itemId,
        lot_type_code: 'MATERIAL',
        plant_id: plant.plant_id,
        initial_qty: 10,
        uom_id: uom.uom_id,
        source_type_code: 'TEST',
        source_id: 1,
        status_code: 'NORMAL',
      },
    });
    lotId = lot.lot_id;
    longLotId = (
      await prisma.lot.create({
        data: {
          lot_no: 'L'.repeat(61),
          item_id: itemId,
          lot_type_code: 'MATERIAL',
          plant_id: plant.plant_id,
          initial_qty: 1,
          uom_id: uom.uom_id,
          source_type_code: 'TEST',
          source_id: 2,
          status_code: 'NORMAL',
        },
      })
    ).lot_id;
    serialId = (
      await prisma.serial_number.create({
        data: {
          serial_no: `${PREFIX}-SERIAL`,
          item_id: itemId,
          lot_id: lotId,
          status_code: 'GOOD',
        },
      })
    ).serial_number_id;
    handlingUnitId = (
      await prisma.handling_unit.create({
        data: {
          handling_unit_no: `${PREFIX}-HU`,
          handling_unit_type_code: 'PALLET',
          warehouse_id: warehouse.warehouse_id,
          location_id: locationId,
          status_code: 'ACTIVE',
        },
      })
    ).handling_unit_id;
    const goodsIssue = await prisma.goods_issue.create({
      data: {
        goods_issue_no: `${PREFIX}-GI`,
        issue_type_code: 'OTHER',
        source_document_type_code: 'TEST',
        source_document_id: 1,
        source_warehouse_id: warehouse.warehouse_id,
        issued_at: new Date(JAN_FROM),
        status_code: 'POSTED',
      },
    });
    issueLineId = (
      await prisma.goods_issue_line.create({
        data: {
          goods_issue_id: goodsIssue.goods_issue_id,
          line_no: 1,
          item_id: itemId,
          lot_id: lotId,
          issue_qty: 1,
          uom_id: uom.uom_id,
          source_location_id: locationId,
        },
      })
    ).goods_issue_line_id;
    moldId = (
      await prisma.mold.create({
        data: {
          plant_id: plant.plant_id,
          mold_code: PREFIX,
          mold_name: `${PREFIX}-MOLD-NAME`,
          status_code: 'IN_SERVICE',
          tool_type_code: 'MOLD',
        },
      })
    ).mold_id;
    const inspectionRequest = await prisma.inspection_request.create({
      data: {
        inspection_request_no: `${PREFIX}-IRQ`,
        inspection_type_code: 'FINAL',
        target_type_code: 'LOT',
        target_id: lotId,
        item_id: itemId,
        lot_id: lotId,
        target_qty: 1,
        uom_id: uom.uom_id,
        status_code: 'COMPLETED',
        requested_at: new Date(JAN_FROM),
      },
    });
    inspectionResultId = (
      await prisma.inspection_result.create({
        data: {
          inspection_result_no: `${PREFIX}-IR`,
          inspection_request_id: inspectionRequest.inspection_request_id,
          inspected_qty: 1,
          accepted_qty: 1,
          uom_id: uom.uom_id,
          overall_judgment_code: 'ACCEPTED',
          inspector_id: workerId,
          inspected_at: new Date(JAN_FROM),
          confirmed_at: new Date(JAN_FROM),
          status_code: 'CONFIRMED',
          idempotency_key: PREFIX,
        },
      })
    ).inspection_result_id;
    const reasonGroup = await prisma.code_group.findUniqueOrThrow({
      where: { group_code: 'REISSUE_REASON' },
    });
    await prisma.code_value.create({
      data: {
        code_group_id: reasonGroup.code_group_id,
        code: REASON,
        code_name: '비활성 과거 사유',
        is_active: false,
      },
    });

    firstLotLogId = await createLog({
      documentType: 'MATERIAL_LOT_LABEL',
      targetType: 'LOT',
      targetId: lotId,
      lotId,
      terminalId,
      issuedAt: '2090-01-01T00:00:00.000001Z',
    });
    secondLotLogId = await createLog({
      documentType: 'MATERIAL_LOT_LABEL',
      targetType: 'LOT',
      targetId: lotId,
      lotId,
      issueSeq: 2,
      reason: REASON,
      outcome: 'FAILED',
      issuedAt: '2090-01-01T00:00:00.000002Z',
    });
    thirdLotLogId = await createLog({
      documentType: 'MATERIAL_LOT_LABEL',
      targetType: 'LOT',
      targetId: lotId,
      lotId,
      issueSeq: 3,
      reason: REASON,
      outcome: 'SUCCEEDED',
      issuedAt: '2090-01-01T00:00:00.000002Z',
    });
    await createLog({
      documentType: 'TOOL_LABEL',
      targetType: 'MOLD',
      targetId: lotId,
      issuedAt: '2090-08-01T00:00:00Z',
    });
    await createLog({
      documentType: 'LOCATION_LABEL',
      targetType: 'LOCATION',
      targetId: FALLBACK_BASE + 3_000n,
      issuedAt: '2090-07-01T00:00:00.000000Z',
    });
    boundaryMiddleLogId = await createLog({
      documentType: 'LOCATION_LABEL',
      targetType: 'LOCATION',
      targetId: FALLBACK_BASE + 3_000n,
      issueSeq: 2,
      reason: REASON,
      issuedAt: '2090-07-01T00:00:00.000001Z',
    });
    await createLog({
      documentType: 'LOCATION_LABEL',
      targetType: 'LOCATION',
      targetId: FALLBACK_BASE + 3_000n,
      issueSeq: 3,
      reason: REASON,
      issuedAt: '2090-07-01T00:00:00.000002Z',
    });
    await createLog({
      documentType: 'IDENTIFICATION_TAG',
      targetType: 'SERIAL_NUMBER',
      targetId: serialId,
      lotId,
      issuedAt: '2090-01-01T00:00:01Z',
    });
    await createLog({
      documentType: 'PACKING_LABEL',
      targetType: 'HANDLING_UNIT',
      targetId: handlingUnitId,
      issuedAt: '2090-01-01T00:00:02Z',
    });
    await createLog({
      documentType: 'GOODS_ISSUE_QR',
      targetType: 'GOODS_ISSUE_LINE',
      targetId: issueLineId,
      lotId,
      issuedAt: '2090-01-01T00:00:03Z',
    });
    await createLog({
      documentType: 'TOOL_LABEL',
      targetType: 'MOLD',
      targetId: moldId,
      issuedAt: '2090-01-01T00:00:04Z',
    });
    await createLog({
      documentType: 'LOCATION_LABEL',
      targetType: 'LOCATION',
      targetId: locationId,
      issuedAt: '2090-01-01T00:00:05Z',
    });
    await createLog({
      documentType: 'CERTIFICATE_OF_ANALYSIS',
      targetType: 'INSPECTION_RESULT',
      targetId: inspectionResultId,
      lotId,
      issuedAt: '2090-01-01T00:00:06Z',
    });
    fallbackLogId = await createLog({
      documentType: 'TOOL_LABEL',
      targetType: 'MOLD',
      targetId: FALLBACK_BASE,
      issuedAt: '2090-03-01T00:00:00Z',
    });
    legacyLogId = await createLog({
      documentType: 'LOCATION_LABEL',
      targetType: 'LOCATION',
      targetId: FALLBACK_BASE + 1n,
      issuedAt: '2090-04-01T00:00:00Z',
      outcome: null,
    });
    invalidLotLogId = await createLog({
      documentType: 'MATERIAL_LOT_LABEL',
      targetType: 'LOT',
      targetId: longLotId,
      lotId: longLotId,
      issuedAt: '2090-05-01T00:00:00Z',
    });
    await prisma.$executeRaw`INSERT INTO app.document_issue_log
      (document_issue_log_id, document_type_code, target_type_code, target_id,
       issue_seq, issued_by, issued_at, printer_name, remarks, print_outcome_code,
       issued_worker_id)
      OVERRIDING SYSTEM VALUE
      VALUES (${BigInt(Number.MAX_SAFE_INTEGER) + 1n}, 'LOCATION_LABEL', 'LOCATION',
              ${FALLBACK_BASE + 2n}, 1, ${userId}, '2090-06-01T00:00:00Z'::timestamptz,
              ${`${PREFIX}-PRINTER`}, ${PREFIX}, 'PENDING', ${workerId})`;
    await prisma.document_issue_log.createMany({
      data: Array.from({ length: 205 }, (_, index) => ({
        document_type_code: 'LOCATION_LABEL',
        target_type_code: 'LOCATION',
        target_id: FALLBACK_BASE + 100n + BigInt(index),
        issue_seq: 1,
        issued_by: userId,
        issued_at: new Date('2090-02-01T00:00:00Z'),
        printer_name: `${PREFIX}-PRINTER`,
        remarks: PREFIX,
        print_outcome_code: 'PENDING',
        issued_worker_id: workerId,
      })),
    });
  }

  async function createLog(input: {
    documentType: string;
    targetType: string;
    targetId: bigint;
    lotId?: bigint;
    terminalId?: bigint;
    issueSeq?: number;
    reason?: string;
    outcome?: 'PENDING' | 'SUCCEEDED' | 'FAILED' | null;
    issuedAt: string;
  }): Promise<bigint> {
    const outcome = input.outcome === undefined ? 'PENDING' : input.outcome;
    const failed = outcome === 'FAILED';
    const reported = outcome === 'SUCCEEDED' || failed;
    const created = await prisma.document_issue_log.create({
      data: {
        document_type_code: input.documentType,
        target_type_code: input.targetType,
        target_id: input.targetId,
        lot_id: input.lotId ?? null,
        issue_seq: input.issueSeq ?? 1,
        reissue_reason_code: input.reason ?? null,
        issued_by: userId,
        issued_at: new Date(input.issuedAt),
        terminal_id: input.terminalId ?? null,
        printer_name: `${PREFIX}-PRINTER`,
        remarks: PREFIX,
        print_outcome_code: outcome,
        print_failure_reason: failed ? '용지 없음' : null,
        print_reported_at: reported ? new Date(input.issuedAt) : null,
        issued_worker_id: workerId,
        print_reported_worker_id: reported ? workerId : null,
        print_reported_by: reported ? userId : null,
      },
    });
    await prisma.$executeRaw`UPDATE app.document_issue_log
      SET issued_at = ${input.issuedAt}::timestamptz
      WHERE document_issue_log_id = ${created.document_issue_log_id}`;
    return created.document_issue_log_id;
  }

  async function cleanup(): Promise<void> {
    if (!prisma) return;
    await prisma.document_issue_log.deleteMany({ where: { remarks: PREFIX } });
    await prisma.code_value.deleteMany({ where: { code: REASON } });
    await prisma.inspection_result.deleteMany({
      where: { idempotency_key: PREFIX },
    });
    await prisma.inspection_request.deleteMany({
      where: { inspection_request_no: `${PREFIX}-IRQ` },
    });
    await prisma.goods_issue_line.deleteMany({
      where: { goods_issue: { goods_issue_no: `${PREFIX}-GI` } },
    });
    await prisma.goods_issue.deleteMany({
      where: { goods_issue_no: `${PREFIX}-GI` },
    });
    await prisma.serial_number.deleteMany({
      where: { serial_no: `${PREFIX}-SERIAL` },
    });
    await prisma.handling_unit.deleteMany({
      where: { handling_unit_no: `${PREFIX}-HU` },
    });
    await prisma.mold.deleteMany({ where: { mold_code: PREFIX } });
    await prisma.location.deleteMany({ where: { location_code: PREFIX } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: PREFIX } });
    await prisma.lot.deleteMany({ where: { item: { item_code: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: PREFIX } });
    await prisma.terminal.deleteMany({ where: { terminal_code: PREFIX } });
    await prisma.worker.deleteMany({ where: { worker_no: PREFIX } });
    await prisma.app_user.deleteMany({ where: { login_id: PREFIX } });
  }
});

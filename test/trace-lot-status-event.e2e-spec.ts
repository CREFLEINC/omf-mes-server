/**
 * LOT 상태 변경이력 `GET /trace/lot-status-events`(I-18 PR ①).
 *
 * ⚠ `test/trace-lot.e2e-spec.ts` 에 얹지 않는다 — 그 파일은 레인 A 가 I-20 R-9 회귀로
 * 방금 고쳤고, 이 오퍼레이션은 경로도 픽스처도 다르다(LOT 이 아니라 «사건» 행을 심는다).
 * `trace.lot_status_event` 의 유일한 writer 는 `LotQualityStatusService` 이고 이 슬라이스는
 * 그 표에 쓰지 않는다 — 사건 행은 `prisma.lot_status_event.createMany` 로 직접 심는다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-lot-status-event-probe';
const PASSWORD = 'LOT상태이력-비밀번호';
const PREFIX = 'LSEE2E';
const PATH = '/api/trace/lot-status-events';
const BASE = '2026-05-01T00:00:00.000Z';

function validator(operation: string, status = 200): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

/** 분 단위 오프셋 — 픽스처의 사건들을 서로 안 겹치는 구간에 심어 질의로 정확히 집는다. */
const at = (minutes: number): Date => new Date(Date.parse(BASE) + minutes * 60_000);
const iso = (minutes: number): string => at(minutes).toISOString();

describe('LOT 상태 변경이력 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let lotIdA: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeFixture();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⛔ occurredFrom 이 없으면 400 이다', async () => {
    await request(app.getHttpServer())
      .get(`${PATH}?occurredTo=${encodeURIComponent(iso(60))}`)
      .set('Cookie', cookie)
      .expect(400);
  });

  it('⛔ occurredTo 가 없으면 400 이다', async () => {
    await request(app.getHttpServer())
      .get(`${PATH}?occurredFrom=${encodeURIComponent(iso(0))}`)
      .set('Cookie', cookie)
      .expect(400);
  });

  it('⛔ transitionCode 가 enum(C4~C10·C14·C15) 밖이면 400 이다', async () => {
    await request(app.getHttpServer())
      .get(
        `${PATH}?occurredFrom=${encodeURIComponent(iso(0))}&occurredTo=${encodeURIComponent(iso(60))}&transitionCode=C99`,
      )
      .set('Cookie', cookie)
      .expect(400);
  });

  it('⭐ 기간은 반열림이다 — occurredFrom 은 포함, occurredTo 는 제외', async () => {
    const response = await get({ occurredFrom: iso(0), occurredTo: iso(5) });
    expect(response.body.items.map((item: { reason?: string }) => item.reason)).toEqual(['BOUNDARY-START']);
  });

  it('⭐ lotId 로 좁힌다 — 같은 기간의 다른 LOT 사건은 제외된다', async () => {
    const response = await get({ occurredFrom: iso(9), occurredTo: iso(11), lotId: String(lotIdA) });
    expect(response.body.items.map((item: { reason?: string }) => item.reason)).toEqual(['FILTER-LOT-A']);
  });

  it('⭐ transitionCode 로 좁힌다 — 같은 시각의 다른 전이는 제외된다', async () => {
    const response = await get({ occurredFrom: iso(19), occurredTo: iso(21), transitionCode: 'C7' });
    expect(response.body.items.map((item: { reason?: string }) => item.reason)).toEqual(['FILTER-C7']);
  });

  it('⭐ 정렬은 `changedAt desc` — 동률은 `lotStatusHistoryId desc` 로 닫는다', async () => {
    const response = await get({ occurredFrom: iso(29), occurredTo: iso(41) });
    expect(response.body.items.map((item: { reason?: string }) => item.reason)).toEqual([
      'SORT-TIE-2',
      'SORT-TIE-1',
      'SORT-EARLY',
    ]);
  });

  it('⭐ 응답이 계약 스키마를 만족하고, 최초 전이(C4) 행은 fromStatusCode·소스 문서 칸을 키째 생략한다', async () => {
    const response = await get({ occurredFrom: iso(54), occurredTo: iso(56) });
    const validate = validator('GET /trace/lot-status-events');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    const row = response.body.items[0];
    expect(row.reason).toBe('C4-NO-SOURCE');
    expect(row).not.toHaveProperty('fromStatusCode');
    expect(row).not.toHaveProperty('sourceDocumentTypeCode');
    expect(row).not.toHaveProperty('sourceDocumentId');
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function get(params: Record<string, string>): request.Test {
    const qs = new URLSearchParams(params).toString();
    return request(app.getHttpServer()).get(`${PATH}?${qs}`).set('Cookie', cookie).expect(200);
  }

  async function login(): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** 마스터는 최소만 — `source_id` 는 다형 축이라 FK 가 없어 임의 값을 쓴다. */
  async function makeFixture(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: 'LOT상태이력법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: 'LOT상태이력공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const uom = await prisma.uom.findFirstOrThrow();
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: 'LOT상태이력품목',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });

    const lotA = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-A`,
        item_id: item.item_id,
        lot_type_code: 'MATERIAL',
        plant_id: plant.plant_id,
        initial_qty: 10,
        uom_id: uom.uom_id,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'INSPECTION_PENDING',
      },
    });
    lotIdA = Number(lotA.lot_id);
    const lotB = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-B`,
        item_id: item.item_id,
        lot_type_code: 'MATERIAL',
        plant_id: plant.plant_id,
        initial_qty: 10,
        uom_id: uom.uom_id,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 2,
        status_code: 'INSPECTION_PENDING',
      },
    });

    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: 'LOT상태이력', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    cookie = await login();

    const base = { changed_by: user.app_user_id, previous_status_code: 'INSPECTION_PENDING', new_status_code: 'NORMAL' };
    await prisma.lot_status_event.createMany({
      data: [
        { lot_id: lotA.lot_id, transition_code: 'C7', changed_at: at(0), reason: 'BOUNDARY-START', ...base },
        { lot_id: lotA.lot_id, transition_code: 'C7', changed_at: at(5), reason: 'BOUNDARY-END', ...base },
        { lot_id: lotA.lot_id, transition_code: 'C7', changed_at: at(10), reason: 'FILTER-LOT-A', ...base },
        { lot_id: lotB.lot_id, transition_code: 'C7', changed_at: at(10), reason: 'FILTER-LOT-B', ...base },
        { lot_id: lotA.lot_id, transition_code: 'C7', changed_at: at(20), reason: 'FILTER-C7', ...base },
        { lot_id: lotA.lot_id, transition_code: 'C8', changed_at: at(20), reason: 'FILTER-C8', ...base },
        { lot_id: lotA.lot_id, transition_code: 'C9', changed_at: at(30), reason: 'SORT-EARLY', ...base },
        // ⭐ 동률(같은 changed_at) — 나중에 심은 쪽이 id 가 커서 `lot_status_event_id desc`
        //    로 먼저 나와야 한다.
        { lot_id: lotA.lot_id, transition_code: 'C9', changed_at: at(40), reason: 'SORT-TIE-1', ...base },
        { lot_id: lotA.lot_id, transition_code: 'C9', changed_at: at(40), reason: 'SORT-TIE-2', ...base },
        // ⭐ R-3 — 최초 등록 전이(C4). `previous_status_code`·소스 문서 칸이 전부 NULL 이다.
        {
          lot_id: lotA.lot_id,
          transition_code: 'C4',
          changed_at: at(55),
          reason: 'C4-NO-SOURCE',
          changed_by: user.app_user_id,
          previous_status_code: null,
          new_status_code: 'INSPECTION_PENDING',
        },
      ],
    });
  }

  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(`
      DELETE FROM trace.lot_status_event
       WHERE lot_id IN (SELECT lot_id FROM trace.lot WHERE lot_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`);
    const target = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (target) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
  }
});

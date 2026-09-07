/**
 * 검사 집계 2 (e2e) — I-19 **PR ⑤a**. `summary` · `defect-rate-trend`.
 * ⚠ **PR ⑤b 가 이 파일을 확장한다** — `measurement-summary`·`/measurements` 와 교정 만료 축
 *   (`calibrationExpired` 필터 · `calibrationExpiredCount` · 목록의 #298 m-1)이 그쪽 몫이라,
 *   장비·검교정 이력·측정치 픽스처도 ⑤b 가 여기에 «더한다». 지금 그 칸들이 비어 있는 것은
 *   설계다(⑤a 는 판정 근거 없이 칸을 채우지 않는다) — 아래 「⑤b 가 채운다」 단언이 그 자리를 지킨다.
 *
 * ⭐ **반증 가능성이 이 파일의 설계 기준이다.** 집계는 숫자가 0 이거나 우연히 맞아떨어지면
 *   초록이 된다. 그래서 픽스처를 「구현을 되돌리면 반드시 깨지는」 모양으로 세웠다 —
 *   ⓐ **회차가 둘인 사슬**(1회차 불합격 20 · 2회차 합격 0)이 있어 `finalRoundOnly` 기본값을
 *     `false` 로 되돌리면 건수(2→3)와 불량률(3.33→10)이 «둘 다» 달라진다(R-12).
 *   ⓑ 기간창 밖에 **불량률 100% 인 결과**(S4)를 두어 기간 필터가 빠지면 모든 수가 어긋난다.
 *
 * ⭐ 픽스처는 전부 prisma 직접 INSERT 다 — 검사 의뢰를 만드는 오퍼레이션이 계약에 0건이다(§0 #5).
 * ⚠ 집계 단언은 언제나 `itemId` 로 좁힌다 — 기간만으로 좁히면 다른 스위트가 같은 DB 에 남긴
 *   행이 합계에 섞여 「초록이지만 아무것도 안 지키는」 단언이 된다.
 * ⛔ 계약이 이 넷 어디에도 403 을 안 적었다 — 무권한 계정을 만들지 않는다.
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

const PREFIX = 'I19SM';
const LOGIN_ID = 'e2e-i19sm-probe';
const PASSWORD = 'PR-검사집계-비밀번호';
const RESULTS = '/api/quality/inspection-results';
const SUMMARY = `${RESULTS}/summary`;
const TREND = `${RESULTS}/defect-rate-trend`;

/** 집계 기간창 — 안에 11-02·11-03 두 날이 있고 11-01·11-04 는 «검사 0건»이다(점이 없어야 한다). */
const FROM = '2026-11-01T00:00:00.000Z';
const TO = '2026-11-04T00:00:00.000Z';
const AT_S1 = '2026-11-02T01:00:00.000Z';
const AT_S2 = '2026-11-02T02:00:00.000Z';
const AT_S3 = '2026-11-03T05:00:00.000Z';
/** ⛔ 기간창 «밖» — 불량률 100% 라 기간 필터가 빠지면 모든 단언이 깨진다. */
const AT_S4 = '2026-11-20T00:00:00.000Z';

function validator(operation: string, status = 200): ValidateFunction {
  const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/quality-03품질.json'), 'utf8')) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('검사 집계 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  const ids = { plant: 0n, uom: 0n, item: 0n };
  // 결과 넷 — S1·S2(회차 둘인 사슬) · S3(단일 회차) · S4(기간창 «밖»).
  // ⚠ ⑤b 가 이 셋의 id 를 받아 측정치를 매단다(집계 2건은 id 를 직접 안 쓴다 — 합계만 본다).
  let requestR2Id: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeFixtures();
    await makeUser();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  const period = () => `inspectedFrom=${FROM}&inspectedTo=${TO}&itemId=${ids.item}`;
  const get = (url: string) => request(app.getHttpServer()).get(url).set('Cookie', cookie);

  describe('요약 — `GET /quality/inspection-results/summary`', () => {
    it('⛔ 기간이 없으면 400 `REQUIRED` — 목록과 달리 `inspectionRequestId` 로 대신할 수 없다(R-17)', async () => {
      const noPeriod = await get(SUMMARY).expect(400);
      expect(noPeriod.body.errors[0]).toMatchObject({ field: 'inspectedFrom', code: 'REQUIRED' });

      // ⭐ 목록(`:753`)은 이 입력을 200 으로 받는다 — 두 규칙을 한 헬퍼로 뭉치면 여기가 조용히 200 이 된다.
      await get(`${SUMMARY}?inspectionRequestId=${requestR2Id}`).expect(400);
      await get(`${RESULTS}?inspectionRequestId=${requestR2Id}`).expect(200);
    });

    it('⭐ 5칸이 **필터 전체 기준** 합계다 — 페이지와 무관하고 기간 밖(S4)은 안 섞인다', async () => {
      const response = await get(`${SUMMARY}?${period()}`).expect(200);

      // 최종 회차만: S2(검사 100 · 합격 100) + S3(검사 50 · 합격 40 · 불합격 5 · 보류 5).
      expect(response.body).toMatchObject({
        inspectionCount: 2,
        inspectedQty: 150,
        acceptedQty: 140,
        rejectedQty: 5,
        heldQty: 5,
      });
      expect(validator('GET /quality/inspection-results/summary')(response.body)).toBe(true);
    });

    it('⭐ `defectRate` 의 분모가 **검사 수량**이다(생산 수량이 아니다)', async () => {
      const response = await get(`${SUMMARY}?${period()}`).expect(200);

      // 5 / 150 × 100. 분모를 생산 수량(주문 100)이나 건수(2)로 잡으면 이 수가 안 나온다.
      expect(response.body.defectRate).toBeCloseTo(3.3333, 3);
      expect(response.body.rejectedQty / response.body.inspectedQty).toBeCloseTo(response.body.defectRate / 100, 6);
    });

    it('⭐ R-12 — `finalRoundOnly` 를 생략하면 **`true`** 다(집계는 목록과 기본값이 다르다)', async () => {
      const omitted = await get(`${SUMMARY}?${period()}`).expect(200);
      const explicitTrue = await get(`${SUMMARY}?${period()}&finalRoundOnly=true`).expect(200);
      const explicitFalse = await get(`${SUMMARY}?${period()}&finalRoundOnly=false`).expect(200);

      expect(omitted.body).toMatchObject({ inspectionCount: 2, rejectedQty: 5, finalRoundOnly: true });
      expect(explicitTrue.body.inspectionCount).toBe(omitted.body.inspectionCount);
      // ⭐ 반증: false 로 구현하면 1회차 불합격(20)까지 세어져 건수 3 · 불량률 10% 가 된다.
      expect(explicitFalse.body).toMatchObject({ inspectionCount: 3, inspectedQty: 250, rejectedQty: 25, finalRoundOnly: false });
      expect(explicitFalse.body.defectRate).toBeCloseTo(10, 6);
      expect(omitted.body.defectRate).not.toBeCloseTo(explicitFalse.body.defectRate, 3);
    });

    it('⚠ `calibrationExpiredCount` 는 아직 **키가 없다** — PR ⑤b 가 채운다(0 으로 접지 않는다)', async () => {
      const response = await get(`${SUMMARY}?${period()}`).expect(200);

      // ⭐ 부재를 «특성화»해 둔다(§12-1 ⓐ 와 같은 방식). 교정 만료 판정(`calibration.ts` · R-13)이
      //    측정치 2건과 함께 ⑤b 에서 서므로, 여기서 0 을 채우면 「만료 장비로 잰 검사가 없다」로
      //    읽혀 `W-03-05` §5-6 의 경고가 영영 안 뜬다(L-8). ⑤b 가 이 단언을 뒤집는다.
      expect(response.body).not.toHaveProperty('calibrationExpiredCount');
      expect(response.body).toMatchObject({ inspectionCount: 2, inspectedQty: 150 });
      expect(validator('GET /quality/inspection-results/summary')(response.body)).toBe(true);
    });

    it('`asOf` 가 **서버 시각**이다 — 요청마다 새로 찍힌다', async () => {
      const before = Date.now() - 1000;
      const response = await get(`${SUMMARY}?${period()}`).expect(200);
      const asOf = Date.parse(response.body.asOf);

      expect(asOf).toBeGreaterThanOrEqual(before);
      expect(asOf).toBeLessThanOrEqual(Date.now() + 1000);
    });
  });

  describe('불량률 추이 — `GET /quality/inspection-results/defect-rate-trend`', () => {
    it('⛔ 기간이 없으면 400 이다', async () => {
      const response = await get(TREND).expect(400);
      expect(response.body.errors[0]).toMatchObject({ field: 'inspectedFrom', code: 'REQUIRED' });
    });

    it('⭐ **일자 버킷**으로 오고 점마다 4칸이 찬다 — 검사 0건인 날은 **점이 없다**', async () => {
      const response = await get(`${TREND}?${period()}`).expect(200);

      // 기간창은 11-01~11-04 인데 검사는 11-02·11-03 이틀뿐이다 — 0 으로 채우지 않는다.
      expect(response.body.points.map((point: { bucket: string }) => point.bucket)).toEqual(['2026-11-02', '2026-11-03']);
      expect(response.body.points[0]).toEqual({ bucket: '2026-11-02', inspectedQty: 100, rejectedQty: 0, defectRate: 0 });
      expect(response.body.points[1].defectRate).toBeCloseTo(10, 6); // 5 / 50
      expect(validator('GET /quality/inspection-results/defect-rate-trend')(response.body)).toBe(true);
    });

    it('⭐ R-12 — 추이도 기본이 최종 회차다. `false` 로 주면 11-02 점의 불량률이 달라진다', async () => {
      const omitted = await get(`${TREND}?${period()}`).expect(200);
      const withChain = await get(`${TREND}?${period()}&finalRoundOnly=false`).expect(200);

      expect(omitted.body.points[0]).toMatchObject({ inspectedQty: 100, rejectedQty: 0 });
      // 1회차(S1 · 검사 100 · 불합격 20)가 같은 날에 붙는다 — 200 중 20 = 10%.
      expect(withChain.body.points[0]).toMatchObject({ inspectedQty: 200, rejectedQty: 20 });
      expect(withChain.body.points[0].defectRate).toBeCloseTo(10, 6);
    });
  });

  async function makeFixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '검사집계법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const businessUnit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '검사집계사업부' },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: '검사집계공장', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    ids.plant = plant.plant_id;
    const uom = await prisma.uom.findFirstOrThrow();
    ids.uom = uom.uom_id;

    const item = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT`, item_name: 'I19SM집계품목', item_type_code: 'RAW_MATERIAL', base_uom_id: uom.uom_id, lot_controlled: true },
    });
    ids.item = item.item_id;

    // ⚠ 장비·검교정 이력은 ⑤b 가 더한다(R-13 판정이 그쪽에서 선다).
    const plan = await prisma.inspection_plan.create({
      data: { inspection_plan_code: `${PREFIX}-PLAN`, inspection_plan_name: '검사집계기준', inspection_type_code: 'IQC' },
    });
    const planVersion = await prisma.inspection_plan_version.create({
      data: {
        inspection_plan_id: plan.inspection_plan_id,
        plan_version: 1,
        effective_from: new Date('2026-01-01T00:00:00.000Z'),
        sampling_method_code: 'FULL',
        inspection_frequency_code: 'EVERY_LOT',
        status_code: 'ACTIVE',
      },
    });
    // ⚠ 항목 규격·측정치도 ⑤b 몫이다 — 집계 2건은 `inspection_result` 한 표만 읽는다.
    const worker = await prisma.worker.create({
      data: { worker_no: `${PREFIX}-WK`, worker_name: '검사집계검사원', business_unit_id: businessUnit.business_unit_id, plant_id: plant.plant_id, status_code: 'EMPLOYED' },
    });

    const requestOf = async (suffix: string) =>
      prisma.inspection_request.create({
        data: {
          inspection_request_no: `${PREFIX}-IR-${suffix}`,
          inspection_type_code: 'IQC',
          inspection_plan_version_id: planVersion.inspection_plan_version_id,
          target_type_code: 'LOT',
          target_id: item.item_id,
          item_id: item.item_id,
          target_qty: 100,
          uom_id: uom.uom_id,
          status_code: 'COMPLETED',
          requested_at: new Date(FROM),
        },
      });
    const r1 = await requestOf('1');
    const r2 = await requestOf('2');
    requestR2Id = Number(r2.inspection_request_id);
    const r3 = await requestOf('3');

    const resultOf = async (
      suffix: string,
      overrides: {
        requestId: bigint;
        round?: number;
        previousResultId?: bigint;
        inspectedAt: string;
        inspectedQty: number;
        acceptedQty: number;
        rejectedQty: number;
        heldQty?: number;
        judgment: string;
      },
    ) =>
      prisma.inspection_result.create({
        data: {
          inspection_result_no: `${PREFIX}-IRS-${suffix}`,
          inspection_request_id: overrides.requestId,
          inspection_round: overrides.round ?? 1,
          previous_result_id: overrides.previousResultId ?? null,
          inspected_qty: overrides.inspectedQty,
          accepted_qty: overrides.acceptedQty,
          rejected_qty: overrides.rejectedQty,
          held_qty: overrides.heldQty ?? 0,
          uom_id: uom.uom_id,
          overall_judgment_code: overrides.judgment,
          inspector_id: worker.worker_id,
          inspected_at: new Date(overrides.inspectedAt),
          confirmed_at: new Date(overrides.inspectedAt),
          status_code: 'CONFIRMED',
          idempotency_key: `${PREFIX}-IDEM-${suffix}`,
        },
      });

    // ⭐ 재검 사슬 — 1회차 불합격(20)이 2회차 합격(0)으로 «대체»된다. R-12 의 반증 근거다.
    const s1 = await resultOf('S1', { requestId: r1.inspection_request_id, inspectedAt: AT_S1, inspectedQty: 100, acceptedQty: 80, rejectedQty: 20, judgment: 'REJECTED' });
    await resultOf('S2', { requestId: r1.inspection_request_id, round: 2, previousResultId: s1.inspection_result_id, inspectedAt: AT_S2, inspectedQty: 100, acceptedQty: 100, rejectedQty: 0, judgment: 'ACCEPTED' });
    await resultOf('S3', { requestId: r2.inspection_request_id, inspectedAt: AT_S3, inspectedQty: 50, acceptedQty: 40, rejectedQty: 5, heldQty: 5, judgment: 'ACCEPTED' });
    // ⛔ 기간창 밖 — 불량률 100%. 기간 필터가 빠지면 위 단언이 전부 깨진다.
    await resultOf('S4', { requestId: r3.inspection_request_id, inspectedAt: AT_S4, inspectedQty: 1000, acceptedQty: 0, rejectedQty: 1000, judgment: 'REJECTED' });
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: '검사집계조회', status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });

    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** FK 역순으로 지운다. `beforeAll`·`afterAll` 둘 다 부른다(자가 치유 · §8-2). */
  async function cleanup(): Promise<void> {
    const resultScope = { inspection_result_no: { startsWith: PREFIX } };
    // ⚠ `inspection_measurement`·`inspection_item_spec`·`equipment` 는 ⑤b 가 이 순서에 끼운다.
    await prisma.inspection_result.deleteMany({ where: { AND: [resultScope, { previous_result_id: { not: null } }] } });
    await prisma.inspection_result.deleteMany({ where: resultScope });
    await prisma.inspection_request.deleteMany({ where: { inspection_request_no: { startsWith: PREFIX } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.inspection_plan_version.deleteMany({ where: { inspection_plan: { inspection_plan_code: { startsWith: PREFIX } } } });
    await prisma.inspection_plan.deleteMany({ where: { inspection_plan_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });

    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (!user) return;
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
    await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
    await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
  }
});

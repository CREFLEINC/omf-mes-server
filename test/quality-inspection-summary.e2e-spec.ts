/**
 * 검사 집계 2 + 측정치 2 (e2e) — I-19 **PR ⑤a**(집계 9건)를 **⑤b** 가 확장한다. 네 오퍼레이션과,
 * 그 넷이 세운 판정(`calibration.ts` · R-13)을 목록(`GET /quality/inspection-results`)이 되쓰는
 * 자리(#298 m-1)까지 본다.
 * ⭐ ⑤b 가 더한 것: 장비 셋 · 검교정 이력 · 항목 규격 셋 · 측정치 17행 픽스처와 단언 14건.
 *   ⑤a 가 「아직 키가 없다」로 특성화해 둔 `calibrationExpiredCount` 단언을 **여기서 뒤집는다**.
 *
 * ⭐ **반증 가능성이 이 파일의 설계 기준이다.** 집계는 숫자가 0 이거나 우연히 맞아떨어지면
 *   초록이 된다. 그래서 픽스처를 「구현을 되돌리면 반드시 깨지는」 모양으로 세웠다 —
 *   ⓐ **회차가 둘인 사슬**(1회차 불합격 20 · 2회차 합격 0)이 있어 `finalRoundOnly` 기본값을
 *     `false` 로 되돌리면 건수(2→3)와 불량률(3.33→10)이 «둘 다» 달라진다(R-12).
 *   ⓑ **교정 불요 장비**(`calibration_required=false`)로 잰 측정치가 있어 R-13 을 되돌려
 *     「이력 0건 = 만료」로 판정하면 그 행이 만료로 뒤집힌다.
 *   ⓒ **규격 밖 12건 · 불합격 2건**이라 `outOfSpecTotalCount` 를 `rejectedCount` 로 역산하면 깨진다.
 *   ⓓ 기간창 밖에 **불량률 100% 인 결과**(S4)를 두어 기간 필터가 빠지면 모든 수가 어긋난다.
 *
 * ⭐ 픽스처는 전부 prisma 직접 INSERT 다 — 검사 의뢰를 만드는 오퍼레이션이 계약에 0건이고
 *   (§0 #5) 측정치·검교정 이력을 심는 쓰기도 이 슬라이스 밖이다.
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

describe('검사 집계·측정치 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  const ids = {
    plant: 0n,
    uom: 0n,
    uomCode: '',
    item: 0n,
    specNumeric: 0n,
    specPlain: 0n,
    specText: 0n,
    equipmentExpired: 0n,
    equipmentValid: 0n,
    equipmentFree: 0n,
  };
  let resultS1Id: number; // REQ1 1회차 — 불합격(검사 100 · 불합격 20) · 만료 아님
  let resultS2Id: number; // REQ1 2회차 — 합격(검사 100 · 불합격 0) · 최종 회차
  let resultS3Id: number; // REQ2 1회차 — 검사 50 · 불합격 5 · ⭐ 교정 만료 장비 측정치가 있다
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

    it('⭐ `calibrationExpiredCount` 가 나오되 **합계에서 빠지지 않는다**(E-9 ① — 자동 제외 없음)', async () => {
      const response = await get(`${SUMMARY}?${period()}`).expect(200);

      // ⭐ ⑤a 는 이 칸을 «안 냈고»(판정이 없었다) e2e 가 그 부재를 특성화했다 — ⑤b 가 뒤집는다.
      //    계약 required 여섯에 없는 칸이라 안 내는 것 자체는 위반이 아니었다(⑤a 리뷰 실측).
      // S3 하나가 교정 만료 장비로 잰 측정치를 갖는다. 그래도 검사 수량 150 은 그대로다.
      expect(response.body.calibrationExpiredCount).toBe(1);
      expect(response.body).toMatchObject({ inspectionCount: 2, inspectedQty: 150 });
    });

    it('`calibrationExpired=exclude`·`only` 를 줄 때만 모집단이 갈린다', async () => {
      const excluded = await get(`${SUMMARY}?${period()}&calibrationExpired=exclude`).expect(200);
      const only = await get(`${SUMMARY}?${period()}&calibrationExpired=only`).expect(200);

      expect(excluded.body).toMatchObject({ inspectionCount: 1, inspectedQty: 100, rejectedQty: 0 });
      expect(only.body).toMatchObject({ inspectionCount: 1, inspectedQty: 50, rejectedQty: 5 });
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

    it('⚠ ⑤a 리뷰 m-2 — 계약이 추이에 «선언하지 않은» 두 축은 실려 와도 안 먹는다', async () => {
      const plain = await get(`${TREND}?${period()}`).expect(200);
      // `statusCode=DRAFT` 는 픽스처 전건(CONFIRMED)을 지운다 · `inspectionRequestId` 는 하루만 남긴다.
      // 공용 where 빌더가 그 둘을 읽던 때는 점이 0개·1개로 «조용히» 줄었다(타입의 Omit 은 런타임을 못 막는다).
      const withStatus = await get(`${TREND}?${period()}&statusCode=DRAFT`).expect(200);
      const withRequest = await get(`${TREND}?${period()}&inspectionRequestId=${requestR2Id}`).expect(200);

      expect(plain.body.points).toHaveLength(2);
      expect(withStatus.body.points).toEqual(plain.body.points);
      expect(withRequest.body.points).toEqual(plain.body.points);
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

  describe('항목별 요약 — `GET …/{id}/measurement-summary`', () => {
    it('⭐ **항목 단위**로 접히고 `asOf` 를 낸다 — 측정치 17행이 항목 3행이 된다', async () => {
      const response = await get(`${RESULTS}/${resultS3Id}/measurement-summary`).expect(200);

      expect(response.body.items).toHaveLength(3);
      expect(response.body.items[0]).toMatchObject({
        inspectionItemSpecId: Number(ids.specNumeric),
        itemName: `${PREFIX} 치수`,
        measuredCount: 12,
        acceptedCount: 10,
        rejectedCount: 2,
        unmeasuredCount: 0,
      });
      expect(response.body.items[0].specText).toBe(`11.95 ~ 12.05 ${ids.uomCode}`);
      expect(Date.parse(response.body.asOf)).toBeLessThanOrEqual(Date.now() + 1000);
      expect(validator('GET /quality/inspection-results/{inspectionResultId}/measurement-summary')(response.body)).toBe(true);
    });

    it('⭐ `outOfSpecValues` 가 **최대 10건**이고 `outOfSpecTotalCount` 는 전체다 — ⛔ 불합격 수로 역산하지 않는다', async () => {
      const response = await get(`${RESULTS}/${resultS3Id}/measurement-summary`).expect(200);
      const numeric = response.body.items[0];

      expect(numeric.outOfSpecValues).toHaveLength(10);
      expect(numeric.outOfSpecTotalCount).toBe(12);
      // ⭐ 반증: 규격 밖 12건인데 사람이 불합격을 준 것은 2건뿐이다 — 두 수가 같아지면 역산한 것이다.
      expect(numeric.outOfSpecTotalCount).not.toBe(numeric.rejectedCount);
      expect(numeric.outOfSpecValues[0]).toBe('12.06');
    });

    it('⭐ `unmeasuredCount` 가 **값 3칸이 전부 빈 행**을 센다 — 상·하한이 없으면 `specText` 키가 없다', async () => {
      const response = await get(`${RESULTS}/${resultS3Id}/measurement-summary`).expect(200);
      const plain = response.body.items.find((item: { inspectionItemSpecId: number }) => item.inspectionItemSpecId === Number(ids.specPlain));

      expect(plain).toMatchObject({ measuredCount: 1, unmeasuredCount: 2, outOfSpecTotalCount: 0 });
      expect(plain).not.toHaveProperty('specText'); // 널이 아니라 «키 생략»이다(§5-7)
      expect(plain).not.toHaveProperty('equipmentName'); // 장비 없는 항목
      expect(plain).not.toHaveProperty('equipmentCalibrationExpired');
    });

    it('⭐ 규격 밖 판정이 **NUMERIC 항목에만** 선다 — 상·하한이 있어도 TEXT 항목은 0건이다', async () => {
      const response = await get(`${RESULTS}/${resultS3Id}/measurement-summary`).expect(200);
      const text = response.body.items.find((item: { inspectionItemSpecId: number }) => item.inspectionItemSpecId === Number(ids.specText));

      // 값(99)은 상한 12.05 밖이지만 `data_type_code='TEXT'` 라 규격 판정 자체가 서지 않는다.
      expect(text).toMatchObject({ measuredCount: 2, outOfSpecTotalCount: 0, rejectedCount: 0 });
      expect(text.outOfSpecValues).toEqual([]);
    });

    it('⭐ R-13 — 장비 3칸: 교정 «필요» 장비만 만료가 되고, 교정 불요 장비는 만료가 아니다', async () => {
      const response = await get(`${RESULTS}/${resultS3Id}/measurement-summary`).expect(200);
      const [numeric] = response.body.items;
      const text = response.body.items.find((item: { inspectionItemSpecId: number }) => item.inspectionItemSpecId === Number(ids.specText));

      expect(numeric).toMatchObject({
        equipmentName: `${PREFIX} 만료캘리퍼`,
        equipmentCalibrationExpired: true,
        equipmentCalibrationDueDate: '2026-10-01',
      });
      // ⭐ 반증: 「검교정 이력 0건 = 만료」로 되돌리면 이 장비(이력 0건 · calibration_required=false)가
      //    만료로 뒤집혀 현장의 경고가 상시 켜진다.
      expect(text).toMatchObject({ equipmentName: `${PREFIX} 교정불요게이지`, equipmentCalibrationExpired: false });
      expect(text).not.toHaveProperty('equipmentCalibrationDueDate');
    });

    it('없는 결과 id 의 `measurement-summary` 는 **404** 다', async () => {
      await get(`${RESULTS}/999999999/measurement-summary`).expect(404);
    });
  });

  describe('측정치 목록 — `GET …/{id}/measurements`', () => {
    it('페이지 골격으로 오고 기본 크기가 50 이며 `항목 → 표본` 순이다', async () => {
      const response = await get(`${RESULTS}/${resultS3Id}/measurements`).expect(200);

      expect(response.body.page).toMatchObject({ page: 1, size: 50, total: 17 });
      expect(response.body.items).toHaveLength(17);
      expect(response.body.items[0]).toMatchObject({ inspectionItemSpecId: Number(ids.specNumeric), sampleNo: 1 });
      expect(response.body.items[11]).toMatchObject({ inspectionItemSpecId: Number(ids.specNumeric), sampleNo: 12 });
      expect(validator('GET /quality/inspection-results/{inspectionResultId}/measurements')(response.body)).toBe(true);
    });

    it('⭐ 목록을 «접지 않는다» — `size` 로 끊어도 `total` 은 전체다(135,000 자릿수의 층)', async () => {
      const response = await get(`${RESULTS}/${resultS3Id}/measurements?page=2&size=5`).expect(200);

      expect(response.body.page).toMatchObject({ page: 2, size: 5, total: 17 });
      expect(response.body.items).toHaveLength(5);
      expect(response.body.items[0]).toMatchObject({ sampleNo: 6 });
    });

    it('⭐ 없는 결과 id 는 **빈 목록 + `total=0`** 이다(404 가 아니다 — 계약 미선언)', async () => {
      const response = await get(`${RESULTS}/999999999/measurements`).expect(200);

      expect(response.body).toEqual({ items: [], page: { page: 1, size: 50, total: 0 } });
      // 자식 컬렉션 GET 은 **버전 ETag 를 안 낸다**(B-1-1) — express 가 붙이는 약한 해시(W/"…")는
      // 낙관적 잠금 토큰이 아니다. 상세 GET 하나만 `version_no` 를 그대로 낸다(§4-3).
      expect(response.headers.etag).not.toMatch(/^"?\d+"?$/);
    });

    it('`inspectionItemSpecId` 로 한 항목만 좁혀진다', async () => {
      const response = await get(`${RESULTS}/${resultS3Id}/measurements?inspectionItemSpecId=${ids.specPlain}`).expect(200);

      expect(response.body.page.total).toBe(3);
      expect(response.body.items.every((row: { inspectionItemSpecId: number }) => row.inspectionItemSpecId === Number(ids.specPlain))).toBe(true);
    });

    it('⭐ `calibrationExpiredAtMeasurement` 를 **서버가 판정해 행마다** 싣는다 — 장비가 없으면 키를 생략한다', async () => {
      const response = await get(`${RESULTS}/${resultS3Id}/measurements`).expect(200);
      const bySpec = (specId: bigint) => response.body.items.filter((row: { inspectionItemSpecId: number }) => row.inspectionItemSpecId === Number(specId));

      expect(bySpec(ids.specNumeric).every((row: { calibrationExpiredAtMeasurement: boolean }) => row.calibrationExpiredAtMeasurement === true)).toBe(true);
      expect(bySpec(ids.specText).every((row: { calibrationExpiredAtMeasurement: boolean }) => row.calibrationExpiredAtMeasurement === false)).toBe(true);
      // 장비가 없는 행은 «키 자체가 없다» — false 로 채우면 「교정이 유효했다」로 읽힌다(L-8).
      expect(bySpec(ids.specPlain).every((row: object) => !('calibrationExpiredAtMeasurement' in row))).toBe(true);
    });

    it('`calibrationExpired=only`·`exclude` 가 측정치 축에서 갈린다 — 장비 없는 행은 만료가 아니다', async () => {
      const only = await get(`${RESULTS}/${resultS3Id}/measurements?calibrationExpired=only`).expect(200);
      const excluded = await get(`${RESULTS}/${resultS3Id}/measurements?calibrationExpired=exclude`).expect(200);

      expect(only.body.page.total).toBe(12);
      expect(excluded.body.page.total).toBe(5); // 교정불요 장비 2 + 장비 없는 행 3
    });
  });

  describe('⭐ 이월 #298 m-1 — 목록의 `calibrationExpired` 를 더는 조용히 무시하지 않는다', () => {
    it('`only` 는 만료 측정치를 «가진» 결과만, `exclude` 는 «없는» 결과만 낸다', async () => {
      const only = await get(`${RESULTS}?${period()}&calibrationExpired=only`).expect(200);
      const excluded = await get(`${RESULTS}?${period()}&calibrationExpired=exclude`).expect(200);
      const idsOf = (body: { items: { inspectionResultId: number }[] }) => body.items.map((item) => item.inspectionResultId);

      // ⭐ 옛 코드는 이 칸을 통째로 버려 둘이 «같은» 목록이었다 — 그래서 초록이었다.
      expect(idsOf(only.body)).toEqual([resultS3Id]);
      expect(idsOf(excluded.body)).toEqual([resultS1Id, resultS2Id]); // 사슬은 뿌리와 동거한다(목록 기본 false)
      expect(only.body.page.total).toBe(1);
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
    ids.uomCode = uom.uom_code;

    const item = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT`, item_name: 'I19SM집계품목', item_type_code: 'RAW_MATERIAL', base_uom_id: uom.uom_id, lot_controlled: true },
    });
    ids.item = item.item_id;

    // ⭐ 장비 셋 — R-13 의 두 칸이 실제로 갈리는지 보려면 세 갈래가 다 있어야 한다.
    const equipmentOf = async (suffix: string, name: string, required: boolean, dueDate: string | null) =>
      prisma.equipment.create({
        data: {
          plant_id: plant.plant_id,
          equipment_code: `${PREFIX}-EQ-${suffix}`,
          equipment_name: name,
          equipment_type_code: 'MEASURING',
          status_code: 'RUNNING',
          calibration_required: required,
          calibration_due_date: dueDate === null ? null : new Date(`${dueDate}T00:00:00.000Z`),
        },
      });
    // ⓐ 교정 필요 + 기한이 지났고 이력 0건 = 만료
    ids.equipmentExpired = (await equipmentOf('X', `${PREFIX} 만료캘리퍼`, true, '2026-10-01')).equipment_id;
    // ⓑ 교정 필요 + 이력이 측정 시점을 덮는다 = 만료 아님
    const valid = await equipmentOf('V', `${PREFIX} 정상캘리퍼`, true, '2026-12-31');
    ids.equipmentValid = valid.equipment_id;
    await prisma.equipment_calibration.create({
      data: {
        equipment_id: valid.equipment_id,
        calibration_date: new Date('2026-10-01T00:00:00.000Z'),
        valid_until: new Date('2026-12-31T00:00:00.000Z'),
        result_code: 'PASS',
      },
    });
    // ⓒ ⭐ 교정 «불요» — 이력도 기한도 없다. R-13 을 되돌리면 이 장비가 만료로 뒤집힌다.
    ids.equipmentFree = (await equipmentOf('F', `${PREFIX} 교정불요게이지`, false, null)).equipment_id;

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
    const specOf = async (
      sequenceNo: number,
      suffix: string,
      name: string,
      dataTypeCode: string,
      limits: { lower?: number; upper?: number } = {},
    ) =>
      prisma.inspection_item_spec.create({
        data: {
          inspection_plan_version_id: planVersion.inspection_plan_version_id,
          sequence_no: sequenceNo,
          inspection_item_code: `${PREFIX}-SPEC-${suffix}`,
          inspection_item_name: name,
          data_type_code: dataTypeCode,
          uom_id: limits.lower === undefined ? null : uom.uom_id,
          lower_limit: limits.lower ?? null,
          upper_limit: limits.upper ?? null,
        },
      });
    ids.specNumeric = (await specOf(10, 'N', `${PREFIX} 치수`, 'NUMERIC', { lower: 11.95, upper: 12.05 })).inspection_item_spec_id;
    ids.specPlain = (await specOf(20, 'P', `${PREFIX} 외관`, 'NUMERIC')).inspection_item_spec_id;
    // ⭐ 상·하한이 «있는» TEXT 항목 — 규격 판정이 NUMERIC 에만 서는지 반증하는 갈래다.
    ids.specText = (await specOf(30, 'T', `${PREFIX} 색상`, 'TEXT', { lower: 11.95, upper: 12.05 })).inspection_item_spec_id;

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
    resultS1Id = Number(s1.inspection_result_id);
    const s2 = await resultOf('S2', { requestId: r1.inspection_request_id, round: 2, previousResultId: s1.inspection_result_id, inspectedAt: AT_S2, inspectedQty: 100, acceptedQty: 100, rejectedQty: 0, judgment: 'ACCEPTED' });
    resultS2Id = Number(s2.inspection_result_id);
    const s3 = await resultOf('S3', { requestId: r2.inspection_request_id, inspectedAt: AT_S3, inspectedQty: 50, acceptedQty: 40, rejectedQty: 5, heldQty: 5, judgment: 'ACCEPTED' });
    resultS3Id = Number(s3.inspection_result_id);
    // ⛔ 기간창 밖 — 불량률 100%. 기간 필터가 빠지면 위 단언이 전부 깨진다.
    await resultOf('S4', { requestId: r3.inspection_request_id, inspectedAt: AT_S4, inspectedQty: 1000, acceptedQty: 0, rejectedQty: 1000, judgment: 'REJECTED' });

    const measurementOf = async (
      resultId: bigint,
      specId: bigint,
      sampleNo: number,
      values: { numeric?: number; text?: string; boolean?: boolean },
      judgment: string,
      equipmentId: bigint | null,
      measuredAt: string,
    ) =>
      prisma.inspection_measurement.create({
        data: {
          inspection_result_id: resultId,
          inspection_item_spec_id: specId,
          sample_no: sampleNo,
          numeric_value: values.numeric ?? null,
          text_value: values.text ?? null,
          boolean_value: values.boolean ?? null,
          judgment_code: judgment,
          measured_at: new Date(measuredAt),
          inspection_equipment_id: equipmentId,
        },
      });

    // S3 의 측정치 17행 — 항목 셋.
    // ① 치수(NUMERIC 11.95~12.05): 12건 «전부» 규격 밖(12.06~12.17)인데 사람이 준 불합격은 2건뿐.
    //    ⇒ outOfSpecTotalCount(12) ≠ rejectedCount(2) 라 역산을 반증한다. 장비는 만료 캘리퍼.
    for (let sample = 1; sample <= 12; sample += 1) {
      await measurementOf(
        s3.inspection_result_id,
        ids.specNumeric,
        sample,
        // 정수 나눗셈으로 만든다 — `12.05 + 0.01` 은 부동소수 오차로 12.059999… 가 될 수 있다.
        { numeric: (1205 + sample) / 100 },
        sample <= 2 ? 'REJECTED' : 'ACCEPTED',
        ids.equipmentExpired,
        AT_S3,
      );
    }
    // ② 외관(상·하한 없음 · 장비 없음): 측정 1 + ⭐ 미측정 2(값 세 칸이 전부 NULL).
    await measurementOf(s3.inspection_result_id, ids.specPlain, 1, { numeric: 5 }, 'ACCEPTED', null, AT_S3);
    await measurementOf(s3.inspection_result_id, ids.specPlain, 2, {}, 'ACCEPTED', null, AT_S3);
    await measurementOf(s3.inspection_result_id, ids.specPlain, 3, {}, 'ACCEPTED', null, AT_S3);
    // ③ 색상(TEXT 인데 상·하한이 있다 · 교정 불요 장비): 값 99 는 상한 밖이지만 규격 판정이 안 선다.
    await measurementOf(s3.inspection_result_id, ids.specText, 1, { numeric: 99 }, 'ACCEPTED', ids.equipmentFree, AT_S3);
    await measurementOf(s3.inspection_result_id, ids.specText, 2, { numeric: 99 }, 'ACCEPTED', ids.equipmentFree, AT_S3);
    // 사슬 쪽은 «만료 아닌» 장비로 잰다 — `calibrationExpired` 필터가 실제로 가르는지 보려면 필요하다.
    await measurementOf(s1.inspection_result_id, ids.specPlain, 1, { numeric: 1 }, 'ACCEPTED', ids.equipmentValid, AT_S1);
    await measurementOf(s2.inspection_result_id, ids.specPlain, 1, { numeric: 1 }, 'ACCEPTED', ids.equipmentValid, AT_S2);
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
    await prisma.inspection_measurement.deleteMany({ where: { inspection_result: resultScope } });
    await prisma.inspection_result.deleteMany({ where: { AND: [resultScope, { previous_result_id: { not: null } }] } });
    await prisma.inspection_result.deleteMany({ where: resultScope });
    await prisma.inspection_item_spec.deleteMany({ where: { inspection_item_code: { startsWith: PREFIX } } });
    await prisma.inspection_request.deleteMany({ where: { inspection_request_no: { startsWith: PREFIX } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.equipment_calibration.deleteMany({ where: { equipment: { equipment_code: { startsWith: PREFIX } } } });
    await prisma.equipment.deleteMany({ where: { equipment_code: { startsWith: PREFIX } } });
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

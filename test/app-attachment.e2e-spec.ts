/**
 * 첨부 목록 `GET /app/attachments`(I-34 PR ①).
 *
 * `app.attachment` 의 유일한 writer 가 이 슬라이스에는 없다(`POST` 는 건너뜀 확정) —
 * 사건 행은 `prisma.attachment.createMany` 로 직접 심는다(선례 `test/trace-lot-status-event.e2e-spec.ts`).
 * ⭐ `uploaded_at` 은 «명시»한다 — 물리 기본값이 `clock_timestamp()`(행마다 다름)라
 * 안 주면 동률이 안 서고 2차 키(`attachment_id desc`) 단언이 조용히 죽는다(I-34.md R-6).
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

const LOGIN_ID = 'e2e-attachment-probe';
const PASSWORD = '첨부목록-검사-비밀번호';
const PREFIX = 'ATT-E2E';
const PATH = '/api/app/attachments';
const BASE = '2026-06-01T00:00:00.000Z';

function validator(operation: string, status = 200): ValidateFunction {
  const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/app-공통.json'), 'utf8')) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

/** 분 단위 오프셋 — 시각을 서로 안 겹치는 구간에 심어 정렬을 정확히 집는다. */
const at = (minutes: number): Date => new Date(Date.parse(BASE) + minutes * 60_000);

interface AttachmentBody {
  attachmentId: number;
  targetTypeCode: string;
  targetId: number;
  fileName: string;
  contentType: string;
  byteSize: number;
  uploadedAt: string;
  uploadedBy: number;
}

function idOf(map: Map<string, number>, key: string): number {
  const value = map.get(key);
  if (value === undefined) throw new Error(`fixture 행 없음: ${key}`);
  return value;
}

describe('첨부 목록 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let uploadedById: number;
  // A~D·F·G — I-34.md §6-1 표와 같은 이름·좌표. E 는 총합(51)에만 쓰이고 자기 id 를
  // 단언하는 자리가 없다(F3 섞임을 넓히는 용도). 채움 44 는 이름이 없다(F4/#6 전용).
  let idA: number, idB: number, idC: number, idD: number, idF: number, idG: number;

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

  it('⭐ targetId 를 고정하고 유형만 바꾼다 — F2·S1 을 함께 지켜본다', async () => {
    const res = await get('targetTypeCode=WAREHOUSE&targetId=1001');
    expect(res.body.items.map((i: AttachmentBody) => i.attachmentId)).toEqual([idB, idA]);
  });

  it('⭐ 완전히 같은 uploaded_at 두 행은 attachment_id desc 로 닫는다 — S2', async () => {
    const res = await get('targetTypeCode=WAREHOUSE&targetId=3003');
    expect(res.body.items.map((i: AttachmentBody) => i.attachmentId)).toEqual([idG, idF]);
  });

  it('⭐ 같은 targetId 라도 유형이 다르면 걸리지 않는다 — F1', async () => {
    const res = await get('targetTypeCode=NOTICE&targetId=1001');
    expect(res.body.items.map((i: AttachmentBody) => i.attachmentId)).toEqual([idC]);
  });

  it('⭐ targetTypeCode 만 주면 targetId 필터가 안 걸린다 — F3 전반(400 아님)', async () => {
    const res = await get('targetTypeCode=WAREHOUSE');
    expect(res.body.items.map((i: AttachmentBody) => i.attachmentId)).toEqual([idG, idF, idD, idB, idA]);
  });

  it('⭐ targetId 만 주면 유형이 섞여 온다 — F3 후반(통보 155 반증 자리 · 400 아님)', async () => {
    const res = await get('targetId=1001');
    expect(res.body.items.map((i: AttachmentBody) => i.attachmentId)).toEqual([idB, idC, idA]);
  });

  it('⭐ 질의 0개면 상한 없이 전건이 온다 — F4(51 행. DEFAULT_SIZE=50 이면 못 잡는다)', async () => {
    const res = await get('');
    expect(res.body.items.length).toBe(51);
  });

  it('⭐ 없는 대상은 404 가 아니라 200 { items: [] } 다 — N1', async () => {
    const res = await get('targetTypeCode=NOTICE&targetId=999999999');
    expect(res.body.items).toEqual([]);
  });

  it('⛔ enum 밖 targetTypeCode 는 400 이다 — N2(통보 156)', async () => {
    await request(app.getHttpServer()).get(`${PATH}?targetTypeCode=UNSUPPORTED_TARGET`).set('Cookie', cookie).expect(400);
  });

  it('⛔ 정수가 아닌 targetId 는 400 이다 — N3', async () => {
    await request(app.getHttpServer()).get(`${PATH}?targetId=abc`).set('Cookie', cookie).expect(400);
  });

  it('⭐ 계약 스키마를 만족하고, storageKey·checksumSha256 은 없으며 값이 맞다 — V1·V2', async () => {
    const res = await get('targetTypeCode=WAREHOUSE&targetId=1001');
    const validate = validator('GET /app/attachments');
    expect(validate(res.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    const item = res.body.items.find((i: AttachmentBody) => i.attachmentId === idA);
    expect('storageKey' in item).toBe(false);
    expect('checksumSha256' in item).toBe(false);
    expect(item).toMatchObject({
      fileName: `${PREFIX}-A`,
      contentType: 'image/png',
      byteSize: 1000,
      uploadedBy: uploadedById,
      // 다형 판별자 «쌍»과 정렬 축은 값까지 본다 — 계약이 integer 라고만 적어
      // ajv 가 «어느 칸에서 왔는지»를 못 본다(리뷰 #429 Minor-1).
      targetTypeCode: 'WAREHOUSE',
      targetId: 1001,
      uploadedAt: at(10).toISOString(),
    });
  });

  // ⚠ 반증 불가(I-34.md R-5) — 계약이 403 을 선언하지 않아 가드가 권한표를 안 본다.
  // 이 스펙의 세션은 역할을 하나도 받지 않아 이미 권한 0개다. 오늘의 사실을 기록할 뿐,
  // `manual-permissions.ts` 에 줄을 더해도 이 테스트는 여전히 200 이다(반증하지 못한다) —
  // 계약이 나중에 403 을 열 때 갈림길을 지키려고 남긴다.
  it('⚠ 권한 0개인 세션도 200 이다 — P1(반증 불가 · 계약 403 미선언)', async () => {
    await get('targetTypeCode=NOTICE&targetId=1001');
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function get(qs: string): request.Test {
    return request(app.getHttpServer())
      .get(qs ? `${PATH}?${qs}` : PATH)
      .set('Cookie', cookie)
      .expect(200);
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

  async function makeFixture(): Promise<void> {
    // ⛔ 역할·권한을 하나도 안 준다 — P1(권한 0개 세션)을 그대로 이 세션이 낸다.
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '첨부목록검사', status_code: 'EMPLOYED' },
    });
    uploadedById = Number(user.app_user_id);
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    cookie = await login();

    const base = { uploaded_by: user.app_user_id, storage_key: 'e2e/attachment/not-a-real-key' };
    const named = [
      { file_name: `${PREFIX}-A`, target_type_code: 'WAREHOUSE', target_id: 1001, mime_type: 'image/png', file_size: 1000, uploaded_at: at(10), ...base },
      { file_name: `${PREFIX}-B`, target_type_code: 'WAREHOUSE', target_id: 1001, mime_type: 'image/png', file_size: 1100, uploaded_at: at(30), ...base },
      { file_name: `${PREFIX}-C`, target_type_code: 'NOTICE', target_id: 1001, mime_type: 'image/png', file_size: 1200, uploaded_at: at(20), ...base },
      { file_name: `${PREFIX}-D`, target_type_code: 'WAREHOUSE', target_id: 2002, mime_type: 'image/png', file_size: 1300, uploaded_at: at(40), ...base },
      { file_name: `${PREFIX}-E`, target_type_code: 'NOTICE', target_id: 2002, mime_type: 'image/png', file_size: 1400, uploaded_at: at(50), ...base },
      // ⭐ F·G — uploaded_at 이 «완전히 같다»(S2). 나중에 심은 쪽(G)이 id 가 커서
      //   `attachment_id desc` 로 먼저 나와야 한다(선례 `trace-lot-status-event.e2e-spec.ts`).
      { file_name: `${PREFIX}-F`, target_type_code: 'WAREHOUSE', target_id: 3003, mime_type: 'image/png', file_size: 1500, uploaded_at: at(60), ...base },
      { file_name: `${PREFIX}-G`, target_type_code: 'WAREHOUSE', target_id: 3003, mime_type: 'image/png', file_size: 1600, uploaded_at: at(60), ...base },
    ];
    // ⭐ 채움 44 — 전건 51 이 되게 한다(F4/#6). 위 일곱 단언 어디와도 안 겹치는 좌표
    //   (NOTICE·9001)를 쓴다 — WAREHOUSE 로 잡으면 #4 가 깨진다.
    const filler = Array.from({ length: 44 }, () => ({
      file_name: `${PREFIX}-FILL`,
      target_type_code: 'NOTICE',
      target_id: 9001,
      mime_type: 'application/octet-stream',
      file_size: 1,
      uploaded_at: at(0),
      ...base,
    }));
    await prisma.attachment.createMany({ data: [...filler, ...named] });

    const rows = await prisma.attachment.findMany({
      where: { file_name: { in: ['A', 'B', 'C', 'D', 'F', 'G'].map((k) => `${PREFIX}-${k}`) } },
      select: { file_name: true, attachment_id: true },
    });
    const byName = new Map(rows.map((r) => [r.file_name, Number(r.attachment_id)]));
    idA = idOf(byName, `${PREFIX}-A`);
    idB = idOf(byName, `${PREFIX}-B`);
    idC = idOf(byName, `${PREFIX}-C`);
    idD = idOf(byName, `${PREFIX}-D`);
    idF = idOf(byName, `${PREFIX}-F`);
    idG = idOf(byName, `${PREFIX}-G`);
  }

  async function cleanup(): Promise<void> {
    await prisma.attachment.deleteMany({ where: { file_name: { startsWith: PREFIX } } });
    const target = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (target) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
  }
});

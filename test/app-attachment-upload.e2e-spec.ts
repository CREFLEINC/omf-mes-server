/**
 * 첨부 올리기 `POST /app/attachments`(#652).
 *
 * 창고 도면(`WAREHOUSE`)과 공지 첨부(`NOTICE`)를 multipart 로 받아 `ATTACHMENT_STORAGE_ROOT` 아래 파일로 두고
 * `app.attachment` 행을 만든다. 저장 경로는 스펙마다 임시 디렉터리로 바꿔 끼운다.
 * ⛔ 만든 행을 반드시 지운다 — 목록 스펙(`app-attachment.e2e-spec.ts`)이 표 전체 건수를 단언하고, 이 파일이 먼저 돈다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-attachment-upload-probe';
const NOTICE_ONLY_ID = 'e2e-attachment-upload-notice-only';
const PASSWORD = '첨부올리기-검사-비밀번호';
const PREFIX = 'ATTUP-E2E';
const ROLE = 'E2E_ATTUP_LAYOUT';
const NOTICE_ROLE = 'E2E_ATTUP_NOTICE';
const PATH = '/api/app/attachments';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const PDF = Buffer.from('%PDF-1.7\n%공지 첨부\n');

function validator(status: number): ValidateFunction {
  const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/app-공통.json'), 'utf8')) as object;
  const pointer = `/paths/~1app~1attachments/post/responses/${String(status)}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password', 'uuid']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('첨부 올리기 (e2e)', () => {
  const previousRoot = process.env.ATTACHMENT_STORAGE_ROOT;
  let app: INestApplication;
  let prisma: PrismaService;
  let root: string;
  let cookie: string[];
  let noticeOnlyCookie: string[];
  let warehouseId: number;
  let noticeId: number;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'e2e-attachment-upload-'));
    process.env.ATTACHMENT_STORAGE_ROOT = root;
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
    await rm(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.ATTACHMENT_STORAGE_ROOT;
    else process.env.ATTACHMENT_STORAGE_ROOT = previousRoot;
  });

  it('⭐ 창고 도면 PNG 를 올리면 201 Attachment 이고 저장 경로에 같은 바이트가 남는다', async () => {
    const response = await upload({ targetTypeCode: 'WAREHOUSE', targetId: warehouseId }, PNG, 'drawing.png', 'image/png')
      .expect(201);

    const validate = validator(201);
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.body).toMatchObject({
      targetTypeCode: 'WAREHOUSE', targetId: warehouseId, fileName: 'drawing.png',
      contentType: 'image/png', byteSize: PNG.length,
    });
    const row = await prisma.attachment.findUniqueOrThrow({ where: { attachment_id: response.body.attachmentId } });
    expect(row.storage_key).toMatch(/^warehouse\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
    expect(await readFile(join(root, row.storage_key))).toEqual(PNG);
  });

  it('⭐ 한글 파일 이름이 깨지지 않는다 — multipart 파일 이름을 UTF-8 로 읽는다', async () => {
    const response = await upload({ targetTypeCode: 'WAREHOUSE', targetId: warehouseId }, PNG, '창고 도면.png', 'image/png')
      .expect(201);
    expect(response.body.fileName).toBe('창고 도면.png');
  });

  it('⭐ 도면 형식은 요청 MIME 이 아니라 매직바이트로 가린다 — JPEG 도 받는다', async () => {
    const response = await upload({ targetTypeCode: 'WAREHOUSE', targetId: warehouseId }, JPEG, 'drawing.png', 'image/png')
      .expect(201);
    expect(response.body.contentType).toBe('image/jpeg');
  });

  it('⛔ 창고 도면에 PNG·JPEG 가 아닌 파일은 file 칸의 400 이다', async () => {
    const response = await upload({ targetTypeCode: 'WAREHOUSE', targetId: warehouseId }, PDF, 'drawing.pdf', 'application/pdf')
      .expect(400);
    expect(response.body.errors).toEqual([expect.objectContaining({ field: 'file', code: 'INVALID' })]);
  });

  it('⭐ 공지 첨부는 비어 있지 않은 아무 파일이나 받는다', async () => {
    const response = await upload({ targetTypeCode: 'NOTICE', targetId: noticeId }, PDF, '공지.pdf', 'application/pdf')
      .expect(201);
    expect(response.body).toMatchObject({ targetTypeCode: 'NOTICE', contentType: 'application/pdf', fileName: '공지.pdf' });
  });

  it('⛔ 파일이 없거나 비었으면 file 칸의 400 이다', async () => {
    const missing = await request(app.getHttpServer())
      .post(PATH).set('Cookie', cookie).set('Idempotency-Key', randomUUID())
      .field('targetTypeCode', 'WAREHOUSE').field('targetId', String(warehouseId))
      .expect(400);
    expect(missing.body.errors).toEqual([expect.objectContaining({ field: 'file', code: 'REQUIRED' })]);

    const empty = await upload({ targetTypeCode: 'NOTICE', targetId: noticeId }, Buffer.alloc(0), 'empty.txt', 'text/plain')
      .expect(400);
    expect(empty.body.errors).toEqual([expect.objectContaining({ field: 'file', code: 'INVALID' })]);
  });

  it('⛔ 틀린 칸을 한 번에 짚는다 — targetTypeCode 누락·enum 밖·targetId 정수 아님', async () => {
    const missing = await request(app.getHttpServer())
      .post(PATH).set('Cookie', cookie).set('Idempotency-Key', randomUUID())
      .attach('file', PNG, { filename: 'drawing.png', contentType: 'image/png' })
      .expect(400);
    expect(missing.body.errors).toEqual([
      expect.objectContaining({ field: 'targetTypeCode', code: 'REQUIRED' }),
      expect.objectContaining({ field: 'targetId', code: 'REQUIRED' }),
    ]);

    const wrong = await upload({ targetTypeCode: 'BREAKDOWN', targetId: 'abc' }, PNG, 'drawing.png', 'image/png').expect(400);
    expect(wrong.body.errors).toEqual([
      expect.objectContaining({ field: 'targetTypeCode', code: 'INVALID' }),
      expect.objectContaining({ field: 'targetId', code: 'INVALID' }),
    ]);
  });

  it('⛔ 없는 창고·공지는 404 가 아니라 targetId 칸의 400 이다 — 계약이 404 를 선언하지 않았다', async () => {
    for (const targetTypeCode of ['WAREHOUSE', 'NOTICE']) {
      const response = await upload({ targetTypeCode, targetId: 999999999 }, PNG, 'x.png', 'image/png').expect(400);
      expect(response.body.errors).toEqual([expect.objectContaining({ field: 'targetId', code: 'INVALID' })]);
    }
  });

  it('⛔ 10MB 를 넘으면 413 이고 파일이 남지 않는다', async () => {
    const before = await filesUnder(root);
    const tooLarge = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);
    await upload({ targetTypeCode: 'WAREHOUSE', targetId: warehouseId }, tooLarge, 'huge.png', 'image/png').expect(413);
    expect(await filesUnder(root)).toEqual(before);
  });

  it('⛔ W-CO-08 이 없으면 403 이다 — 공지 화면(W-CO-04)만 가진 사용자도 막힌다(도출표 한계)', async () => {
    await request(app.getHttpServer())
      .post(PATH).set('Cookie', noticeOnlyCookie).set('Idempotency-Key', randomUUID())
      .field('targetTypeCode', 'NOTICE').field('targetId', String(noticeId))
      .attach('file', PDF, { filename: '공지.pdf', contentType: 'application/pdf' })
      .expect(403);
  });

  it('⭐ 같은 키·같은 파일은 같은 첨부를 재생하고 행·파일이 하나뿐이다', async () => {
    const key = randomUUID();
    const before = (await filesUnder(root)).length;
    const first = await upload({ targetTypeCode: 'NOTICE', targetId: noticeId }, PDF, 'replay.pdf', 'application/pdf', key)
      .expect(201);
    const again = await upload({ targetTypeCode: 'NOTICE', targetId: noticeId }, PDF, 'replay.pdf', 'application/pdf', key)
      .expect(201);

    expect(again.body).toEqual(first.body);
    expect(await prisma.attachment.count({ where: { file_name: 'replay.pdf' } })).toBe(1);
    expect(await filesUnder(root)).toHaveLength(before + 1);
  });

  it('⛔ 같은 키·다른 파일은 409 이고 파일을 쓰지 않는다', async () => {
    const key = randomUUID();
    await upload({ targetTypeCode: 'NOTICE', targetId: noticeId }, PDF, 'conflict.pdf', 'application/pdf', key).expect(201);
    const before = await filesUnder(root);
    await upload({ targetTypeCode: 'NOTICE', targetId: noticeId }, PNG, 'conflict.png', 'image/png', key).expect(409);
    expect(await filesUnder(root)).toEqual(before);
  });

  it('⛔ 저장 경로가 없으면 503 이다', async () => {
    delete process.env.ATTACHMENT_STORAGE_ROOT;
    try {
      await upload({ targetTypeCode: 'WAREHOUSE', targetId: warehouseId }, PNG, 'drawing.png', 'image/png').expect(503);
    } finally {
      process.env.ATTACHMENT_STORAGE_ROOT = root;
    }
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function upload(
    fields: { targetTypeCode: string; targetId: number | string },
    bytes: Buffer,
    filename: string,
    contentType: string,
    key = randomUUID(),
  ): request.Test {
    return request(app.getHttpServer())
      .post(PATH)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key)
      .field('targetTypeCode', fields.targetTypeCode)
      .field('targetId', String(fields.targetId))
      .attach('file', bytes, { filename, contentType });
  }

  async function filesUnder(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort();
  }

  async function login(loginId: string): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function makeFixture(): Promise<void> {
    for (const [loginId, roleCode, permission] of [
      [LOGIN_ID, ROLE, 'W-CO-08'],
      [NOTICE_ONLY_ID, NOTICE_ROLE, 'W-CO-04'],
    ] as const) {
      const user = await prisma.app_user.create({ data: { login_id: loginId, user_name: loginId, status_code: 'EMPLOYED' } });
      await prisma.user_credential.create({
        data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
      });
      const role = await prisma.role.create({ data: { role_code: roleCode, role_name: roleCode } });
      await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: permission } });
      await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    }
    cookie = await login(LOGIN_ID);
    noticeOnlyCookie = await login(NOTICE_ONLY_ID);

    const plant = await prisma.plant.findFirstOrThrow();
    const unit = await prisma.business_unit.findFirstOrThrow();
    const firstCode = async (groupCode: string): Promise<string> => (await prisma.code_value.findFirstOrThrow({
      where: { is_active: true, code_group: { group_code: groupCode } },
    })).code;
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id, business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`, warehouse_name: `${PREFIX}-WH`,
        warehouse_type_code: await firstCode('WAREHOUSE_TYPE'),
        management_level_code: await firstCode('MANAGEMENT_LEVEL'),
      },
    });
    warehouseId = Number(warehouse.warehouse_id);
    const notice = await prisma.notice.create({
      data: { notice_no: `${PREFIX}-N1`, title: `${PREFIX} 공지`, content: '첨부 올리기 검사' },
    });
    noticeId = Number(notice.notice_id);
  }

  async function cleanup(): Promise<void> {
    const users = await prisma.app_user.findMany({
      where: { login_id: { in: [LOGIN_ID, NOTICE_ONLY_ID] } },
      select: { app_user_id: true },
    });
    const userIds = users.map((user) => user.app_user_id);
    await prisma.attachment.deleteMany({ where: { uploaded_by: { in: userIds } } });
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_credential.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.app_user.deleteMany({ where: { app_user_id: { in: userIds } } });
    const roles = await prisma.role.findMany({ where: { role_code: { in: [ROLE, NOTICE_ROLE] } } });
    await prisma.role_permission.deleteMany({ where: { role_id: { in: roles.map((role) => role.role_id) } } });
    await prisma.role.deleteMany({ where: { role_code: { in: [ROLE, NOTICE_ROLE] } } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.notice.deleteMany({ where: { notice_no: { startsWith: PREFIX } } });
  }
});

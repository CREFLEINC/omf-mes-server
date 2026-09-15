/**
 * 첨부 내려받기 `GET /app/attachments/{attachmentId}/content`(#652).
 *
 * 올리기(`POST /app/attachments`)로 만든 첨부를 같은 바이트로 내린다. 계약이 이 경로에 404 만 선언해
 * 권한 게이트가 없다 — 로그인 세션이면 받는다.
 * ⛔ 만든 행을 반드시 지운다 — 목록 스펙(`app-attachment.e2e-spec.ts`)이 표 전체 건수를 단언한다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-attachment-content-probe';
const NOPERM_ID = 'e2e-attachment-content-noperm';
const PASSWORD = '첨부내려받기-검사-비밀번호';
const PREFIX = 'ATTCT-E2E';
const ROLE = 'E2E_ATTCT_LAYOUT';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.7\n%공지 첨부\n');

describe('첨부 내려받기 (e2e)', () => {
  const previousRoot = process.env.ATTACHMENT_STORAGE_ROOT;
  let app: INestApplication;
  let prisma: PrismaService;
  let root: string;
  let outside: string;
  let cookie: string[];
  let noPermCookie: string[];
  let userId: bigint;
  let warehouseId: number;
  let noticeId: number;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'e2e-attachment-content-'));
    outside = await mkdtemp(join(tmpdir(), 'e2e-attachment-outside-'));
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
    await rm(outside, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.ATTACHMENT_STORAGE_ROOT;
    else process.env.ATTACHMENT_STORAGE_ROOT = previousRoot;
  });

  it('⭐ 올린 PNG 를 같은 바이트로 내린다 — image/png · inline · private, no-store · nosniff', async () => {
    const id = await upload('WAREHOUSE', warehouseId, PNG, 'drawing.png', 'image/png');
    const response = await content(id, cookie).expect(200);

    expect(response.body).toEqual(PNG);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['content-length']).toBe(String(PNG.length));
    expect(response.headers['content-disposition']).toBe(`inline; filename="drawing.png"; filename*=UTF-8''drawing.png`);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('⭐ 한글 파일 이름은 filename* 로 싣는다 — RFC 5987', async () => {
    const id = await upload('WAREHOUSE', warehouseId, PNG, '창고 도면.png', 'image/png');
    const response = await content(id, cookie).expect(200);

    expect(response.headers['content-disposition']).toBe(
      `inline; filename="__ __.png"; filename*=UTF-8''${encodeURIComponent('창고 도면.png')}`,
    );
  });

  it('⭐ PNG·JPEG 가 아닌 첨부는 application/octet-stream · attachment 로 내린다', async () => {
    const id = await upload('NOTICE', noticeId, PDF, 'notice.pdf', 'application/pdf');
    const response = await content(id, cookie).expect(200);

    expect(response.body).toEqual(PDF);
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['content-disposition']).toMatch(/^attachment; filename="notice\.pdf"/);
  });

  it('⛔ 없는 첨부는 404 ErrorResponse 다', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/app/attachments/999999999/content').set('Cookie', cookie).expect(404);
    expect(response.body.errors).toEqual([expect.objectContaining({ code: 'NOT_FOUND' })]);
  });

  it('⛔ 행은 있는데 파일이 없으면 404 다 — 볼륨이 빠진 배포를 500 으로 숨기지 않는다', async () => {
    const id = await row('notice/2026/09/사라진-파일.bin');
    await request(app.getHttpServer()).get(`/api/app/attachments/${String(id)}/content`).set('Cookie', cookie).expect(404);
  });

  it('⛔ 저장 경로 밖을 가리키는 storage_key 는 읽지 않고 404 다', async () => {
    await writeFile(join(outside, 'secret.txt'), 'secret');
    const id = await row(relative(root, join(outside, 'secret.txt')));
    await request(app.getHttpServer()).get(`/api/app/attachments/${String(id)}/content`).set('Cookie', cookie).expect(404);
  });

  it('⚠ 권한 0개 세션도 200 이다 — 계약이 403 을 선언하지 않았다', async () => {
    const id = await upload('WAREHOUSE', warehouseId, PNG, 'noperm.png', 'image/png');
    const response = await content(id, noPermCookie).expect(200);
    expect(response.body).toEqual(PNG);
  });

  it('⛔ 로그인하지 않으면 401 이다', async () => {
    const id = await upload('WAREHOUSE', warehouseId, PNG, 'anonymous.png', 'image/png');
    await request(app.getHttpServer()).get(`/api/app/attachments/${String(id)}/content`).expect(401);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function upload(targetTypeCode: string, targetId: number, bytes: Buffer, filename: string, contentType: string): Promise<number> {
    const response = await request(app.getHttpServer())
      .post('/api/app/attachments')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .field('targetTypeCode', targetTypeCode)
      .field('targetId', String(targetId))
      .attach('file', bytes, { filename, contentType })
      .expect(201);
    return response.body.attachmentId as number;
  }

  function content(id: number, sessionCookie: string[]): request.Test {
    return request(app.getHttpServer())
      .get(`/api/app/attachments/${String(id)}/content`)
      .set('Cookie', sessionCookie)
      .buffer(true)
      .parse((stream, callback) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => callback(null, Buffer.concat(chunks)));
      });
  }

  /** 올리기를 거치지 않은 행 — 파일이 없거나 이상한 키를 가진 자리를 만든다. */
  async function row(storageKey: string): Promise<bigint> {
    const created = await prisma.attachment.create({
      data: {
        target_type_code: 'NOTICE', target_id: BigInt(noticeId), file_name: `${PREFIX}.bin`,
        storage_key: storageKey, mime_type: 'application/octet-stream', file_size: 1n, uploaded_by: userId,
      },
    });
    return created.attachment_id;
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
    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: LOGIN_ID, status_code: 'EMPLOYED' } });
    userId = user.app_user_id;
    const noPerm = await prisma.app_user.create({ data: { login_id: NOPERM_ID, user_name: NOPERM_ID, status_code: 'EMPLOYED' } });
    for (const account of [user, noPerm]) {
      await prisma.user_credential.create({
        data: { app_user_id: account.app_user_id, password_hash: await hashPassword(PASSWORD) },
      });
    }
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: ROLE } });
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: 'W-CO-08' } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login(LOGIN_ID);
    noPermCookie = await login(NOPERM_ID);

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
      data: { notice_no: `${PREFIX}-N1`, title: `${PREFIX} 공지`, content: '첨부 내려받기 검사' },
    });
    noticeId = Number(notice.notice_id);
  }

  async function cleanup(): Promise<void> {
    const users = await prisma.app_user.findMany({
      where: { login_id: { in: [LOGIN_ID, NOPERM_ID] } },
      select: { app_user_id: true },
    });
    const userIds = users.map((user) => user.app_user_id);
    await prisma.attachment.deleteMany({ where: { uploaded_by: { in: userIds } } });
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_credential.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.app_user.deleteMany({ where: { app_user_id: { in: userIds } } });
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.notice.deleteMany({ where: { notice_no: { startsWith: PREFIX } } });
  }
});

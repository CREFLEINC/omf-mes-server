/**
 * 검사기준 엑셀 올리기(omf-all-around#199 · 장부 P-140).
 *
 * ⭐ 이미 있는 기능을 차례로 부른다 — 새 기준코드는 기준·버전·항목을 세우고, 있는 기준코드는
 * 신규 버전을 발행해 엑셀 항목으로 채운다. 실패한 묶음은 아무것도 남기지 않는다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Workbook } from 'exceljs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { REVISION_STATUS } from '../src/planning/revision-status';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-ipimp-probe';
const NOPERM_ID = 'e2e-ipimp-noperm';
const PASSWORD = '검사기준-올리기-비밀번호';
const PREFIX = 'E2E_IPIMP';
const ROLE = 'E2E_IPIMP_ROLE';
const HEADER = ['기준코드', '기준명', '검사유형', '유효시작일', '샘플링방식', '샘플비율', '검사주기', '순서', '항목코드', '항목명', '데이터유형', '단위', '하한', '상한'];

const key = (): string => randomUUID();

describe('검사기준 엑셀 올리기 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    for (const id of [LOGIN_ID, NOPERM_ID]) {
      const user = await prisma.app_user.create({ data: { login_id: id, user_name: id, status_code: 'EMPLOYED' } });
      await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    }
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '검사기준 올리기용' } });
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: 'W-06-02' } });
    const user = await prisma.app_user.findUniqueOrThrow({ where: { login_id: LOGIN_ID } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login(LOGIN_ID);
    noPermCookie = await login(NOPERM_ID);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⭐ 새 기준코드는 기준·작성중 버전·항목이 생긴다', async () => {
    const result = await upload([
      row('NEW', 1, 'A', 'NUMERIC', 1, 2),
      row('NEW', 2, 'B', 'TEXT', null, null),
    ]);
    expect(result).toEqual({ succeeded: 1, failed: [] });

    const plan = await prisma.inspection_plan.findUniqueOrThrow({
      where: { inspection_plan_code: `${PREFIX}-NEW` },
      include: { inspection_plan_version: { include: { inspection_item_spec: { orderBy: { sequence_no: 'asc' } } } } },
    });
    expect(plan.inspection_plan_version).toHaveLength(1);
    const [version] = plan.inspection_plan_version;
    expect(version.status_code).toBe(REVISION_STATUS.DRAFT);
    expect(Number(version.sampling_ratio)).toBe(10);
    expect(version.inspection_item_spec.map((i) => [i.sequence_no, i.inspection_item_code])).toEqual([
      [1, `${PREFIX}-A`],
      [2, `${PREFIX}-B`],
    ]);
  });

  it('⭐⭐ 있는 기준코드는 확정 버전을 그대로 두고 엑셀 항목으로 새 작성중 버전을 만든다', async () => {
    await upload([row('REV', 1, 'OLD', 'NUMERIC', 1, 2)]);
    const plan = await prisma.inspection_plan.findUniqueOrThrow({ where: { inspection_plan_code: `${PREFIX}-REV` } });
    const v1 = await prisma.inspection_plan_version.findFirstOrThrow({ where: { inspection_plan_id: plan.inspection_plan_id } });
    await request(app.getHttpServer())
      .post(`/api/quality/inspection-plan-versions/${v1.inspection_plan_version_id}:confirm`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(200);

    const result = await upload([row('REV', 1, 'NEW1', 'NUMERIC', 3, 4), row('REV', 2, 'NEW2', 'TEXT', null, null)]);
    expect(result).toEqual({ succeeded: 1, failed: [] });

    const versions = await prisma.inspection_plan_version.findMany({
      where: { inspection_plan_id: plan.inspection_plan_id },
      orderBy: { plan_version: 'asc' },
      include: { inspection_item_spec: { orderBy: { sequence_no: 'asc' } } },
    });
    expect(versions.map((v) => [v.plan_version, v.status_code])).toEqual([
      [1, REVISION_STATUS.CONFIRMED],
      [2, REVISION_STATUS.DRAFT],
    ]);
    expect(versions[0].inspection_item_spec.map((i) => i.inspection_item_code)).toEqual([`${PREFIX}-OLD`]);
    // 복사된 항목은 빠지고 엑셀 항목만 남는다.
    expect(versions[1].inspection_item_spec.map((i) => i.inspection_item_code)).toEqual([`${PREFIX}-NEW1`, `${PREFIX}-NEW2`]);
  });

  it('⛔ 실패한 묶음은 아무것도 남기지 않고, 다른 묶음은 반영된다', async () => {
    const result = await upload([
      row('BAD', 1, 'A', 'NUMERIC', 1, 2, '없는단위'),
      row('GOOD', 1, 'A', 'NUMERIC', 1, 2),
      row('LIMIT', 1, 'A', 'NUMERIC', 5, 1),
    ]);
    expect(result.succeeded).toBe(1);
    expect(result.failed.map((f: { key: string; index: number }) => [f.key, f.index])).toEqual([
      [`${PREFIX}-BAD`, 0],
      [`${PREFIX}-LIMIT`, 2],
    ]);
    expect(result.failed[0].errors[0].message).toContain('엑셀 2행');
    for (const code of ['BAD', 'LIMIT']) {
      expect(await prisma.inspection_plan.findUnique({ where: { inspection_plan_code: `${PREFIX}-${code}` } })).toBeNull();
    }
  });

  it('⛔ 작성중 버전뿐인 기준은 신규 버전 발행 문구로 실패하고 버전이 늘지 않는다', async () => {
    await upload([row('DRAFT', 1, 'A', 'NUMERIC', 1, 2)]);
    const result = await upload([row('DRAFT', 1, 'B', 'NUMERIC', 1, 2)]);
    expect(result.succeeded).toBe(0);
    expect(result.failed[0].errors[0].message).toContain('확정된 버전에서만');
    const plan = await prisma.inspection_plan.findUniqueOrThrow({ where: { inspection_plan_code: `${PREFIX}-DRAFT` } });
    expect(await prisma.inspection_plan_version.count({ where: { inspection_plan_id: plan.inspection_plan_id } })).toBe(1);
  });

  it('⭐ 샘플 비율이 없어도 작성중으로 들어가고, 확정이 비율을 요구하며, 다시 올리면 확정 버전의 비율을 이어 쓴다', async () => {
    const noRatio = (seq: number, item: string): unknown[] => {
      const r = row('NORATIO', seq, item, 'NUMERIC', 1, 2);
      r[5] = null;
      return r;
    };
    expect(await upload([noRatio(1, 'A')])).toEqual({ succeeded: 1, failed: [] });
    const plan = await prisma.inspection_plan.findUniqueOrThrow({ where: { inspection_plan_code: `${PREFIX}-NORATIO` } });
    const v1 = await prisma.inspection_plan_version.findFirstOrThrow({ where: { inspection_plan_id: plan.inspection_plan_id } });
    expect(v1.sampling_ratio).toBeNull();

    const blocked = await request(app.getHttpServer())
      .post(`/api/quality/inspection-plan-versions/${v1.inspection_plan_version_id}:confirm`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(400);
    expect(blocked.body.errors[0]).toMatchObject({ field: 'samplingRatio', code: 'REQUIRED' });

    // 화면에서 비율을 넣은 셈 — 이 경로의 관심은 확정·재업로드다.
    await prisma.inspection_plan_version.update({ where: { inspection_plan_version_id: v1.inspection_plan_version_id }, data: { sampling_ratio: 15 } });
    await request(app.getHttpServer())
      .post(`/api/quality/inspection-plan-versions/${v1.inspection_plan_version_id}:confirm`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(200);

    expect(await upload([noRatio(1, 'B')])).toEqual({ succeeded: 1, failed: [] });
    const v2 = await prisma.inspection_plan_version.findFirstOrThrow({ where: { inspection_plan_id: plan.inspection_plan_id, plan_version: 2 } });
    expect(Number(v2.sampling_ratio)).toBe(15);
  });

  it('⛔ 권한이 없으면 403, 파일이 없거나 읽을 수 없으면 400 이다', async () => {
    await request(app.getHttpServer())
      .post('/api/quality/inspection-plans:import')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .attach('file', await workbook([row('X', 1, 'A', 'NUMERIC', 1, 2)]), 'plan.xlsx')
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/quality/inspection-plans:import')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .attach('file', Buffer.from('not a workbook'), 'plan.xlsx')
      .expect(400);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function row(
    code: string,
    sequenceNo: number,
    itemCode: string,
    dataType: string,
    lower: number | null,
    upper: number | null,
    uom: string | null = null,
  ): unknown[] {
    return [`${PREFIX}-${code}`, `올리기 ${code}`, 'IQC', '2026-10-01', 'SAMPLE_BY_LOT', 10, 'PRODUCTION_LOT', sequenceNo, `${PREFIX}-${itemCode}`, itemCode, dataType, uom, lower, upper];
  }

  async function workbook(rows: unknown[][]): Promise<Buffer> {
    const book = new Workbook();
    const sheet = book.addWorksheet('검사기준');
    sheet.addRow(HEADER);
    rows.forEach((r) => sheet.addRow(r));
    return Buffer.from(await book.xlsx.writeBuffer());
  }

  async function upload(rows: unknown[][]): Promise<{ succeeded: number; failed: { key: string; index: number; errors: { message: string }[] }[] }> {
    const response = await request(app.getHttpServer())
      .post('/api/quality/inspection-plans:import')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .attach('file', await workbook(rows), { filename: 'plan.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      .expect(200);
    return response.body;
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

  async function cleanup(): Promise<void> {
    const plans = await prisma.inspection_plan.findMany({
      where: { inspection_plan_code: { startsWith: PREFIX } },
      select: { inspection_plan_id: true },
    });
    const planIds = plans.map((p) => p.inspection_plan_id);
    const versions = await prisma.inspection_plan_version.findMany({
      where: { inspection_plan_id: { in: planIds } },
      select: { inspection_plan_version_id: true },
    });
    const versionIds = versions.map((v) => v.inspection_plan_version_id);
    await prisma.inspection_item_spec.deleteMany({ where: { inspection_plan_version_id: { in: versionIds } } });
    await prisma.inspection_plan_version.deleteMany({ where: { inspection_plan_version_id: { in: versionIds } } });
    await prisma.inspection_plan.deleteMany({ where: { inspection_plan_id: { in: planIds } } });

    for (const id of [LOGIN_ID, NOPERM_ID]) {
      const target = await prisma.app_user.findUnique({ where: { login_id: id } });
      if (!target) continue;
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});

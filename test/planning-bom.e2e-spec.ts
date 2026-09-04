/**
 * BOM.
 *
 * ⛔ ERP 정본이라 이 시스템이 만들거나 지우지 않는다 — 고치는 것은 구성품의 MES 확장
 * 네 칸뿐이고, 그 편집을 **헤더 상태로 막지 않는다**(계약).
 * ⭐ 저장 충돌의 원인을 가른다 — 사람인지 기간계 재동기화인지.
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
import { REVISION_STATUS } from '../src/planning/revision-status';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-bom-probe';
const NOPERM_ID = 'e2e-bom-noperm';
const PASSWORD = 'BOM-검사-비밀번호';
const PREFIX = 'E2E_BOM';
const ROLE = 'E2E_BOM_ROLE';

function validator(operation: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/mdm-기준정보.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/200/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

const key = (): string => randomUUID();

describe('BOM (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let parentItemId = 0;
  let componentItemId = 0;
  let uomId = 0;
  let processId = 0;
  let routingOperationId = 0;
  let foreignOperationId = 0;
  let bomId = 0;
  let componentId = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: 'BOM검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const other = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '권한없음', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: other.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    noPermCookie = await login(NOPERM_ID);

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: 'BOM검사용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-06-05' },
    });
    await prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    cookie = await login();

    uomId = Number((await prisma.uom.findFirstOrThrow({ select: { uom_id: true } })).uom_id);
    parentItemId = await createItem('P');
    componentItemId = await createItem('C');
    const foreignItemId = await createItem('F');
    processId = Number(
      (
        await prisma.process.create({
          data: {
            process_code: `${PREFIX}-PR`,
            process_name: '검사공정',
            process_type_code: 'ASSEMBLY',
          },
        })
      ).process_id,
    );
    routingOperationId = await createOperation(parentItemId, 1);
    // 다른 품목의 공정 — 이것을 걸면 400 이어야 한다.
    foreignOperationId = await createOperation(foreignItemId, 2);

    // BOM 은 ERP 수신이라 등록 경로가 없다 — 검사 대상을 DB 로 세운다.
    bomId = await createBom(`${PREFIX}-B1`, 1, REVISION_STATUS.CONFIRMED);
    componentId = Number(
      (
        await prisma.bom_component.create({
          data: {
            bom_id: bomId,
            component_item_id: componentItemId,
            required_qty: 2,
            uom_id: uomId,
            sequence_no: 1,
          },
        })
      ).bom_component_id,
    );
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('목록·상세가 계약 스키마를 만족하고 헤더는 언제나 읽기 전용이다', async () => {
    const list = await request(app.getHttpServer())
      .get(`/api/planning/boms?parentItemId=${parentItemId}`)
      .set('Cookie', cookie)
      .expect(200);
    const listValidate = validator('GET /planning/boms');
    expect(listValidate(list.body)).toBe(true);
    expect(listValidate.errors ?? []).toEqual([]);

    const detail = await request(app.getHttpServer())
      .get(`/api/planning/boms/${bomId}`)
      .set('Cookie', cookie)
      .expect(200);
    const detailValidate = validator('GET /planning/boms/{bomId}');
    expect(detailValidate(detail.body)).toBe(true);
    expect(detailValidate.errors ?? []).toEqual([]);
    // ⛔ 참조 건수로 갈리지 않는다 — ERP 정본이라 언제나 잠긴다.
    expect(detail.body.editability).toEqual({
      codeEditable: false,
      reason: 'RECEIVED_FROM_ERP',
      referenceCount: null,
    });
  });

  it('구성품 목록·상세가 계약 스키마를 만족하고 상세가 ETag 를 준다', async () => {
    const list = await request(app.getHttpServer())
      .get(`/api/planning/boms/${bomId}/components`)
      .set('Cookie', cookie)
      .expect(200);
    const listValidate = validator('GET /planning/boms/{bomId}/components');
    expect(listValidate(list.body)).toBe(true);
    expect(listValidate.errors ?? []).toEqual([]);

    const detail = await request(app.getHttpServer())
      .get(`/api/planning/boms/${bomId}/components/${componentId}`)
      .set('Cookie', cookie)
      .expect(200);
    const detailValidate = validator('GET /planning/boms/{bomId}/components/{bomComponentId}');
    expect(detailValidate(detail.body)).toBe(true);
    expect(detailValidate.errors ?? []).toEqual([]);
    // 「행 단위 GET 신설로 PUT 의 If-Match 가 실을 ETag 자리가 비로소 생겼다」(계약).
    expect(detail.headers.etag).toBe('1');
    expect(detail.body.editability.reason).toBe('RECEIVED_FROM_ERP');
  });

  it('⭐ MES 확장 네 칸만 바뀌고 ERP 원본 열은 그대로다', async () => {
    const saved = await request(app.getHttpServer())
      .put(`/api/planning/boms/${bomId}/components/${componentId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({
        routingOperationId,
        actualUseProcessId: processId,
        lotTraceRequired: true,
        backflushAllowed: true,
      })
      .expect(200);

    expect(saved.body).toMatchObject({
      routingOperationId,
      actualUseProcessId: processId,
      lotTraceRequired: true,
      backflushAllowed: true,
      // ERP 원본 열은 요청에 없었고 그대로다.
      componentItemId,
      requiredQty: 2,
      sequenceNo: 1,
    });
    expect(saved.headers.etag).toBe('2');
  });

  it('⭐ 안 보낸 확장 칸은 «비운다» — 공정 연결을 지우는 유일한 길이다', async () => {
    const cleared = await request(app.getHttpServer())
      .put(`/api/planning/boms/${bomId}/components/${componentId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '2')
      .send({ lotTraceRequired: false, backflushAllowed: false })
      .expect(200);

    expect(cleared.body.routingOperationId).toBeNull();
    expect(cleared.body.actualUseProcessId).toBeNull();
  });

  it('⛔ 다른 품목의 Routing 공정·없는 공정은 400 이다', async () => {
    const foreign = await request(app.getHttpServer())
      .put(`/api/planning/boms/${bomId}/components/${componentId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '3')
      .send({ routingOperationId: foreignOperationId, lotTraceRequired: false, backflushAllowed: false })
      .expect(400);
    expect(foreign.body.errors[0]).toMatchObject({
      field: 'routingOperationId',
      code: 'INVALID',
    });

    const noProcess = await request(app.getHttpServer())
      .put(`/api/planning/boms/${bomId}/components/${componentId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '3')
      .send({ actualUseProcessId: 999999999, lotTraceRequired: false, backflushAllowed: false })
      .expect(400);
    expect(noProcess.body.errors[0]).toMatchObject({
      field: 'actualUseProcessId',
      code: 'INVALID',
    });
  });

  it('⭐⭐ 저장 충돌의 «원인»을 가른다 — 사람인지 기간계 재동기화인지', async () => {
    // 사람이 마지막으로 고친 행(위 검사가 updated_by 를 남겼다) → user.
    const byUser = await request(app.getHttpServer())
      .put(`/api/planning/boms/${bomId}/components/${componentId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ lotTraceRequired: false, backflushAllowed: false })
      .expect(409);
    expect(byUser.body).toEqual({
      conflictCause: 'user',
      message: expect.stringContaining('다른 사용자'),
    });

    // 연계는 세션이 없어 updated_by 를 못 채운다 — 그 행의 충돌은 erpSync 다.
    await prisma.bom_component.update({
      where: { bom_component_id: componentId },
      data: { updated_by: null },
    });
    const byErp = await request(app.getHttpServer())
      .put(`/api/planning/boms/${bomId}/components/${componentId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ lotTraceRequired: false, backflushAllowed: false })
      .expect(409);
    expect(byErp.body).toEqual({
      conflictCause: 'erpSync',
      message: expect.stringContaining('기간계'),
    });
  });

  it('⭐ 기본 BOM 은 품목당 하나다 — 새로 지정하면 앞의 것이 내려온다', async () => {
    const second = await createBom(`${PREFIX}-B2`, 1, REVISION_STATUS.CONFIRMED);

    await setDefault(bomId);
    const swapped = await setDefault(second);
    expect(swapped.body.isDefault).toBe(true);

    const list = await request(app.getHttpServer())
      .get(`/api/planning/boms?parentItemId=${parentItemId}`)
      .set('Cookie', cookie)
      .expect(200);
    const defaults = list.body.items.filter((b: { isDefault: boolean }) => b.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].bomId).toBe(second);
  });

  it('⭐ usableOnly 는 확정이고 기간 안인 BOM 만 낸다', async () => {
    const draft = await createBom(`${PREFIX}-B3`, 1, REVISION_STATUS.DRAFT);
    const expired = await createBom(`${PREFIX}-B4`, 1, REVISION_STATUS.CONFIRMED, '2020-01-01');

    const usable = await request(app.getHttpServer())
      .get(`/api/planning/boms?parentItemId=${parentItemId}&usableOnly=true`)
      .set('Cookie', cookie)
      .expect(200);
    const ids = usable.body.items.map((b: { bomId: number }) => b.bomId);

    expect(ids).toContain(bomId);
    expect(ids).not.toContain(draft);
    expect(ids).not.toContain(expired);
  });

  it('⭐ bomCode 로 좁힌다', async () => {
    const filtered = await request(app.getHttpServer())
      .get(`/api/planning/boms?parentItemId=${parentItemId}&bomCode=${PREFIX}-B1`)
      .set('Cookie', cookie)
      .expect(200);

    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.items[0].bomCode).toBe(`${PREFIX}-B1`);
  });

  it('⛔ 남의 BOM 의 구성품은 경로를 바꿔도 못 고친다', async () => {
    const otherBom = await createBom(`${PREFIX}-B5`, 1, REVISION_STATUS.CONFIRMED);

    await request(app.getHttpServer())
      .get(`/api/planning/boms/${otherBom}/components/${componentId}`)
      .set('Cookie', cookie)
      .expect(404);
  });

  it('⛔ 권한이 없으면 쓰기가 403 이고, 없는 BOM 은 404 다', async () => {
    await request(app.getHttpServer())
      .put(`/api/planning/boms/${bomId}/components/${componentId}`)
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ lotTraceRequired: false, backflushAllowed: false })
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/planning/boms/999999999')
      .set('Cookie', cookie)
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/planning/boms/999999999/components')
      .set('Cookie', cookie)
      .expect(404);
    await request(app.getHttpServer())
      .post('/api/planning/boms/999999999:set-default')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function setDefault(id: number): Promise<{ body: { isDefault: boolean } }> {
    const response = await request(app.getHttpServer())
      .post(`/api/planning/boms/${id}:set-default`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(200);
    return { body: response.body };
  }

  async function createItem(suffix: string): Promise<number> {
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-I${suffix}`,
        item_name: `검사품목${suffix}`,
        item_type_code: 'FINISHED',
        base_uom_id: uomId,
        lot_controlled: true,
      },
    });
    return Number(item.item_id);
  }

  async function createOperation(itemId: number, seq: number): Promise<number> {
    const routing = await prisma.routing.create({
      data: {
        item_id: itemId,
        routing_code: `${PREFIX}-R${seq}`,
        routing_version: 1,
        status_code: REVISION_STATUS.DRAFT,
      },
    });
    const operation = await prisma.routing_operation.create({
      data: {
        routing_id: routing.routing_id,
        operation_seq: 1,
        process_id: processId,
        operation_name: '검사라인',
      },
    });
    return Number(operation.routing_operation_id);
  }

  async function createBom(
    bomCode: string,
    version: number,
    statusCode: string,
    effectiveTo?: string,
  ): Promise<number> {
    const created = await prisma.bom.create({
      data: {
        parent_item_id: parentItemId,
        bom_code: bomCode,
        bom_version: version,
        status_code: statusCode,
        // ck_bom_dates — 종료가 있으면 시작 이상이어야 한다.
        effective_from: new Date(effectiveTo === undefined ? '2026-01-01' : '2019-01-01'),
        ...(effectiveTo === undefined ? {} : { effective_to: new Date(effectiveTo) }),
        base_qty: 1,
        base_uom_id: uomId,
      },
    });
    return Number(created.bom_id);
  }

  async function login(loginId: string = LOGIN_ID): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function cleanup(): Promise<void> {
    const items = await prisma.item.findMany({
      where: { item_code: { startsWith: PREFIX } },
      select: { item_id: true },
    });
    const ids = items.map((row) => row.item_id);
    const boms = await prisma.bom.findMany({
      where: { parent_item_id: { in: ids } },
      select: { bom_id: true },
    });
    await prisma.bom_component.deleteMany({
      where: { bom_id: { in: boms.map((row) => row.bom_id) } },
    });
    await prisma.bom.deleteMany({ where: { bom_id: { in: boms.map((row) => row.bom_id) } } });
    const routings = await prisma.routing.findMany({
      where: { item_id: { in: ids } },
      select: { routing_id: true },
    });
    const routingIds = routings.map((row) => row.routing_id);
    await prisma.routing_operation.deleteMany({ where: { routing_id: { in: routingIds } } });
    await prisma.routing.deleteMany({ where: { routing_id: { in: routingIds } } });
    await prisma.item.deleteMany({ where: { item_id: { in: ids } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });

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

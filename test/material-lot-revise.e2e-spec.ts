/**
 * 피처 014 S4 — 출력 전 자재 관리 LOT 수정(omf-all-around#349 · T025·T027).
 * POP(P-01-01)은 단말 토큰 + 작업자 + 멱등 키, 웹(W-01-14)은 세션 계정으로 부른다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { TOKEN_TYPE } from '../src/auth/session-resolver.service';
import { PERMISSIONS } from '../src/common/permissions/permissions';
import { reviseMaterialLotWithin } from '../src/core/lot';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'E14RV';
const TZ = 'Asia/Ho_Chi_Minh';
const WORKER_NO = `${PREFIX}-W1`;
const LOTS = '/api/logistics/material-lots';
const BATCHES = '/api/logistics/material-lot-batches';
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const YYMMDD = TODAY.replace(/-/g, '').slice(2);

interface Row {
  lotId: number;
  lotNo: string;
  lotQty: number;
  package: { uomId: number; count: number; qtyPerPackage: number } | null;
  creationModeCode: string;
}

describe('피처 014 S4 — 출력 전 자재 관리 LOT 수정 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let cookie: string;
  let narrowCookie: string;
  let popToken: string;
  let foreignPopToken: string;
  const ids: Record<string, bigint> = {};
  let seq = 0;
  let lots: Row[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    await cleanup();
    await makeMasters();
    cookie = await makeUser('ALL', PERMISSIONS.map((permission) => permission.code));
    narrowCookie = await makeUser('NARROW', ['W-01-01']);
    popToken = await terminalToken(ids.plant);
    foreignPopToken = await terminalToken(ids.foreignPlant);
    const order = await prisma.purchase_order.create({
      data: { purchase_order_no: `${PREFIX}-PO-1`, supplier_id: ids.supplier, business_unit_id: ids.unit, plant_id: ids.plant,
        order_date: new Date('2026-11-01T00:00:00.000Z'), status_code: 'CONFIRMED' },
    });
    await prisma.purchase_order_line.create({
      data: { purchase_order_id: order.purchase_order_id, line_no: 1, item_id: ids.item, uom_id: ids.ea, ordered_qty: 400 },
    });
    lots = await unprinted();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  const revisePath = (lotId: number): string => `${LOTS}/${String(lotId)}:revise`;
  const pack = (count: number, qtyPerPackage: number) => ({ uomId: Number(ids.box), count, qtyPerPackage });

  it('US3-1 Q6 100 → 80·패키징 8×10: 같은 LOT, 번호 수량 자리 80·새 일련, 감사 기록(옛·새 번호)', async () => {
    expect(lots.map((lot) => lot.lotQty)).toEqual([100, 100, 100, 100]);
    const target = lots[0];
    const response = await popPost(revisePath(target.lotId)).send({ qty: 80, package: pack(8, 10) }).expect(200);
    expect(response.body).toMatchObject({
      lotId: target.lotId, lotNo: `${PREFIX}-A|80|${YYMMDD}|${PREFIX}-S|0001`, lotQty: 80,
      package: { uomId: Number(ids.box), count: 8, qtyPerPackage: 10 }, creationModeCode: 'AUTO', lifecycleStatusCode: 'WAITING',
    });
    const row = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(target.lotId) } });
    expect(row).toMatchObject({ lot_no: `${PREFIX}-A|80|${YYMMDD}|${PREFIX}-S|0001`, package_count: 8 });
    expect(Number(row.initial_qty)).toBe(80);
    expect(await prisma.material_lot_po_plan.count({ where: { lot_id: BigInt(target.lotId) } })).toBe(1);

    const audits = await prisma.audit_event.findMany({ where: { target_type_code: 'LOT', target_id: BigInt(target.lotId) } });
    const revised = audits.find((audit) => audit.event_type_code === 'MATERIAL_LOT_REVISED' && audit.before_value !== null);
    expect(revised?.before_value).toMatchObject({ lotNo: target.lotNo, qty: 100 });
    expect(revised?.after_value).toMatchObject({ lotNo: `${PREFIX}-A|80|${YYMMDD}|${PREFIX}-S|0001`, qty: 80, package: { count: 8, qtyPerPackage: 10 } });
    expect(revised?.terminal_id).not.toBeNull();
    // 단말 작업자 감사(지금 수동 생성과 같은 기록)도 남는다.
    expect(audits.some((audit) => (audit.after_value as { workerNo?: string } | null)?.workerNo === WORKER_NO)).toBe(true);
  });

  it('US3-1 수량이 같고 패키징만 바꾸면 번호 그대로, package null 이면 패키징 없음(웹)', async () => {
    const target = lots[1];
    const repacked = await webPost(revisePath(target.lotId)).send({ qty: 100, package: pack(5, 20) }).expect(200);
    expect(repacked.body).toMatchObject({ lotNo: target.lotNo, package: { count: 5, qtyPerPackage: 20 } });
    const bare = await webPost(revisePath(target.lotId)).send({ qty: 100, package: null }).expect(200);
    expect(bare.body).toMatchObject({ lotNo: target.lotNo, package: null });
    const audit = await prisma.audit_event.findFirst({
      where: { target_type_code: 'LOT', target_id: BigInt(target.lotId), event_type_code: 'MATERIAL_LOT_REVISED' }, orderBy: { occurred_at: 'desc' },
    });
    expect(audit?.performed_by).toBe(ids.user);
  });

  it('US3-2 곱 불일치·qty ≤ 0 → 400, 고치지 않는다', async () => {
    const target = lots[2];
    await webPost(revisePath(target.lotId)).send({ qty: 90, package: pack(8, 10) }).expect(400);
    await webPost(revisePath(target.lotId)).send({ qty: 0, package: null }).expect(400);
    await webPost(revisePath(target.lotId)).send({ qty: 100, package: { uomId: 999999999, count: 10, qtyPerPackage: 10 } }).expect(400);
    const row = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(target.lotId) } });
    expect(row.lot_no).toBe(target.lotNo);
  });

  it('US3-4 Q6 줄인 빈 20 을 다음 조회가 새로 만들고, 늘리면 만들 양이 0 이다', async () => {
    const after = (await lotsOf(1, 20).expect(200)).body as { items: Row[]; generation: { createdNow: number } };
    expect(after.generation.createdNow).toBe(1);
    const made = after.items[after.items.length - 1];
    expect([made.lotQty, made.package?.count, made.package?.qtyPerPackage]).toEqual([20, 2, 10]);

    await webPost(revisePath(lots[3].lotId)).send({ qty: 150, package: null }).expect(200);
    const again = (await lotsOf(1, 20).expect(200)).body as { generation: { createdNow: number; creatableRemaining: number } };
    expect(again.generation).toMatchObject({ createdNow: 0, creatableRemaining: 0 });
  });

  it('US3-3 Q7 출력한 LOT 은 409 ALREADY_PRINTED, 폐기한 LOT 은 409 STATE_LOCKED', async () => {
    await webPost('/api/app/document-issues').send({ documentTypeCode: 'MATERIAL_LOT_LABEL', targets: [{ targetTypeCode: 'LOT', targetId: lots[2].lotId }] }).expect(201);
    const printed = await webPost(revisePath(lots[2].lotId)).send({ qty: 50, package: null }).expect(409);
    expect(printed.body.errors[0]).toMatchObject({ code: 'ALREADY_PRINTED' });

    await webPost('/api/trace/lots:void').send({ lotIds: [lots[3].lotId] }).expect(200);
    const voided = await webPost(revisePath(lots[3].lotId)).send({ qty: 50, package: null }).expect(409);
    expect(voided.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    await webPost(revisePath(999999999)).send({ qty: 50, package: null }).expect(404);
  });

  it('FR-016 수동으로 만든 LOT 도 출력 전이면 고친다, 같은 멱등 키 재전송은 같은 응답', async () => {
    const manual = (await webPost(BATCHES).send({
      plantId: Number(ids.plant), supplierId: Number(ids.supplier), itemId: Number(ids.item), lotQty: 30, package: null, lotCount: 1,
      businessDate: TODAY, occurredAt: new Date().toISOString(),
    }).expect(201)).body.lots as Row[];
    const key = randomUUID();
    const send = () => request(app.getHttpServer()).post(revisePath(manual[0].lotId)).set('Cookie', cookie).set('Idempotency-Key', key)
      .send({ qty: 25, package: null });
    const first = await send().expect(200);
    const second = await send().expect(200);
    expect(second.body).toEqual(first.body);
    expect(first.body).toMatchObject({ lotQty: 25, creationModeCode: 'MANUAL', lotNo: `${PREFIX}-A|25|${YYMMDD}|${PREFIX}-S|0001` });
  });

  it('FR-016 T027 권한 — P-01-01·W-01-14 없으면 403, POP 은 작업자 번호가 없거나 다른 공장이면 401', async () => {
    const lotId = lots[0].lotId;
    await request(app.getHttpServer()).post(revisePath(lotId)).set('Cookie', narrowCookie).set('Idempotency-Key', randomUUID())
      .send({ qty: 70, package: null }).expect(403);
    await request(app.getHttpServer()).post(revisePath(lotId)).set('Authorization', `Bearer ${popToken}`).set('Idempotency-Key', randomUUID())
      .send({ qty: 70, package: null }).expect(401);
    await request(app.getHttpServer()).post(revisePath(lotId)).set('Authorization', `Bearer ${foreignPopToken}`)
      .set('Idempotency-Key', randomUUID()).set('X-Worker-No', WORKER_NO).send({ qty: 70, package: null }).expect(401);
  });

  it('SC-002 T048 수량을 늘린 수정이 끝나기 전 같은 조합 미출력 조회는 기다렸다가 늘린 양을 보고 P/O 몫만큼만 만든다', async () => {
    // 따로 품목 B(기본 100, 패키징 없음)·P/O 400 — 앞 시험의 LOT 과 섞이지 않는다.
    const itemB = (await prisma.item.create({
      data: { item_code: `${PREFIX}-B`, item_name: 'LOT수정자재B', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.ea, lot_controlled: true,
        default_lot_storage_uom_id: ids.ea, default_production_lot_size: 100 },
    })).item_id;
    const order = await prisma.purchase_order.create({
      data: { purchase_order_no: `${PREFIX}-PO-B`, supplier_id: ids.supplier, business_unit_id: ids.unit, plant_id: ids.plant,
        order_date: new Date('2026-11-01T00:00:00.000Z'), status_code: 'CONFIRMED' },
    });
    await prisma.purchase_order_line.create({
      data: { purchase_order_id: order.purchase_order_id, line_no: 1, item_id: itemB, uom_id: ids.ea, ordered_qty: 400 },
    });
    const first = (await lotsOf(1, 2, itemB).expect(200)).body as { items: Row[]; generation: { createdNow: number; creatableRemaining: number } };
    expect(first.generation).toMatchObject({ createdNow: 2, creatableRemaining: 2 });

    // 수정 트랜잭션을 열어 둔 채(100 → 200, 아직 커밋 전) 미출력 조회를 보낸다. 조회는 같은 자물쇠에서 기다려야 한다 —
    // 기다리지 않으면 옛 합 200 을 보고 100 짜리 둘을 더 만들어 몫 400 을 넘는다(500).
    let pending: Promise<request.Response> | undefined;
    let settledBeforeCommit = false;
    await prisma.$transaction(async (tx) => {
      await reviseMaterialLotWithin(tx, BigInt(first.items[0].lotId), { qty: 200, package: null, businessDate: TODAY });
      pending = lotsOf(1, 20, itemB).then((response) => response);
      void pending.then(() => { settledBeforeCommit = true; });
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }, { timeout: 20_000 });
    expect(settledBeforeCommit).toBe(false);
    const second = (await pending) as request.Response;
    expect(second.status).toBe(200);
    expect((second.body as { generation: { createdNow: number; creatableRemaining: number } }).generation)
      .toMatchObject({ createdNow: 1, creatableRemaining: 0 });

    const waiting = await prisma.lot.findMany({ where: { plant_id: ids.plant, item_id: itemB, lifecycle_status_code: 'WAITING' }, select: { initial_qty: true } });
    expect(waiting.map((lot) => Number(lot.initial_qty)).sort((a, b) => b - a)).toEqual([200, 100, 100]);
  });

  async function unprinted(): Promise<Row[]> {
    return ((await lotsOf(1, 20).expect(200)).body as { items: Row[] }).items;
  }

  function lotsOf(page: number, size: number, item: bigint = ids.item): request.Test {
    return request(app.getHttpServer()).get(LOTS).set('Cookie', cookie)
      .query({ plantId: Number(ids.plant), supplierId: Number(ids.supplier), itemId: Number(item), tab: 'UNPRINTED', page, size });
  }

  function webPost(path: string): request.Test {
    return request(app.getHttpServer()).post(path).set('Cookie', cookie).set('Idempotency-Key', randomUUID());
  }

  function popPost(path: string): request.Test {
    return request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${popToken}`)
      .set('Idempotency-Key', randomUUID()).set('X-Worker-No', WORKER_NO);
  }

  async function terminalToken(plant: bigint): Promise<string> {
    seq += 1;
    const terminal = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-T${String(seq)}`, plant_id: plant, terminal_type_code: 'POP', status_code: 'RUNNING' },
    });
    return jwt.sign({ sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version, terminalCode: terminal.terminal_code, plantId: Number(plant) });
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: 'LOT수정법인', country_code: 'VN', timezone_code: TZ },
    });
    ids.unit = (await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: 'LOT수정사업부' },
    })).business_unit_id;
    for (const [name, code] of [['plant', 'P'], ['foreignPlant', 'PF']] as const) {
      ids[name] = (await prisma.plant.create({
        data: { legal_entity_id: entity.legal_entity_id, business_unit_id: ids.unit, plant_code: `${PREFIX}-${code}`,
          plant_name: `LOT수정공장 ${code}`, timezone_code: TZ },
      })).plant_id;
    }
    ids.ea = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    ids.box = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'BOX' } })).uom_id;
    ids.item = (await prisma.item.create({
      data: { item_code: `${PREFIX}-A`, item_name: 'LOT수정자재', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.ea, lot_controlled: true,
        default_lot_storage_uom_id: ids.ea, default_production_lot_size: 100, default_package_uom_id: ids.box, default_package_count: 10 },
    })).item_id;
    ids.supplier = (await prisma.partner.create({ data: { partner_code: `${PREFIX}-S`, partner_name: `${PREFIX} 공급사` } })).partner_id;
    await prisma.worker.create({
      data: { worker_no: WORKER_NO, worker_name: 'LOT수정작업자', business_unit_id: ids.unit, plant_id: ids.plant, status_code: 'EMPLOYED' },
    });
  }

  async function makeUser(suffix: string, permissions: string[]): Promise<string> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-${suffix}`, user_name: `LOT수정 ${suffix}`, status_code: 'EMPLOYED' } });
    if (suffix === 'ALL') ids.user = user.app_user_id;
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_${suffix}`, role_name: `LOT수정 ${suffix}` } });
    await prisma.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    return `${SESSION_COOKIE}=${jwt.sign({ sub: Number(user.app_user_id), typ: TOKEN_TYPE.SESSION })}`;
  }

  async function cleanup(): Promise<void> {
    const plants = `SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`;
    const lotIds = `SELECT lot_id FROM trace.lot WHERE plant_id IN (${plants})`;
    const users = `SELECT app_user_id FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`;
    const roles = `SELECT role_id FROM app.role WHERE role_code LIKE '${PREFIX}%'`;
    for (const sql of [
      `DELETE FROM app.document_issue_log WHERE lot_id IN (${lotIds})`,
      `DELETE FROM audit.audit_event WHERE target_type_code = 'LOT' AND target_id IN (${lotIds})`,
      `DELETE FROM trace.material_lot_po_plan WHERE lot_id IN (${lotIds})`,
      `DELETE FROM trace.lot_lifecycle_history WHERE lot_id IN (${lotIds})`,
      `DELETE FROM trace.lot_status_event WHERE lot_id IN (${lotIds})`,
      `DELETE FROM trace.lot_external_identifier WHERE lot_id IN (${lotIds})`,
      `DELETE FROM trace.lot WHERE plant_id IN (${plants})`,
      `DELETE FROM logistics.purchase_order_line WHERE purchase_order_id IN (SELECT purchase_order_id FROM logistics.purchase_order WHERE plant_id IN (${plants}))`,
      `DELETE FROM logistics.purchase_order WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.material_lot_batch WHERE plant_id IN (${plants})`,
      `DELETE FROM audit.audit_event WHERE terminal_id IN (SELECT terminal_id FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%')`,
      `DELETE FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`,
      `DELETE FROM app.idempotency_record WHERE app_user_id IN (${users})`,
      `DELETE FROM app.user_role WHERE app_user_id IN (${users})`,
      `DELETE FROM app.role_permission WHERE role_id IN (${roles})`,
      `DELETE FROM app.role WHERE role_code LIKE '${PREFIX}%'`,
      `DELETE FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
  }
});

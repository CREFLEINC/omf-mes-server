/**
 * 피처 008 S4 — 분할 LOT 라벨 목록 `GET /logistics/split-material-lots`(POP P-01-02 · omf-all-around#289 · T016).
 * 분할 LOT·출고·라벨 발행 기록은 직접 넣는다 — 분할 자체는 `logistics-picking-issue.e2e-spec.ts` 가 본다.
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
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'E8SL';
const LIST = '/api/logistics/split-material-lots';
const DAY = (offset: number): Date => new Date(Date.now() + offset * 86_400_000);

interface Row {
  lotId: number;
  lotNo: string;
  qty: number;
  supplier: { supplierCode: string } | null;
  parentLot: { lotId: number; lotNo: string };
  goodsIssue: { goodsIssueNo: string; lineNo: number };
  destination: { warehouseCode: string; locationCode: string } | null;
  labelIssue: { issueCount: number; lastIssueSeq: number; lastPrintOutcomeCode: string | null } | null;
}

describe('피처 008 S4 — 분할 LOT 라벨 목록 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let cookie: string;
  let narrowCookie: string;
  let popToken: string;
  let foreignPopToken: string;
  let mobileToken: string;
  const ids: Record<string, bigint> = {};
  let seq = 0;
  let splitSeq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    await cleanup();
    await makeMasters();
    cookie = await makeUser('ALL', ['P-01-02']);
    narrowCookie = await makeUser('NARROW', ['P-01-01']);
    popToken = await terminalToken(ids.plant, 'POP');
    foreignPopToken = await terminalToken(ids.foreignPlant, 'POP');
    mobileToken = await terminalToken(ids.plant, 'MOBILE');
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('US2-1·US2-6·SC-004 미발행은 기간과 상관없이 오래된 순으로 나오고 unprintedCount 를 싣는다', async () => {
    const old = await split(300, DAY(-8));
    const fresh = await split(200, DAY(0));

    const body = await list(`plantId=${String(ids.plant)}`);
    expect(body.items.map((row: Row) => row.lotId)).toEqual([old.lotId, fresh.lotId].map(Number));
    expect(body.unprintedCount).toBe(2);
    const first = body.items[0] as Row;
    // 라벨 면 값 — 수량은 분할 수량, 공급사는 원조 입하, 부모·출고·도착.
    expect(first).toMatchObject({
      lotNo: `${PREFIX}-A|300|260731|SUP|0001-S1`, qty: 300,
      supplier: { supplierCode: `${PREFIX}-S` },
      parentLot: { lotId: Number(ids.root), lotNo: `${PREFIX}-A|1000|260731|SUP|0001` },
      goodsIssue: { goodsIssueNo: `${PREFIX}-GI-1`, lineNo: 1 },
      destination: { warehouseCode: `${PREFIX}-WIP`, locationCode: `${PREFIX}-WIP-01` },
      labelIssue: null,
    });
  });

  it('US2-2·US2-3 찍으면 빠지고(PENDING 포함), 인쇄 실패는 남고, 실패 뒤 다시 찍으면 빠진다', async () => {
    const printed = await split(10, DAY(-1));
    const failed = await split(20, DAY(-1));
    const pending = await split(30, DAY(-1));
    await label(printed.lotId, 1, 'SUCCEEDED');
    await label(failed.lotId, 1, 'FAILED');
    await label(pending.lotId, 1, 'PENDING');

    const unprinted = (await list(`plantId=${String(ids.plant)}`)).items.map((row: Row) => row.lotId);
    expect(unprinted).toContain(Number(failed.lotId));
    expect(unprinted).not.toContain(Number(printed.lotId));
    expect(unprinted).not.toContain(Number(pending.lotId));
    const failedRow = (await list(`plantId=${String(ids.plant)}`)).items.find((row: Row) => row.lotId === Number(failed.lotId)) as Row;
    expect(failedRow.labelIssue).toMatchObject({ issueCount: 1, lastIssueSeq: 1, lastPrintOutcomeCode: 'FAILED' });

    await label(failed.lotId, 2, 'SUCCEEDED');
    const printedList = await list(`plantId=${String(ids.plant)}&labelState=PRINTED`);
    expect(printedList.items.map((row: Row) => row.lotId)).toEqual(
      expect.arrayContaining([printed.lotId, failed.lotId, pending.lotId].map(Number)),
    );
    expect(printedList.items.find((row: Row) => row.lotId === Number(failed.lotId)).labelIssue).toMatchObject({ issueCount: 2, lastIssueSeq: 2 });
    expect((await list(`plantId=${String(ids.plant)}`)).unprintedCount).toBe(2);
  });

  it('찍음 목록은 출고일 기간(기본 최근 7일)으로 거른다 — 미발행 건수는 기간과 상관없다', async () => {
    const longAgo = await split(5, DAY(-30));
    await label(longAgo.lotId, 1, 'SUCCEEDED');

    const recent = await list(`plantId=${String(ids.plant)}&labelState=PRINTED`);
    expect(recent.items.map((row: Row) => row.lotId)).not.toContain(Number(longAgo.lotId));
    const from = DAY(-31).toISOString().slice(0, 10);
    const ranged = await list(`plantId=${String(ids.plant)}&labelState=PRINTED&issuedFrom=${from}`);
    expect(ranged.items.map((row: Row) => row.lotId)).toContain(Number(longAgo.lotId));
  });

  it('US2-5 분할이 아닌 LOT(전량 출고한 원래 LOT)은 나오지 않는다', async () => {
    const body = await list(`plantId=${String(ids.plant)}&size=200`);
    expect(body.items.map((row: Row) => row.lotId)).not.toContain(Number(ids.root));
  });

  it('FR-007 분할 LOT 에 자재 LOT 라벨을 발행할 수 있다(P-01-02 권한)', async () => {
    const lot = await split(7, DAY(0));
    const issued = await request(app.getHttpServer())
      .post('/api/app/document-issues')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ documentTypeCode: 'MATERIAL_LOT_LABEL', targets: [{ targetTypeCode: 'LOT', targetId: Number(lot.lotId) }] });
    expect(issued.status).toBe(201);
    // 발행 기록이 생기면 인쇄 결과 보고 전(PENDING 또는 비어 있음)이어도 미발행에서 빠진다.
    const unprinted = (await list(`plantId=${String(ids.plant)}&size=200`)).items.map((row: Row) => row.lotId);
    expect(unprinted).not.toContain(Number(lot.lotId));
  });

  it('POP 단말은 자기 공장만 — 다른 공장·모바일 단말은 401, 권한 없는 계정은 403', async () => {
    const own = await request(app.getHttpServer()).get(`${LIST}?plantId=${String(ids.plant)}`)
      .set('Authorization', `Bearer ${popToken}`).expect(200);
    expect(own.body.unprintedCount).toBeGreaterThan(0);
    await request(app.getHttpServer()).get(`${LIST}?plantId=${String(ids.plant)}`)
      .set('Authorization', `Bearer ${foreignPopToken}`).expect(401);
    await request(app.getHttpServer()).get(`${LIST}?plantId=${String(ids.plant)}`)
      .set('Authorization', `Bearer ${mobileToken}`).expect(401);
    await request(app.getHttpServer()).get(`${LIST}?plantId=${String(ids.plant)}`).set('Cookie', narrowCookie).expect(403);
    // 다른 공장 질의는 그 공장 것만 — 이 공장의 분할 LOT 은 섞이지 않는다.
    const foreign = await request(app.getHttpServer()).get(`${LIST}?plantId=${String(ids.foreignPlant)}`).set('Cookie', cookie).expect(200);
    expect(foreign.body).toMatchObject({ items: [], unprintedCount: 0 });
  });

  async function list(query: string) {
    const response = await request(app.getHttpServer()).get(`${LIST}?${query}`).set('Cookie', cookie).expect(200);
    return response.body;
  }

  /** 원조 LOT 에서 `qty` 를 부분 출고한 분할 LOT — 출고 라인 → 분할 LOT(원천) → 라인 LOT 교체 순서로 넣는다. */
  async function split(qty: number, at: Date): Promise<{ lotId: bigint }> {
    splitSeq += 1;
    const seq = splitSeq;
    const issue = await prisma.goods_issue.create({
      data: {
        goods_issue_no: `${PREFIX}-GI-${String(seq)}`, issue_type_code: 'PRODUCTION', source_document_type_code: 'PICKING_ORDER',
        source_document_id: 1, source_warehouse_id: ids.warehouse, issued_at: at, status_code: 'POSTED',
        destination_type_code: 'LOCATION', destination_id: ids.wipLocation,
      },
    });
    const line = await prisma.goods_issue_line.create({
      data: {
        goods_issue_id: issue.goods_issue_id, line_no: 1, item_id: ids.item, lot_id: ids.root, issue_qty: qty,
        uom_id: ids.uom, source_location_id: ids.location,
      },
    });
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-A|${String(qty)}|260731|SUP|0001-S${String(seq)}`, item_id: ids.item, lot_type_code: 'MATERIAL',
        plant_id: ids.plant, initial_qty: qty, uom_id: ids.uom, source_type_code: 'GOODS_ISSUE_SPLIT',
        source_id: line.goods_issue_line_id, parent_lot_id: ids.root, status_code: 'NORMAL', lifecycle_status_code: 'ACTIVE',
      },
    });
    await prisma.lot_relation.create({
      data: {
        source_lot_id: ids.root, target_lot_id: lot.lot_id, relation_type_code: 'SPLIT', relation_qty: qty, uom_id: ids.uom,
        source_event_type_code: 'GOODS_ISSUE_LINE', source_event_id: line.goods_issue_line_id,
        allocation_method_code: 'EXACT', trace_accuracy_code: 'EXACT', occurred_at: at,
      },
    });
    await prisma.goods_issue_line.update({ where: { goods_issue_line_id: line.goods_issue_line_id }, data: { lot_id: lot.lot_id } });
    return { lotId: lot.lot_id };
  }

  async function label(lotId: bigint, issueSeq: number, outcome: string): Promise<void> {
    await prisma.document_issue_log.create({
      data: {
        document_type_code: 'MATERIAL_LOT_LABEL', target_type_code: 'LOT', target_id: lotId, lot_id: lotId, issue_seq: issueSeq,
        print_outcome_code: outcome, issued_at: new Date(Date.now() + issueSeq * 1000), issued_by: ids.user,
        ...(outcome === 'PENDING' ? {} : { print_reported_at: new Date(), print_reported_worker_id: ids.worker }),
        ...(outcome === 'FAILED' ? { print_failure_reason: '용지 걸림' } : {}),
        ...(issueSeq > 1 ? { reissue_reason_code: 'DAMAGED' } : {}),
      },
    });
  }

  async function terminalToken(plant: bigint, type: 'POP' | 'MOBILE'): Promise<string> {
    seq += 1;
    const terminal = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-T${String(seq)}`, plant_id: plant, terminal_type_code: type, status_code: 'RUNNING' },
    });
    return jwt.sign({
      sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version,
      terminalCode: terminal.terminal_code, plantId: Number(plant),
    });
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '분할라벨법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const unit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '분할라벨사업부' },
    });
    for (const [name, code] of [['plant', 'P'], ['foreignPlant', 'PF']] as const) {
      ids[name] = (await prisma.plant.create({
        data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-${code}`, plant_name: `분할라벨공장 ${code}`, timezone_code: 'Asia/Ho_Chi_Minh' },
      })).plant_id;
    }
    ids.uom = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    ids.item = (await prisma.item.create({
      data: { item_code: `${PREFIX}-A`, item_name: '분할라벨자재', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.uom, lot_controlled: true },
    })).item_id;
    ids.worker = (await prisma.worker.create({
      data: { worker_no: `${PREFIX}-W1`, worker_name: '분할라벨작업자', business_unit_id: unit.business_unit_id, plant_id: ids.plant, status_code: 'EMPLOYED' },
    })).worker_id;
    const supplier = await prisma.partner.create({ data: { partner_code: `${PREFIX}-S`, partner_name: `${PREFIX} 공급사` } });
    const warehouse = async (code: string) => {
      const wh = await prisma.warehouse.create({
        data: {
          plant_id: ids.plant, business_unit_id: unit.business_unit_id, warehouse_code: `${PREFIX}-${code}`, warehouse_name: code,
          warehouse_type_code: 'MATERIAL', management_level_code: 'WAREHOUSE',
        },
      });
      const location = await prisma.location.create({
        data: { warehouse_id: wh.warehouse_id, location_code: `${PREFIX}-${code}-01`, location_name: code, location_type_code: 'DEFAULT' },
      });
      return { warehouseId: wh.warehouse_id, locationId: location.location_id };
    };
    const material = await warehouse('M1');
    ids.warehouse = material.warehouseId;
    ids.location = material.locationId;
    ids.wipLocation = (await warehouse('WIP')).locationId;
    ids.root = (await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-A|1000|260731|SUP|0001`, item_id: ids.item, lot_type_code: 'MATERIAL', plant_id: ids.plant,
        initial_qty: 1000, uom_id: ids.uom, source_type_code: 'INBOUND_RECEIPT_LINE', source_id: 0, status_code: 'NORMAL',
      },
    })).lot_id;
    // 원조 LOT 의 입하 — 옛 줄 모양(줄 lot_id = 원조)이라 공급사를 줄에서 푼다.
    const receipt = await prisma.inbound_receipt.create({
      data: { inbound_receipt_no: `${PREFIX}-IR`, supplier_id: supplier.partner_id, plant_id: ids.plant, receipt_datetime: DAY(-40), status_code: 'REGISTERED' },
    });
    await prisma.inbound_receipt_line.create({
      data: {
        inbound_receipt_id: receipt.inbound_receipt_id, line_no: 1, item_id: ids.item, received_qty: 1000, uom_id: ids.uom,
        supplier_lot_label_attached: false, inspection_required: false, status_code: 'REGISTERED', lot_id: ids.root,
      },
    });
  }

  async function makeUser(suffix: string, permissions: string[]): Promise<string> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-${suffix}`, user_name: `분할라벨 ${suffix}`, status_code: 'EMPLOYED' } });
    ids.user ??= user.app_user_id;
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_${suffix}`, role_name: `분할라벨 ${suffix}` } });
    await prisma.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    return `${SESSION_COOKIE}=${jwt.sign({ sub: Number(user.app_user_id), typ: TOKEN_TYPE.SESSION })}`;
  }

  async function cleanup(): Promise<void> {
    const plants = `SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`;
    const lots = `SELECT lot_id FROM trace.lot WHERE plant_id IN (${plants})`;
    const users = `SELECT app_user_id FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`;
    const roles = `SELECT role_id FROM app.role WHERE role_code LIKE '${PREFIX}%'`;
    const issues = `SELECT goods_issue_id FROM logistics.goods_issue WHERE goods_issue_no LIKE '${PREFIX}%'`;
    for (const sql of [
      `DELETE FROM app.document_issue_log WHERE lot_id IN (${lots}) OR (target_type_code = 'LOT' AND target_id IN (${lots}))`,
      `DELETE FROM trace.lot_relation WHERE target_lot_id IN (${lots})`,
      `DELETE FROM logistics.goods_issue_line WHERE goods_issue_id IN (${issues})`,
      `DELETE FROM logistics.goods_issue WHERE goods_issue_id IN (${issues})`,
      `DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%'`,
      `DELETE FROM trace.lot_lifecycle_history WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot WHERE plant_id IN (${plants})`,
      `DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`,
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

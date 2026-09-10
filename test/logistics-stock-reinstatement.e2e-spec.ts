/**
 * 재고 재등록 — `POST /logistics/stock-reinstatements`(I-23 PR ⑧ · 화면 `W-04-11`).
 *
 * ⭐ 시험마다 «자기» LOT·잔액·부적합·결정·보류를 새로 세운다(`seedCase`) — 재등록이 그 넷을 모두 바꾸므로
 *   시험끼리 공유하면 순서에 기대는 시험이 된다.
 * ⚠ 원장은 지울 수 없어(append-only) LOT·위치·창고를 FK 로 잡는다 — LOT 번호에 실행마다 다른 꼬리를 붙이고
 *   마스터는 코드로 찾아 다시 쓴다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-stock-reinstatement-probe';
const PASSWORD = 'SRI-재등록-비밀번호';
const PREFIX = 'SRIE2E';
const ROLE = 'SRIE2E-ROLE';
const PERMISSIONS = ['W-04-11'];
const BASE = '/api/logistics/stock-reinstatements';
const RUN = Date.now().toString(36).toUpperCase();
const DAY = '2026-09-03';

interface Case {
  lotId: bigint;
  decisionId: bigint;
  holdId: bigint;
  versionNo: number;
}

describe('재고 재등록 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  const ids: Record<string, bigint> = {};
  let seq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await makeMasters();
    await makeUser();
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function ensure<T>(
    delegate: { findFirst: (a: unknown) => Promise<T | null>; create: (a: unknown) => Promise<T> },
    where: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<T> {
    return (await delegate.findFirst({ where })) ?? (await delegate.create({ data }));
  }

  async function makeMasters(): Promise<void> {
    const plant = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
    const unit = await prisma.business_unit.findFirstOrThrow({ orderBy: { business_unit_id: 'asc' } });
    ids.plant = plant.plant_id;
    ids.unit = unit.business_unit_id;
    ids.legal = plant.legal_entity_id;
    const warehouse = async (key: string, code: string, level: string, isDefect: boolean) => {
      const row = await ensure(prisma.warehouse, { warehouse_code: `${PREFIX}-${code}` }, {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-${code}`,
        warehouse_name: `재등록검사창고${code}`,
        warehouse_type_code: 'FINISHED',
        management_level_code: level,
        is_defect: isDefect,
      });
      ids[key] = row.warehouse_id;
      const location = await ensure(prisma.location, { location_code: `${PREFIX}-LOC-${code}` }, {
        warehouse_id: row.warehouse_id,
        location_code: `${PREFIX}-LOC-${code}`,
        location_name: `재등록검사위치${code}`,
        location_type_code: 'DEFAULT',
      });
      ids[`${key}Loc`] = location.location_id;
    };
    // ⭐ 불량창고 · 완제품창고(창고 단위 · 위치 하나) · 셀 단위 창고 — 위치 해소의 두 갈래를 가른다.
    await warehouse('defect', 'DEF', 'WAREHOUSE', true);
    await warehouse('target', 'FIN', 'WAREHOUSE', false);
    await warehouse('cell', 'CEL', 'CELL', false);
    const [uom] = await prisma.uom.findMany({ take: 1, orderBy: { uom_id: 'asc' } });
    ids.uom = uom.uom_id;
    const item = await ensure(prisma.item, { item_code: `${PREFIX}-IT` }, {
      item_code: `${PREFIX}-IT`,
      item_name: '재등록검사품목',
      item_type_code: 'FINISHED',
      base_uom_id: uom.uom_id,
    });
    ids.item = item.item_id;
  }

  /**
   * 한 시험의 세계 — LOT(불량) · 불량창고 잔액 · 부적합(+LOT) · 처분 결정 · 열린 보류.
   * @param holdQty `null` 이면 «전량 보류»다.
   */
  async function seedCase(opts: {
    disposition?: string;
    decisionQty?: number;
    balance?: number;
    holdQty?: number | null;
    released?: boolean;
    inDecision?: boolean;
  } = {}): Promise<Case> {
    seq += 1;
    const key = `${RUN}-${seq}`;
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-${key}`,
        item_id: ids.item,
        lot_type_code: 'PRODUCT',
        plant_id: ids.plant,
        initial_qty: 10,
        uom_id: ids.uom,
        source_type_code: 'SHIPMENT',
        source_id: 1n,
        status_code: 'DEFECTIVE',
      },
    });
    await prisma.inventory_balance.create({
      data: {
        legal_entity_id: ids.legal,
        business_unit_id: ids.unit,
        plant_id: ids.plant,
        warehouse_id: ids.defect,
        location_id: ids.defectLoc,
        item_id: ids.item,
        lot_id: lot.lot_id,
        quality_status_code: 'DEFECTIVE',
        inventory_status_code: 'AVAILABLE',
        ownership_type_code: 'OWNED',
        uom_id: ids.uom,
        on_hand_qty: opts.balance ?? 10,
      },
    });
    const nc = await prisma.nonconformance.create({
      data: {
        nonconformance_no: `${PREFIX}-NC-${key}`,
        item_id: ids.item,
        severity_code: 'MINOR',
        description: `${PREFIX} 재등록 부적합 ${key}`,
        status_code: 'DECIDED',
        opened_at: new Date('2026-09-01T00:00:00.000Z'),
      },
    });
    if (opts.inDecision !== false) {
      await prisma.nonconformance_lot.create({
        data: {
          nonconformance_id: nc.nonconformance_id,
          lot_id: lot.lot_id,
          affected_qty: 10,
          uom_id: ids.uom,
          quality_status_before_code: 'DEFECTIVE',
          quality_status_after_code: 'DEFECTIVE',
        },
      });
    }
    const user = await prisma.app_user.findUniqueOrThrow({ where: { login_id: LOGIN_ID } });
    const decision = await prisma.disposition_decision.create({
      data: {
        nonconformance_id: nc.nonconformance_id,
        disposition_type_code: opts.disposition ?? 'NORMAL',
        decision_qty: opts.decisionQty ?? 10,
        uom_id: ids.uom,
        reason: `${PREFIX} 판정 ${key}`,
        decided_by: user.app_user_id,
        decided_at: new Date('2026-09-02T00:00:00.000Z'),
      },
    });
    const holdQty = opts.holdQty === undefined ? 10 : opts.holdQty;
    const hold = await prisma.lot_hold.create({
      data: {
        lot_id: lot.lot_id,
        hold_qty: holdQty,
        uom_id: holdQty === null ? null : ids.uom,
        reason_code: 'SUSPECT',
        status_code: 'HOLD',
        held_at: new Date('2026-09-01T00:00:00.000Z'),
        ...(opts.released === true
          ? { released_at: new Date('2026-09-02T00:00:00.000Z'), release_reason_code: 'RETEST_PASS', released_by: user.app_user_id }
          : {}),
      },
    });
    return { lotId: lot.lot_id, decisionId: decision.disposition_decision_id, holdId: hold.lot_hold_id, versionNo: lot.version_no };
  }

  const bodyOf = (c: Case, over: Record<string, unknown> = {}) => ({
    dispositionDecisionId: Number(c.decisionId),
    lot: { lotId: Number(c.lotId), versionNo: c.versionNo },
    lotHoldId: Number(c.holdId),
    toWarehouseId: Number(ids.target),
    qty: 10,
    uomId: Number(ids.uom),
    releaseReasonCode: 'RETEST_PASS',
    reasonCode: null,
    businessDate: DAY,
    occurredAt: '2026-09-03T02:00:00.000Z',
    ...over,
  });

  async function reinstate(payload: Record<string, unknown>, expected: number): Promise<Record<string, unknown>> {
    const response = await request(app.getHttpServer())
      .post(BASE)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send(payload)
      .expect(expected);
    return response.body as Record<string, unknown>;
  }

  const firstError = (body: Record<string, unknown>) => (body.errors as { field: string; code: string; message: string }[])[0];

  const balanceAt = (lotId: bigint, warehouseId: bigint) =>
    prisma.inventory_balance.findFirst({ where: { lot_id: lotId, warehouse_id: warehouseId }, select: { on_hand_qty: true } });

  it('R-1 ⭐ 201 — 이동 문서 한 건(DEFECT_RETURN · 도착 시각 채움 · 처분 결정 연결) · LOT NORMAL · 잔량 null', async () => {
    const c = await seedCase();

    const body = await reinstate(bodyOf(c), 201);

    expect(body).toMatchObject({
      lotId: Number(c.lotId),
      lotStatusCode: 'NORMAL',
      releasedLotHoldId: Number(c.holdId),
      reinstatedQty: 10,
      toWarehouseId: Number(ids.target),
      remainingHeldQty: null,
    });
    const transfer = await prisma.stock_transfer.findUniqueOrThrow({
      where: { stock_transfer_id: BigInt(body.stockTransferId as number) },
    });
    expect(transfer).toMatchObject({
      stock_transfer_no: body.stockTransferNo,
      transfer_type_code: 'DEFECT_RETURN',
      status_code: 'POSTED',
      from_warehouse_id: ids.defect,
      to_warehouse_id: ids.target,
      disposition_decision_id: c.decisionId,
    });
    expect(transfer.received_at).not.toBeNull();
  });

  it('R-2 ⭐⭐ 원장 «한 건 · 라인 한 줄» — from 불량창고 · to 완제품창고(NORMAL) · 되짚기 두 칸이 같은 줄', async () => {
    const c = await seedCase();

    const body = await reinstate(bodyOf(c), 201);

    const ledgers = await prisma.inventory_transaction.findMany({
      where: { source_document_type_code: 'STOCK_TRANSFER', source_document_id: BigInt(body.stockTransferId as number) },
      include: { inventory_transaction_line: true },
    });
    expect(ledgers).toHaveLength(1);
    expect(ledgers[0].inventory_transaction_line).toHaveLength(1);
    const [line] = ledgers[0].inventory_transaction_line;
    expect(line).toMatchObject({
      from_warehouse_id: ids.defect,
      to_warehouse_id: ids.target,
      to_quality_status_code: 'NORMAL',
    });
    const transferLine = await prisma.stock_transfer_line.findFirstOrThrow({
      where: { stock_transfer_id: BigInt(body.stockTransferId as number) },
    });
    // ⛔ IN_TRANSIT 두 단이 아니다 — 반출과 도착이 «같은 한 줄»이다.
    expect(transferLine.issue_transaction_line_id).toBe(line.inventory_transaction_line_id);
    expect(transferLine.receipt_transaction_line_id).toBe(line.inventory_transaction_line_id);
    expect(transferLine.received_qty.toNumber()).toBe(10);
  });

  it('R-3 잔액이 불량창고에서 빠지고 완제품창고에 선다', async () => {
    const c = await seedCase();

    await reinstate(bodyOf(c), 201);

    expect((await balanceAt(c.lotId, ids.defect))?.on_hand_qty.toNumber()).toBe(0);
    expect((await balanceAt(c.lotId, ids.target))?.on_hand_qty.toNumber()).toBe(10);
  });

  it('R-4 ⭐ LOT 전이 이력 — transition_code C20 · 원천은 그 이동 문서', async () => {
    const c = await seedCase();

    const body = await reinstate(bodyOf(c), 201);

    const event = await prisma.lot_status_event.findFirstOrThrow({
      where: { lot_id: c.lotId, transition_code: 'C20' },
    });
    expect(event).toMatchObject({
      previous_status_code: 'DEFECTIVE',
      new_status_code: 'NORMAL',
      source_document_type_code: 'STOCK_TRANSFER',
      source_document_id: BigInt(body.stockTransferId as number),
    });
  });

  it('R-5 ⭐⭐ 부분 재등록 — LOT 을 «안» 옮기고 잔량 보류가 서며, 나머지를 마저 하면 그때 옮긴다(R-4)', async () => {
    const c = await seedCase({ holdQty: 10 });

    const partial = await reinstate(bodyOf(c, { qty: 4 }), 201);

    // ⛔ 옮기면 남은 불량 6 이 보류 없이 풀린다.
    expect(partial).toMatchObject({ lotStatusCode: 'DEFECTIVE', remainingHeldQty: 6, releasedLotHoldId: Number(c.holdId) });
    expect(await prisma.lot_status_event.count({ where: { lot_id: c.lotId, transition_code: 'C20' } })).toBe(0);
    const open = await prisma.lot_hold.findFirstOrThrow({ where: { lot_id: c.lotId, released_at: null } });
    expect(open.hold_qty?.toNumber()).toBe(6);
    expect(open.lot_hold_id).not.toBe(c.holdId);

    // 남은 6 — 잔량 보류를 겨누고, 토큰은 LOT 의 «지금» 판 번호다.
    const lot = await prisma.lot.findUniqueOrThrow({ where: { lot_id: c.lotId } });
    const rest = await reinstate(
      bodyOf(c, { qty: 6, lotHoldId: Number(open.lot_hold_id), lot: { lotId: Number(c.lotId), versionNo: lot.version_no } }),
      201,
    );
    expect(rest).toMatchObject({ lotStatusCode: 'NORMAL', remainingHeldQty: null });
  });

  it('R-6 ⛔ 전량 재등록된 결정은 409 ALREADY_REINSTATED — 「한 번 했다」가 아니라 «합»이 닿았을 때다', async () => {
    const c = await seedCase({ decisionQty: 10, balance: 20, holdQty: 10 });
    await reinstate(bodyOf(c), 201);
    // 같은 결정에 다른 보류·새 토큰을 들고 다시 온다.
    const lot = await prisma.lot.findUniqueOrThrow({ where: { lot_id: c.lotId } });
    const again = await prisma.lot_hold.create({
      data: { lot_id: c.lotId, hold_qty: 5, uom_id: ids.uom, reason_code: 'SUSPECT', status_code: 'HOLD', held_at: new Date('2026-09-03T03:00:00.000Z') },
    });

    const failed = await reinstate(
      bodyOf(c, { qty: 5, lotHoldId: Number(again.lot_hold_id), lot: { lotId: Number(c.lotId), versionNo: lot.version_no } }),
      409,
    );

    expect(failed).toMatchObject({ code: 'ALREADY_REINSTATED' });
  });

  it('R-7 ⛔ 다른 경로가 먼저 푼 보류는 409 HOLD_ALREADY_RELEASED', async () => {
    const c = await seedCase({ released: true });

    expect(await reinstate(bodyOf(c), 409)).toMatchObject({ code: 'HOLD_ALREADY_RELEASED' });
  });

  it('R-8 ⛔ 정상 처분이 아닌 결정은 409 DISPOSITION_NOT_REINSTATABLE', async () => {
    const c = await seedCase({ disposition: 'SCRAP' });

    expect(await reinstate(bodyOf(c), 409)).toMatchObject({ code: 'DISPOSITION_NOT_REINSTATABLE' });
  });

  it('R-9 ⛔ 본문 토큰이 낡으면 409 VERSION_CONFLICT + currentVersion', async () => {
    const c = await seedCase();

    const failed = await reinstate(bodyOf(c, { lot: { lotId: Number(c.lotId), versionNo: c.versionNo + 5 } }), 409);

    expect(failed).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: String(c.versionNo) });
  });

  it('R-10 ⛔ 그 결정의 LOT 이 아니면 400 INVALID — nonconformance 에 lot_id 칸이 없어 링크 표로 본다', async () => {
    const c = await seedCase({ inDecision: false });

    expect(firstError(await reinstate(bodyOf(c), 400))).toMatchObject({ field: 'lot.lotId', code: 'INVALID' });
  });

  it('R-11 ⛔⛔ 전량 보류(NULL)를 부분으로 재등록하면 400 RANGE — 남은 불량이 보류 없이 풀린다', async () => {
    const c = await seedCase({ holdQty: null });

    const failed = firstError(await reinstate(bodyOf(c, { qty: 4 }), 400));

    expect(failed).toMatchObject({ field: 'qty', code: 'RANGE' });
    // 되돌려졌다 — 보류가 그대로 열려 있다.
    expect((await prisma.lot_hold.findUniqueOrThrow({ where: { lot_hold_id: c.holdId } })).released_at).toBeNull();
  });

  it('R-12 ⛔ 도착 위치 — 셀 관리 창고에 위치가 없으면 REQUIRED(toLocationId) · 불량창고로는 INVALID', async () => {
    const c = await seedCase();

    expect(firstError(await reinstate(bodyOf(c, { toWarehouseId: Number(ids.cell) }), 400))).toMatchObject({
      field: 'toLocationId',
      code: 'REQUIRED',
    });
    expect(firstError(await reinstate(bodyOf(c, { toWarehouseId: Number(ids.defect) }), 400))).toMatchObject({
      field: 'toWarehouseId',
      code: 'INVALID',
    });
  });

  it('R-13 ⛔ 수량 소수 일곱째 자리는 400 RANGE — 초안은 이 경로에 0건이었다(R-12)', async () => {
    const c = await seedCase();

    expect(firstError(await reinstate(bodyOf(c, { qty: 4.0000005 }), 400))).toMatchObject({ field: 'qty', code: 'RANGE' });
  });

  it('R-14 셀 관리 창고에 그 창고의 위치를 주면 201 — 위치가 그대로 쓰인다', async () => {
    const c = await seedCase();

    const body = await reinstate(bodyOf(c, { toWarehouseId: Number(ids.cell), toLocationId: Number(ids.cellLoc) }), 201);

    const line = await prisma.stock_transfer_line.findFirstOrThrow({ where: { stock_transfer_id: BigInt(body.stockTransferId as number) } });
    expect(line.to_location_id).toBe(ids.cellLoc);
    expect(new Prisma.Decimal(line.received_qty).toNumber()).toBe(10);
  });

  async function makeUser(): Promise<void> {
    // ⭐ 사용자도 «다시 쓴다» — 재등록이 남긴 LOT 전이 이력(`lot_status_event.changed_by`)이 이 사용자를 FK 로
    //   잡고, 그 이력은 지우지 않는다. 첫 실행에서 afterAll 의 사용자 삭제가 23503 으로 스위트를 죽였다.
    const user = await ensure(prisma.app_user, { login_id: LOGIN_ID }, {
      login_id: LOGIN_ID,
      user_name: '재등록프로브',
      status_code: 'EMPLOYED',
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '재등록검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function cleanup(): Promise<void> {
    const OUR_NC = `SELECT nonconformance_id FROM quality.nonconformance WHERE nonconformance_no LIKE '${PREFIX}%'`;
    const OUR_DECISIONS = `SELECT disposition_decision_id FROM quality.disposition_decision WHERE nonconformance_id IN (${OUR_NC})`;
    // ⛔ 순서가 FK 의 역순이다. ⛔ 원장·LOT·전이 이력은 «안» 지운다 — 원장이 append-only 이고 LOT 을 FK 로 잡는다.
    for (const sql of [
      `DELETE FROM logistics.stock_transfer_line WHERE stock_transfer_id IN (
         SELECT stock_transfer_id FROM logistics.stock_transfer WHERE disposition_decision_id IN (${OUR_DECISIONS}))`,
      `DELETE FROM logistics.stock_transfer WHERE disposition_decision_id IN (${OUR_DECISIONS})`,
      `DELETE FROM quality.disposition_decision WHERE nonconformance_id IN (${OUR_NC})`,
      `DELETE FROM quality.nonconformance_lot WHERE nonconformance_id IN (${OUR_NC})`,
      `DELETE FROM quality.nonconformance WHERE nonconformance_no LIKE '${PREFIX}%'`,
      `DELETE FROM trace.lot_hold WHERE lot_id IN (SELECT lot_id FROM trace.lot WHERE lot_no LIKE '${PREFIX}%')`,
      `DELETE FROM inventory.inventory_balance WHERE location_id IN (
         SELECT location_id FROM mdm.location WHERE location_code LIKE '${PREFIX}%')`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    const target = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (target) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      // ⛔ 사용자 행은 «안» 지운다 — 지울 수 없는 LOT 전이 이력이 changed_by 로 잡고 있다. makeUser 가 다시 쓴다.
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});

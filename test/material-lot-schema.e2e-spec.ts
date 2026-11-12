import { Prisma, PrismaClient } from '@prisma/client';

/**
 * 피처 005 마이그레이션(S1)의 CHECK·유일 색인이 위반 행을 거절한다(DM-1 · data-model).
 * 시험마다 한 트랜잭션 안에서 픽스처를 만들고 언제나 되돌린다 — DB 에 흔적을 남기지 않는다.
 * 권한 덧붙임(데이터 이전 8)은 여기서 보지 않는다 — e2e DB 는 마이그레이션·시드가 끝난 복사본이라
 * 적용 순간을 관찰할 수 없다. 배포 전 점검 SQL ④ 로 본다.
 */
const PREFIX = 'E2E-005-SCHEMA';

class Rollback extends Error {}

/** 유일 위반(23505) — PostgreSQL 은 메시지에 제약 이름 대신 키 칸을 싣는다. */
const uniqueOn = (columns: string): RegExp => new RegExp(`23505[\\s\\S]*Key \\(${columns}\\)`);

interface Base {
  plantId: bigint;
  uomId: bigint;
  supplierId: bigint;
  itemId: bigint;
  lineId: bigint;
  lotId: bigint;
  inboundLotId: bigint;
  requestId: bigint;
  resultId: bigint;
  userId: bigint;
}

type Tx = Prisma.TransactionClient;

async function one<T>(tx: Tx, sql: string, ...values: unknown[]): Promise<T> {
  const rows = await tx.$queryRawUnsafe<Record<string, T>[]>(sql, ...values);
  return Object.values(rows[0])[0];
}

let seq = 0;

async function base(tx: Tx): Promise<Base> {
  const tag = `${PREFIX}-${process.pid}-${(seq += 1)}`;
  const plantId = await one<bigint>(tx, 'SELECT plant_id FROM mdm.plant ORDER BY plant_id LIMIT 1');
  const businessUnitId = await one<bigint>(tx, 'SELECT business_unit_id FROM mdm.plant WHERE plant_id = $1', plantId);
  const uomId = await one<bigint>(tx, `SELECT uom_id FROM mdm.uom WHERE uom_code = 'EA'`);
  const userId = await one<bigint>(tx, `SELECT app_user_id FROM app.app_user WHERE login_id = 'admin'`);
  const supplierId = await one<bigint>(
    tx, 'INSERT INTO mdm.partner (partner_code, partner_name) VALUES ($1, $1) RETURNING partner_id', tag);
  const itemId = await one<bigint>(
    tx,
    `INSERT INTO mdm.item (item_code, item_name, item_type_code, base_uom_id) VALUES ($1, $1, 'RAW_MATERIAL', $2)
     RETURNING item_id`, tag, uomId);
  const receiptId = await one<bigint>(
    tx,
    `INSERT INTO logistics.inbound_receipt (inbound_receipt_no, supplier_id, plant_id, receipt_datetime, status_code)
     VALUES ($1, $2, $3, clock_timestamp(), 'REGISTERED') RETURNING inbound_receipt_id`, tag, supplierId, plantId);
  const lineId = await addLine(tx, receiptId, 1, itemId, uomId);
  const inboundLotId = await addInboundLot(tx, { plantId, itemId, supplierId, uomId, lineId, no: `${tag}-IL` });
  const lotId = await one<bigint>(
    tx,
    `INSERT INTO trace.lot (lot_no, item_id, lot_type_code, plant_id, initial_qty, uom_id, source_type_code, source_id,
                            status_code, inbound_lot_id)
     VALUES ($1, $2, 'MATERIAL', $3, 10, $4, 'INBOUND_RECEIPT_LINE', $5, 'INSPECTION_PENDING', $6) RETURNING lot_id`,
    tag, itemId, plantId, uomId, lineId, inboundLotId);
  const workerId = await one<bigint>(
    tx,
    `INSERT INTO mdm.worker (worker_no, worker_name, business_unit_id, plant_id, status_code)
     VALUES ($1, $1, $2, $3, 'ACTIVE') RETURNING worker_id`, tag, businessUnitId, plantId);
  const requestId = await one<bigint>(
    tx,
    `INSERT INTO quality.inspection_request (inspection_request_no, inspection_type_code, target_type_code, target_id,
                                             item_id, target_qty, uom_id, status_code, requested_at, inbound_lot_id)
     VALUES ($1, 'IQC', 'INBOUND_LOT', $2, $3, 10, $4, 'IN_PROGRESS', clock_timestamp(), $2) RETURNING inspection_request_id`,
    tag, inboundLotId, itemId, uomId);
  const resultId = await one<bigint>(
    tx,
    `INSERT INTO quality.inspection_result (inspection_result_no, inspection_request_id, inspected_qty, uom_id,
                                            inspector_id, inspected_at, status_code, idempotency_key, confirm_cycle)
     VALUES ($1, $2, 10, $3, $4, clock_timestamp(), 'DRAFT', $1, 1) RETURNING inspection_result_id`,
    tag, requestId, uomId, workerId);
  return { plantId, uomId, supplierId, itemId, lineId, lotId, inboundLotId, requestId, resultId, userId };
}

async function addLine(tx: Tx, receiptId: bigint, lineNo: number, itemId: bigint, uomId: bigint): Promise<bigint> {
  return one<bigint>(
    tx,
    `INSERT INTO logistics.inbound_receipt_line (inbound_receipt_id, line_no, item_id, received_qty, uom_id,
                                                 inspection_required, status_code, supplier_lot_label_attached)
     VALUES ($1, $2, $3, 10, $4, true, 'REGISTERED', false) RETURNING inbound_receipt_line_id`,
    receiptId, lineNo, itemId, uomId);
}

async function addInboundLot(
  tx: Tx,
  input: { plantId: bigint; itemId: bigint; supplierId: bigint; uomId: bigint; lineId: bigint; no: string },
  overrides = `'RECEIVED', NULL, clock_timestamp(), 'PER_RECEIPT'`,
): Promise<bigint> {
  return one<bigint>(
    tx,
    `INSERT INTO trace.inbound_lot (inbound_lot_no, plant_id, item_id, supplier_id, uom_id, receiving_date,
                                    inbound_receipt_line_id, status_code, open_since_date, received_closed_at,
                                    erp_send_mode_code)
     VALUES ($1, $2, $3, $4, $5, current_date, $6, ${overrides}) RETURNING inbound_lot_id`,
    input.no, input.plantId, input.itemId, input.supplierId, input.uomId, input.lineId);
}

describe('피처 005 마이그레이션 — CHECK·유일 색인 (e2e)', () => {
  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** 픽스처를 만들고 `act` 를 돌린 뒤 늘 되돌린다. 거절이면 그 메시지, 통과면 `'ok'`. */
  async function attempt(act: (tx: Tx, b: Base) => Promise<unknown>): Promise<string> {
    try {
      await prisma.$transaction(async (tx) => {
        const b = await base(tx);
        await act(tx, b);
        throw new Rollback();
      });
    } catch (error) {
      if (error instanceof Rollback) return 'ok';
      return error instanceof Error ? error.message : String(error);
    }
    return 'unreachable';
  }

  it('DM-1 픽스처 자체는 모든 제약을 지킨다', async () => {
    expect(await attempt(async () => undefined)).toBe('ok');
  });

  it('DM-1 ck_lot_package — 패키징 세 칸은 셋 다 있거나 다 없고, 있으면 초기 수량 = 개수 × 개당 수량', async () => {
    const setPackage = (count: number | null, per: number | null, withUom: boolean) =>
      attempt((tx, b) =>
        tx.$executeRawUnsafe(
          'UPDATE trace.lot SET package_uom_id = $1, package_count = $2, qty_per_package = $3 WHERE lot_id = $4',
          withUom ? b.uomId : null, count, per, b.lotId));

    expect(await setPackage(2, 5, true)).toBe('ok');
    expect(await setPackage(2, null, true)).toContain('ck_lot_package');
    expect(await setPackage(2, 5, false)).toContain('ck_lot_package');
    expect(await setPackage(3, 5, true)).toContain('ck_lot_package');
  });

  it('DM-1 uq_inbound_lot_open — 같은 공장·공급사·품목에 입하 중(RECEIVING)은 하나뿐', async () => {
    const twoOpen = (secondSupplierDiffers: boolean) =>
      attempt(async (tx, b) => {
        const receiptId = await one<bigint>(
          tx, 'SELECT inbound_receipt_id FROM logistics.inbound_receipt_line WHERE inbound_receipt_line_id = $1', b.lineId);
        const otherSupplier = secondSupplierDiffers
          ? await one<bigint>(tx, `INSERT INTO mdm.partner (partner_code, partner_name)
                                   VALUES ('${PREFIX}-OTHER', 'x') RETURNING partner_id`)
          : b.supplierId;
        const open = `'RECEIVING', current_date, NULL, 'ON_FINALIZE'`;
        for (const [index, supplierId] of [b.supplierId, otherSupplier].entries()) {
          const lineId = await addLine(tx, receiptId, index + 2, b.itemId, b.uomId);
          await addInboundLot(tx, { ...b, supplierId, lineId, no: `${PREFIX}-OPEN-${index}` }, open);
        }
      });

    expect(await twoOpen(true)).toBe('ok');
    expect(await twoOpen(false)).toMatch(uniqueOn('plant_id, supplier_id, item_id'));
  });

  it('DM-1 입하 LOT 상태 CHECK — RECEIVING 은 open_since_date, PER_RECEIPT 는 FINALIZED 불가', async () => {
    const update = (sql: string) =>
      attempt((tx, b) => tx.$executeRawUnsafe(`UPDATE trace.inbound_lot SET ${sql} WHERE inbound_lot_id = $1`, b.inboundLotId));

    expect(await update(`status_code = 'RECEIVING', open_since_date = current_date`)).toBe('ok');
    expect(await update(`status_code = 'RECEIVING'`)).toContain('ck_inbound_lot_open_since');
    expect(await update(`status_code = 'FINALIZED', finalized_at = clock_timestamp()`)).toContain('ck_inbound_lot_per_receipt');
    expect(
      await update(`status_code = 'FINALIZED', finalized_at = clock_timestamp(), erp_send_mode_code = 'ON_FINALIZE'`),
    ).toBe('ok');
    expect(await update(`status_code = 'FINALIZED', erp_send_mode_code = 'ON_FINALIZE'`)).toContain('ck_inbound_lot_finalized');
  });

  it('DM-1 supplier_item_default — 패키징 곱 불일치·같은 공장·공급사·품목 두 행을 거절한다', async () => {
    const insert = (qty: number, count: number, per: number) =>
      `INSERT INTO mdm.supplier_item_default (plant_id, supplier_id, item_id, lot_qty, package_uom_id, package_count, qty_per_package)
       VALUES ($1, $2, $3, ${qty}, $4, ${count}, ${per})`;
    const run = (statements: string[]) =>
      attempt(async (tx, b) => {
        for (const sql of statements) await tx.$executeRawUnsafe(sql, b.plantId, b.supplierId, b.itemId, b.uomId);
      });

    expect(await run([insert(950, 10, 100)])).toContain('ck_supplier_item_default_package');
    expect(await run([insert(1000, 10, 100)])).toBe('ok');
    expect(await run([insert(1000, 10, 100), insert(500, 5, 100)])).toMatch(uniqueOn('plant_id, supplier_id, item_id'));
  });

  it('DM-1 uq_inspection_result_lot — 결과마다 같은 자재 관리 LOT 는 한 번', async () => {
    const match = (times: number) =>
      attempt(async (tx, b) => {
        for (let index = 0; index < times; index += 1) {
          await tx.$executeRawUnsafe(
            'INSERT INTO quality.inspection_result_lot (inspection_result_id, lot_id) VALUES ($1, $2)', b.resultId, b.lotId);
        }
      });

    expect(await match(1)).toBe('ok');
    expect(await match(2)).toMatch(uniqueOn('inspection_result_id, lot_id'));
  });

  it('DM-1 ck_inspection_request_iqc_confirmed — 입하 LOT 를 가진 IQC 요청이 COMPLETED 면 종합 판정·확정 시각 필수', async () => {
    const complete = (set: string, keepInboundLot = true) =>
      attempt((tx, b) =>
        tx.$executeRawUnsafe(
          `UPDATE quality.inspection_request SET status_code = 'COMPLETED'${set}
             ${keepInboundLot ? '' : ', inbound_lot_id = NULL'} WHERE inspection_request_id = $1`, b.requestId));

    expect(await complete(`, overall_judgment_code = 'ACCEPTED', confirmed_at = clock_timestamp()`)).toBe('ok');
    expect(await complete(`, confirmed_at = clock_timestamp()`)).toContain('ck_inspection_request_iqc_confirmed');
    expect(await complete(`, overall_judgment_code = 'ACCEPTED'`)).toContain('ck_inspection_request_iqc_confirmed');
    // 입하 LOT 가 없는 옛 요청은 지금처럼 상태만 바꿔도 된다.
    expect(await complete('', false)).toBe('ok');
  });

  it('DM-1 uq_iqc_inspection_request_inbound_lot — 입하 LOT 하나에 IQC 요청 하나', async () => {
    const second = await attempt((tx, b) =>
      tx.$executeRawUnsafe(
        `INSERT INTO quality.inspection_request (inspection_request_no, inspection_type_code, target_type_code, target_id,
                                                 item_id, target_qty, uom_id, status_code, requested_at, inbound_lot_id)
         SELECT inspection_request_no || '-2', 'IQC', 'INBOUND_LOT', target_id, item_id, target_qty, uom_id, 'REQUESTED',
                requested_at, inbound_lot_id
           FROM quality.inspection_request WHERE inspection_request_id = $1`, b.requestId));

    expect(second).toMatch(uniqueOn('inbound_lot_id'));
  });

  it('DM-1 ck_disposition_decision_sort_qty — 선별 정보 수량은 0 이상, SORT 판정에만', async () => {
    const decide = (type: string, good: number | null, defect: number | null) =>
      attempt(async (tx, b) => {
        const nonconformanceId = await one<bigint>(
          tx,
          `INSERT INTO quality.nonconformance (nonconformance_no, item_id, severity_code, description, status_code, opened_at,
                                               inspection_request_id)
           VALUES ($1, $2, 'MAJOR', 'x', 'PENDING_DECISION', clock_timestamp(), $3) RETURNING nonconformance_id`,
          `${PREFIX}-NC-${(seq += 1)}`, b.itemId, b.requestId);
        await tx.$executeRawUnsafe(
          `INSERT INTO quality.disposition_decision (nonconformance_id, disposition_type_code, decision_qty, uom_id, reason,
                                                     decided_by, decided_at, sort_good_qty, sort_defect_qty)
           VALUES ($1, $2, 10, $3, 'x', $4, clock_timestamp(), $5, $6)`,
          nonconformanceId, type, b.uomId, b.userId, good, defect);
      });

    expect(await decide('SORT', 7, 3)).toBe('ok');
    expect(await decide('SORT', null, null)).toBe('ok');
    // 음수는 수량 도메인(app.qty_t)이 먼저 막는다 — 칸 CHECK 도 같은 뜻을 적어 둔다.
    expect(await decide('SORT', -1, 3)).toMatch(/qty_t_check|ck_disposition_decision_sort_qty/);
    expect(await decide('SCRAP', 7, null)).toContain('ck_disposition_decision_sort_qty');
    expect(await decide('SCRAP', null, null)).toBe('ok');
  });
});

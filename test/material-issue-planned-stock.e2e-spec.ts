/**
 * 생산 창고의 출고 예정 재고(피처 003 · omf-all-around#66 · US4 · SC-003 · SC-004).
 *
 * 예정은 저장하지 않고 요청 줄에서 센다 — `core/material-issue/planned-stock.ts`. 피킹·출고는 그 결과(피킹 줄의
 * `picked_qty`, 잔액의 `picked_qty`·`on_hand_qty`)만 예정과 가용에 닿으므로 여기서는 그 표를 직접 옮긴다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { availableQty, dynamicShortages, pairKey, plannedLines, sumPlanned } from '../src/core/material-issue/planned-stock';
import { localDate } from '../src/planning/production-plan/plan-window';
import { PrismaService } from '../src/prisma/prisma.service';
import { MaterialIssueFixture } from './support/material-issue-fixture';

const PREFIX = `MIP${randomUUID().slice(0, 6)}`;

describe('출고 예정 재고 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: MaterialIssueFixture;
  let seq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    fx = new MaterialIssueFixture(app, prisma, PREFIX);
    await fx.setup();
    fx.ids.p1 = await fx.plant('P1');
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
  });

  /** 생산 창고 하나에 X 재고 `qty`, 그 창고만 연결한 부서·라인. */
  async function warehouseWithX(qty: number) {
    const code = `S${++seq}`;
    const at = await fx.warehouse(fx.ids.p1, `${code}-A`);
    if (qty > 0) await fx.stock(at, 'X', qty);
    const lineId = await fx.line('P1', `${code}-L`, await fx.department(`${code}-D`, [at.warehouseId]));
    return { ...at, lineId };
  }

  const planned = async (warehouseId: bigint) =>
    sumPlanned(await plannedLines(prisma, { warehouseIds: [warehouseId], itemIds: [fx.items.X] })).get(pairKey(warehouseId, fx.items.X))?.toNumber() ?? 0;
  const lineQtys = async (workOrderId: bigint) =>
    (await fx.requests(workOrderId)).flatMap((r) => r.material_issue_request_line.map((l) => [l.requested_qty.toNumber(), l.shortage_qty.toNumber()]));

  /** 피킹(집음)과 출고 전기가 잔액·피킹 줄에 남기는 결과를 그대로 옮긴다. */
  async function pickAndIssue(requestLineId: bigint, at: { warehouseId: bigint }, qty: number, issue: boolean) {
    const line = await prisma.picking_line.findFirstOrThrow({ where: { material_issue_request_line_id: requestLineId } });
    await prisma.picking_line.update({ where: { picking_line_id: line.picking_line_id }, data: { picked_qty: { increment: qty } } });
    const balance = await prisma.inventory_balance.findFirstOrThrow({ where: { warehouse_id: at.warehouseId, lot_id: line.lot_id } });
    await prisma.inventory_balance.update({
      where: { inventory_balance_id: balance.inventory_balance_id },
      data: issue ? { on_hand_qty: { decrement: qty } } : { picked_qty: { increment: qty } },
    });
    if (issue) {
      await prisma.material_issue_request_line.update({
        where: { material_issue_request_line_id: requestLineId },
        data: { issued_qty: { increment: qty } },
      });
    }
  }

  it('US4-1 US4-2 재고 100 → 70 요청(예정 70) → 50 소요는 30 요청 · 부족 20, 배포는 성공', async () => {
    const at = await warehouseWithX(100);
    const first = await fx.workOrder({ plantKey: 'P1', lineId: at.lineId, operation: 'X70', productionDate: fx.nextWeekday('P1', 1) });
    await fx.release(first).expect(200);
    expect(await lineQtys(first)).toEqual([[70, 0]]);
    expect(await planned(at.warehouseId)).toBe(70);

    const second = await fx.workOrder({ plantKey: 'P1', lineId: at.lineId, operation: 'X50', productionDate: fx.nextWeekday('P1', 2) });
    await fx.release(second).expect(200);
    expect(await lineQtys(second)).toEqual([[30, 20]]);
    expect(await planned(at.warehouseId)).toBe(100);

    // 예정이 다 찬 창고에서 바로 배포되는 요청은 요청 0 · 부족 전부이고, 수량 0 인 피킹 줄을 만들지 않는다.
    const third = await fx.workOrder({ plantKey: 'P1', lineId: at.lineId, operation: 'X20', productionDate: localDate(new Date(), 'Asia/Ho_Chi_Minh') });
    await fx.release(third).expect(200);
    expect(await lineQtys(third)).toEqual([[0, 20]]);
    expect(await prisma.picking_line.count({ where: { picking_order: { warehouse_id: at.warehouseId }, planned_qty: { lte: 0 } } })).toBe(0);
  });

  it('US4-3 70 요청을 배포해 30 을 출고하면 예정 40 · 가용 70', async () => {
    const at = await warehouseWithX(100);
    const workOrderId = await fx.workOrder({ plantKey: 'P1', lineId: at.lineId, operation: 'X70', productionDate: localDate(new Date(), 'Asia/Ho_Chi_Minh') });
    await fx.release(workOrderId).expect(200);
    const [row] = await fx.requests(workOrderId);
    expect(row.status_code).toBe('REGISTERED');
    await pickAndIssue(row.material_issue_request_line[0].material_issue_request_line_id, at, 30, true);

    expect(await planned(at.warehouseId)).toBe(40);
    const available = await availableQty(prisma, [at.warehouseId], [fx.items.X]);
    expect(available.get(pairKey(at.warehouseId, fx.items.X))?.toNumber()).toBe(70);
  });

  it('US4-5 다른 업무가 재고를 쓰면 막지 않고 동적 부족 — 출고 작업일이 늦은 요청부터', async () => {
    const at = await warehouseWithX(100);
    const early = await fx.workOrder({ plantKey: 'P1', lineId: at.lineId, operation: 'X50', productionDate: fx.nextWeekday('P1', 1) });
    const late = await fx.workOrder({ plantKey: 'P1', lineId: at.lineId, operation: 'X20', productionDate: fx.nextWeekday('P1', 1, 14) });
    await fx.release(early).expect(200);
    await fx.release(late).expect(200);
    // 창고 이동이 50 을 가져갔다 — 예정 70 · 가용 50.
    const balance = await prisma.inventory_balance.findFirstOrThrow({ where: { warehouse_id: at.warehouseId } });
    await prisma.inventory_balance.update({ where: { inventory_balance_id: balance.inventory_balance_id }, data: { on_hand_qty: 50 } });

    const shortages = await dynamicShortages(prisma, { plantId: fx.ids.p1, warehouseId: at.warehouseId });
    expect(shortages).toHaveLength(1);
    expect([shortages[0].plannedQty.toNumber(), shortages[0].availableQty.toNumber(), shortages[0].shortageQty.toNumber()]).toEqual([70, 50, 20]);
    const [lateRequest] = await fx.requests(late);
    expect(shortages[0].lines.map((l) => [l.requestId, l.shortageQty.toNumber()])).toEqual([[lateRequest.material_issue_request_id, 20]]);
  });

  it('SC-003 요청·피킹·출고·취소를 섞어도 예정 = 활성 요청의 미집음 합', async () => {
    const at = await warehouseWithX(1000);
    let random = 20261103;
    const next = () => (random = (random * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const ops = ['X20', 'X50', 'X70'];
    const today = localDate(new Date(), 'Asia/Ho_Chi_Minh');
    for (let round = 0; round < 8; round++) {
      const released = next() < 0.5;
      const workOrderId = await fx.workOrder({
        plantKey: 'P1', lineId: at.lineId, operation: ops[Math.floor(next() * ops.length)],
        productionDate: released ? today : fx.nextWeekday('P1', 1 + Math.floor(next() * 5)),
      });
      await fx.release(workOrderId).expect(200);
      const [row] = await fx.requests(workOrderId);
      const line = row.material_issue_request_line[0];
      const roll = next();
      if (released && roll < 0.4) {
        await pickAndIssue(line.material_issue_request_line_id, at, Math.floor(line.requested_qty.toNumber() * next()), false);
      } else if (released && roll < 0.7) {
        const qty = Math.floor(line.requested_qty.toNumber() / 2);
        await pickAndIssue(line.material_issue_request_line_id, at, qty, false);
        await pickAndIssue(line.material_issue_request_line_id, at, 0, true);
      } else if (roll < 0.85) {
        await prisma.material_issue_request.update({ where: { material_issue_request_id: row.material_issue_request_id }, data: { status_code: 'CANCELLED' } });
      }
    }

    const active = await prisma.material_issue_request_line.findMany({
      where: { material_issue_request: { source_warehouse_id: at.warehouseId, status_code: { in: ['WAITING', 'REGISTERED'] }, closed_at: null } },
      include: { picking_line: true },
    });
    const expected = active.reduce(
      (sum, l) => sum.plus(Prisma.Decimal.max(l.requested_qty.minus(l.picking_line.reduce((s, p) => s.plus(p.picked_qty), new Prisma.Decimal(0))), 0)),
      new Prisma.Decimal(0),
    );
    expect(await planned(at.warehouseId)).toBe(expected.toNumber());
  });

  it('SC-004 같은 재고를 두 배포가 동시에 잡아도 예정이 가용을 넘지 않는다', async () => {
    const at = await warehouseWithX(100);
    const a = await fx.workOrder({ plantKey: 'P1', lineId: at.lineId, operation: 'X70', productionDate: fx.nextWeekday('P1', 1) });
    const b = await fx.workOrder({ plantKey: 'P1', lineId: at.lineId, operation: 'X70', productionDate: fx.nextWeekday('P1', 2) });
    await Promise.all([fx.release(a).expect(200), fx.release(b).expect(200)]);

    const quantities = [...(await lineQtys(a)), ...(await lineQtys(b))].sort((x, y) => y[0] - x[0]);
    expect(quantities).toEqual([[70, 0], [30, 40]]);
    expect(await planned(at.warehouseId)).toBe(100);
  });
});

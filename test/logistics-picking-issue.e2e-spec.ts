/**
 * 출고 지시 실행(PICK-ISSUE-01) — 피킹 출고가 «원천 전표»에 남기는 자국 셋.
 *   P-14 전량 출고면 피킹 지시를 닫는다(부분 출고면 열어 둔다)
 *   P-15 도착지를 비워 보내면 서버가 출고요청의 도착 위치로 채워 원장에 `to` 를 싣는다
 *   P-16 기출고(`material_issue_request_line.issued_qty`)를 올리고 전 라인이 다 나가면 요청을 닫는다
 * 배정 규칙 자체는 `production-work-order-picking.e2e-spec.ts` 가 본다.
 *
 * 피처 008(omf-all-around#289): 픽스처 LOT 재고(5000)보다 적게 내므로 아래 출고는 모두 «부분 출고»다 — 출고 라인·
 * 출고 원장은 분할 LOT 을 낸다. 위치별 재고 합·지시·기출고 기대값은 그대로다(분할 원장은 같은 위치 안의 이동이다).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'PIE2E';
const LOGIN_ID = 'e2e-pick-issue-probe';
const PASSWORD = 'PI-출고-비밀번호';
const ROLE = 'E2E_PICK_ISSUE';
const BUSINESS_DATE = '2026-09-15';
const OCCURRED_AT = '2026-09-15T02:00:00.000Z';
/** 5칸 자재 LOT 번호 — 분할 번호가 수량 칸을 바꾸는지 본다(피처 008 R-5). */
const LOT_NO = `${PREFIX}-A|5000|260731|SUP|0001`;
const SPLIT_NO = (qty: number) => new RegExp(`^${PREFIX}-A\\|${String(qty)}\\|260731\\|SUP\\|0001-S(\\d+)$`);

describe('피킹 출고가 원천 전표를 닫고 기출고를 올린다 (PICK-ISSUE-01)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let seq = 0;
  const ids: Record<string, bigint> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await makeFixtures();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⭐ 전량 출고 — 지시가 닫히고, 도착지가 채워지고, 기출고가 오른다', async () => {
    const { order, lines, requestId } = await releaseAndPick(100);
    const before = { source: await onHand(ids.materialLocation), wip: await onHand(ids.wipLocation) };

    const created = await issue(order, lines).expect(201);
    expect(created.body.goodsIssue.statusCode).toBe('POSTED');
    // 피처 008 — LOT 재고 5000 중 100 이라 부분 출고다. 출고 라인은 분할 LOT 이다.
    expect(created.body.lines[0].splitFromLotId).toBe(Number(ids.lot));

    // P-15 — 화면은 도착지를 비워 보냈고 서버가 출고요청의 도착 위치로 채운다.
    expect(created.body.goodsIssue).toMatchObject({
      destinationTypeCode: 'LOCATION',
      destinationId: Number(ids.wipLocation),
    });
    const ledger = await ledgerLines(created.body.goodsIssue.goodsIssueId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      from_location_id: ids.materialLocation,
      to_location_id: ids.wipLocation,
      to_warehouse_id: ids.wipWarehouse,
    });
    // 원장 한 «행»에 from·to 가 같이 실린다 — 행이 늘지 않고 재고가 자리를 옮긴다.
    expect(await onHand(ids.materialLocation)).toBe(before.source - 100);
    expect(await onHand(ids.wipLocation)).toBe(before.wip + 100);

    // P-14 — 전 라인이 계획 수량만큼 나갔으므로 지시가 닫힌다.
    expect((await pickingOrder(order)).status_code).toBe('POSTED');
    // P-16 — 기출고가 오르고 요청도 닫힌다.
    const requestLines = await prisma.material_issue_request_line.findMany({
      where: { material_issue_request_id: requestId },
      orderBy: { line_no: 'asc' },
    });
    expect(requestLines.map((line) => line.issued_qty.toNumber())).toEqual([100]);
    expect((await prisma.material_issue_request.findUniqueOrThrow({
      where: { material_issue_request_id: requestId },
    })).status_code).toBe('POSTED');
  });

  it('⭐ 부분 출고 — 지시가 열려 있어 나머지를 집으러 돌아올 수 있다', async () => {
    const { order, lines, requestId } = await releaseAndPick(100, 40);

    await issue(order, lines, 40).expect(201);

    // 목록이 `statusCode=REGISTERED` 로 거르므로, 닫으면 남은 60 을 집을 길이 사라진다.
    expect((await pickingOrder(order)).status_code).toBe('REGISTERED');
    const requestLines = await prisma.material_issue_request_line.findMany({
      where: { material_issue_request_id: requestId },
    });
    expect(requestLines.map((line) => line.issued_qty.toNumber())).toEqual([40]);
    // 요청도 아직 안 닫힌다 — 40 < 100.
    expect((await prisma.material_issue_request.findUniqueOrThrow({
      where: { material_issue_request_id: requestId },
    })).status_code).toBe('REGISTERED');
  });

  it('기출고 누계가 요청 수량을 넘으면 400 이다 — CHECK 위반 500 이 아니다', async () => {
    const { order, lines, requestId } = await releaseAndPick(100);
    const before = await onHand(ids.materialLocation);
    // 요청 수량을 낮춰 「이미 대부분 나간」 상태를 만든다 — 계획 수량 100 이 남아 있다.
    await prisma.material_issue_request_line.updateMany({
      where: { material_issue_request_id: requestId },
      data: { requested_qty: 100, issued_qty: 90 },
    });

    const splitsBefore = await childLots();
    const splitLedgersBefore = await splitLedgerCount();

    const rejected = await issue(order, lines).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ code: 'RANGE' });
    // 400 이면 전기 자체가 없던 일이 된다 — 재고도 지시도 그대로다.
    expect(await onHand(ids.materialLocation)).toBe(before);
    // FR-002 — 기출고 검사는 분할·원장 «뒤»에 돈다. 한 트랜잭션이라 분할 LOT·분할 원장도 남지 않는다.
    expect(await childLots()).toEqual(splitsBefore);
    expect(await splitLedgerCount()).toBe(splitLedgersBefore);
    expect((await pickingOrder(order)).status_code).toBe('REGISTERED');
  });

  it.each(['DEFECTIVE', 'INSPECTION_PENDING'])(
    '⛔ %s LOT 은 생산 투입 출고가 400 STATE_LOCKED 다 — 재고·지시가 그대로다(omf-all-around#240)',
    async (status) => {
      const { order, lines } = await releaseAndPick(100);
      const before = await onHand(ids.materialLocation);
      await prisma.lot.update({ where: { lot_id: ids.lot }, data: { status_code: status } });
      try {
        const rejected = await issue(order, lines).expect(400);
        expect(rejected.body.errors[0]).toMatchObject({ field: 'lines[0].lotId', code: 'STATE_LOCKED' });
        expect(await onHand(ids.materialLocation)).toBe(before);
        expect((await pickingOrder(order)).status_code).toBe('REGISTERED');
      } finally {
        await prisma.lot.update({ where: { lot_id: ids.lot }, data: { status_code: 'NORMAL' } });
      }
    },
  );

  it('출발 == 도착이면 도착지를 채우지 않는다 — 같은 자리 왕복 원장을 만들지 않는다', async () => {
    const { order, lines } = await releaseAndPick(100, 100, ids.materialLocation);
    const before = await onHand(ids.materialLocation);

    const created = await issue(order, lines).expect(201);

    expect(created.body.goodsIssue.destinationTypeCode).toBeNull();
    const ledger = await ledgerLines(created.body.goodsIssue.goodsIssueId);
    expect(ledger[0].to_location_id).toBeNull();
    expect(await onHand(ids.materialLocation)).toBe(before - 100);
  });

  it('⛔ 원천이 피킹 지시가 아니면 도착지를 채우지 않고 원천 전표도 안 건드린다', async () => {
    const receipt = await prisma.goods_receipt.create({
      data: {
        goods_receipt_no: `${PREFIX}-GR${++seq}`, receipt_type_code: 'MATERIAL', plant_id: ids.plant,
        warehouse_id: ids.materialWarehouse, receipt_datetime: new Date(OCCURRED_AT), status_code: 'POSTED',
      },
    });
    const created = await request(app.getHttpServer())
      .post('/api/logistics/goods-issues')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        issueTypeCode: 'SUPPLIER_RETURN',
        sourceDocumentTypeCode: 'GOODS_RECEIPT',
        sourceDocumentId: Number(receipt.goods_receipt_id),
        sourceWarehouseId: Number(ids.materialWarehouse),
        issuedAt: OCCURRED_AT,
        postImmediately: true,
        businessDate: BUSINESS_DATE,
        occurredAt: OCCURRED_AT,
        lines: [
          {
            itemId: Number(ids.item), lotId: Number(ids.lot), issueQty: 10,
            uomId: Number(ids.uom), sourceLocationId: Number(ids.materialLocation),
          },
        ],
      })
      .expect(201);

    expect(created.body.goodsIssue.destinationTypeCode).toBeNull();
    const ledger = await ledgerLines(created.body.goodsIssue.goodsIssueId);
    expect(ledger[0].to_location_id).toBeNull();
  });

  it('피킹 라인이 요청 라인을 안 가리키면 기출고를 올리지 않는다 — 짝을 지어내지 않는다', async () => {
    const { order, lines, requestId } = await releaseAndPick(100);
    await prisma.picking_line.updateMany({
      where: { picking_order_id: order },
      data: { material_issue_request_line_id: null },
    });

    await issue(order, lines).expect(201);

    const requestLines = await prisma.material_issue_request_line.findMany({
      where: { material_issue_request_id: requestId },
    });
    expect(requestLines.map((line) => line.issued_qty.toNumber())).toEqual([0]);
    // 요청은 안 닫히지만 지시는 닫힌다 — 두 판정의 축이 다르다(기출고 ↔ 계획 수량).
    expect((await prisma.material_issue_request.findUniqueOrThrow({
      where: { material_issue_request_id: requestId },
    })).status_code).toBe('REGISTERED');
    expect((await pickingOrder(order)).status_code).toBe('POSTED');
  });

  it('요청 라인이 0건이면 요청을 닫지 않는다 — 「다 나갔다」가 공허한 참이 된다', async () => {
    const { order, lines, requestId } = await releaseAndPick(100);
    await prisma.picking_line.updateMany({
      where: { picking_order_id: order },
      data: { material_issue_request_line_id: null },
    });
    await prisma.material_issue_request_line.deleteMany({
      where: { material_issue_request_id: requestId },
    });

    await issue(order, lines).expect(201);

    expect((await prisma.material_issue_request.findUniqueOrThrow({
      where: { material_issue_request_id: requestId },
    })).status_code).toBe('REGISTERED');
  });

  it('기출고 칸과 `shortage` 의 기출고가 같은 값을 낸다 — 두 벌이던 것이 한 벌이 된다(046)', async () => {
    const { order, lines, requestId, workOrderId } = await releaseAndPick(100);

    await issue(order, lines).expect(201);

    const shortage = await request(app.getHttpServer())
      .get(`/api/logistics/material-issue-requests/shortage?workOrderId=${String(workOrderId)}`)
      .set('Cookie', cookie)
      .expect(200);
    const line = shortage.body.items.find((row: { itemId: number }) => row.itemId === Number(ids.item));
    const requestLines = await prisma.material_issue_request_line.findMany({
      where: { material_issue_request_id: requestId },
    });
    expect(line.issuedQty).toBe(requestLines[0].issued_qty.toNumber());
  });

  describe('부분 출고 LOT 분할 (피처 008 · omf-all-around#289)', () => {
    it('US1-1·US1-2·US1-3·US1-4·US1-8 100 출고 — 분할 LOT 100 이 도착, 원래 LOT 은 출발에 남고, 계보·원천·원장·라인이 분할을 가리킨다', async () => {
      const { order, lines } = await releaseAndPick(100);
      const before = await lotStock(ids.lot);
      const pickedBefore = await parentPicked();

      const created = await issue(order, lines).expect(201);
      const [line] = created.body.lines as { goodsIssueLineId: number; lotId: number; lotNo: string; splitFromLotId: number; splitFromLotNo: string }[];
      // 응답 — 라인 LOT 은 분할 LOT, 원래 LOT 을 함께 싣는다(D-9).
      expect(line.lotId).not.toBe(Number(ids.lot));
      expect(line.lotNo).toMatch(SPLIT_NO(100));
      expect(line).toMatchObject({ splitFromLotId: Number(ids.lot), splitFromLotNo: LOT_NO });

      // US1-2·US1-4 — 부모·원천·상태·유효기한·생애는 부모, 입하 LOT 은 비움.
      const child = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(line.lotId) } });
      expect(child).toMatchObject({
        lot_no: line.lotNo, parent_lot_id: ids.lot, item_id: ids.item, uom_id: ids.uom, plant_id: ids.plant,
        source_type_code: 'GOODS_ISSUE_SPLIT', source_id: BigInt(line.goodsIssueLineId),
        status_code: 'NORMAL', lifecycle_status_code: 'ACTIVE', expiry_date: new Date('2027-07-31T00:00:00.000Z'),
        inbound_lot_id: null,
      });
      expect(child.initial_qty.toNumber()).toBe(100);
      const relation = await prisma.lot_relation.findFirstOrThrow({ where: { target_lot_id: child.lot_id } });
      expect(relation).toMatchObject({
        source_lot_id: ids.lot, relation_type_code: 'SPLIT',
        source_event_type_code: 'GOODS_ISSUE_LINE', source_event_id: BigInt(line.goodsIssueLineId),
      });
      expect(relation.relation_qty.toNumber()).toBe(100);

      // US1-1·SC-002 — 분할 LOT 100 은 도착 위치, 원래 LOT 은 출발에 남고, 합은 출고 전과 같다.
      const after = await lotStock(ids.lot);
      const childStock = await lotStock(child.lot_id);
      expect(childStock).toEqual({ [String(ids.wipLocation)]: 100, [String(ids.materialLocation)]: 0 });
      expect(after[String(ids.materialLocation)]).toBe(before[String(ids.materialLocation)] - 100);
      expect(after[String(ids.materialLocation)] + 100).toBe(before[String(ids.materialLocation)]);

      // 원장 — 분할 원장 1건(원천 GOODS_ISSUE_SPLIT, 출발 위치 안 부모 → 분할) + 출고 원장 1건(분할 LOT), 라인 1:1.
      const issueId = BigInt(created.body.goodsIssue.goodsIssueId);
      const split = await prisma.inventory_transaction.findFirstOrThrow({
        where: { source_document_type_code: 'GOODS_ISSUE_SPLIT', source_document_id: issueId },
        include: { inventory_transaction_line: { orderBy: { line_no: 'asc' } } },
      });
      expect(split).toMatchObject({ transaction_type_code: 'LOT_SPLIT', transaction_no: `${created.body.goodsIssue.goodsIssueNo}-S` });
      expect(split.inventory_transaction_line.map((row) => [row.lot_id, row.from_location_id, row.to_location_id, row.qty.toNumber()])).toEqual([
        [ids.lot, ids.materialLocation, null, 100],
        [child.lot_id, null, ids.materialLocation, 100],
      ]);
      const issued = await prisma.inventory_transaction.findMany({
        where: { source_document_type_code: 'GOODS_ISSUE', source_document_id: issueId },
        include: { inventory_transaction_line: true },
      });
      expect(issued).toHaveLength(1);
      expect(issued[0].inventory_transaction_line.map((row) => row.lot_id)).toEqual([child.lot_id]);
      const issueLine = await prisma.goods_issue_line.findUniqueOrThrow({ where: { goods_issue_line_id: BigInt(line.goodsIssueLineId) } });
      expect(issueLine.lot_id).toBe(child.lot_id);
      expect(issueLine.inventory_transaction_line_id).toBe(issued[0].inventory_transaction_line[0].inventory_transaction_line_id);

      // US1-8 — 피킹 라인은 원래 LOT 그대로, picked 는 원래 LOT 행에서 소진돼 남지 않는다.
      expect((await prisma.picking_line.findUniqueOrThrow({ where: { picking_line_id: lines[0] } })).lot_id).toBe(ids.lot);
      // (앞 시험이 집기만 하고 안 낸 picked 가 같은 행에 남아 있어 차이로 본다.)
      expect(await parentPicked()).toBe(pickedBefore - 100);
      expect((await pickingOrder(order)).status_code).toBe('POSTED');
    });

    it('US1-5 같은 LOT 의 두 번째 부분 출고는 다음 차례(-S{n+1})다', async () => {
      const first = await releaseAndPick(100, 60);
      const one = await issue(first.order, first.lines, 60).expect(201);
      const second = await releaseAndPick(100, 40);
      const two = await issue(second.order, second.lines, 40).expect(201);

      const n1 = Number(SPLIT_NO(60).exec(one.body.lines[0].lotNo)?.[1]);
      const n2 = Number(SPLIT_NO(40).exec(two.body.lines[0].lotNo)?.[1]);
      expect(n2).toBe(n1 + 1);
    });

    it('US1-7 한 출고에 부분 줄이 둘이면 줄마다 분할 LOT 이 하나씩 생긴다', async () => {
      const { order, lines } = await releaseAndPick(100);
      const created = await issue(order, [lines[0], lines[0]], 50).expect(201);

      const result = created.body.lines as { lotId: number; lotNo: string; splitFromLotId: number }[];
      expect(result).toHaveLength(2);
      expect(new Set(result.map((row) => row.lotId)).size).toBe(2);
      for (const row of result) {
        expect(row).toMatchObject({ splitFromLotId: Number(ids.lot) });
        expect(row.lotNo).toMatch(SPLIT_NO(50));
      }
      const ledger = await prisma.inventory_transaction_line.findMany({
        where: { inventory_transaction: { source_document_type_code: 'GOODS_ISSUE_SPLIT', source_document_id: BigInt(created.body.goodsIssue.goodsIssueId) } },
      });
      expect(ledger).toHaveLength(4);
    });

    it('US1-6 남은 재고 전량을 내면 분할하지 않는다 — 출고 라인은 원래 LOT 이다', async () => {
      const parentRow = await prisma.inventory_balance.findFirstOrThrow({ where: { lot_id: ids.lot, location_id: ids.materialLocation } });
      // 다른 위치에는 원래 LOT 재고가 없다(부분 출고는 분할 LOT 이 나갔다) — 출발 위치를 100 으로 맞춘다.
      const elsewhere = Object.entries(await lotStock(ids.lot)).filter(([location, qty]) => location !== String(ids.materialLocation) && qty !== 0);
      expect(elsewhere).toEqual([]);
      // 앞 시험이 집기만 하고 안 낸 picked 도 비운다 — 이 시험의 출고 하나만 남긴다.
      await prisma.inventory_balance.update({ where: { inventory_balance_id: parentRow.inventory_balance_id }, data: { on_hand_qty: 100, picked_qty: 0 } });
      try {
        const { order, lines } = await releaseAndPick(100);
        const created = await issue(order, lines).expect(201);

        expect(created.body.lines[0]).toMatchObject({ lotId: Number(ids.lot), lotNo: LOT_NO, splitFromLotId: null, splitFromLotNo: null });
        expect(await prisma.inventory_transaction.count({
          where: { source_document_type_code: 'GOODS_ISSUE_SPLIT', source_document_id: BigInt(created.body.goodsIssue.goodsIssueId) },
        })).toBe(0);
        expect((await lotStock(ids.lot))[String(ids.wipLocation)]).toBe(100);
      } finally {
        await prisma.inventory_balance.update({
          where: { inventory_balance_id: parentRow.inventory_balance_id },
          data: { on_hand_qty: parentRow.on_hand_qty, picked_qty: parentRow.picked_qty },
        });
      }
    });

    it('US5-1·US5-3·Q23 창고로 돌아온 분할 LOT 을 다시 부분 출고하면 그 분할 LOT 에서 -S1-S1 이 나온다 — 원래 LOT 과 합치지 않는다', async () => {
      const first = await releaseAndPick(100);
      const created = await issue(first.order, first.lines).expect(201);
      const childId = BigInt(created.body.lines[0].lotId);
      const childNo = created.body.lines[0].lotNo as string;
      // 생산 창고에 남은 분할 LOT 100 이 자재 창고로 돌아온 상태(재고 이동의 결과)를 세운다 — 분할 LOT 번호 그대로다.
      await prisma.inventory_balance.updateMany({ where: { lot_id: childId, location_id: ids.wipLocation }, data: { on_hand_qty: 0 } });
      await prisma.inventory_balance.updateMany({ where: { lot_id: childId, location_id: ids.materialLocation }, data: { on_hand_qty: 100, picked_qty: 50 } });
      const parentBefore = await lotStock(ids.lot);

      const again = await releaseAndPick(100, 0);
      // 피킹이 돌아온 분할 LOT 을 집었다 — 피킹 라인 LOT 이 분할 LOT 이다.
      await prisma.picking_line.update({ where: { picking_line_id: again.lines[0] }, data: { lot_id: childId, picked_qty: 50 } });
      const resplit = await request(app.getHttpServer())
        .post('/api/logistics/goods-issues')
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({
          issueTypeCode: 'PRODUCTION', sourceDocumentTypeCode: 'PICKING_ORDER', sourceDocumentId: Number(again.order),
          sourceWarehouseId: Number(ids.materialWarehouse), issuedAt: OCCURRED_AT, postImmediately: true,
          businessDate: BUSINESS_DATE, occurredAt: OCCURRED_AT,
          lines: [{
            pickingLineId: Number(again.lines[0]), itemId: Number(ids.item), lotId: Number(childId), issueQty: 50,
            uomId: Number(ids.uom), sourceLocationId: Number(ids.materialLocation),
          }],
        })
        .expect(201);

      const grandchild = resplit.body.lines[0];
      const [, , , , childSerial] = childNo.split('|');
      expect(grandchild.lotNo).toBe(`${PREFIX}-A|50|260731|SUP|${childSerial}-S1`);
      expect(grandchild).toMatchObject({ splitFromLotId: Number(childId), splitFromLotNo: childNo });
      expect((await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(grandchild.lotId) } })).parent_lot_id).toBe(childId);
      // 남은 50 은 분할 LOT 으로 자재 창고에 남고, 원래 LOT 수량은 바뀌지 않는다(FR-015·016).
      expect((await lotStock(childId))[String(ids.materialLocation)]).toBe(50);
      expect(await lotStock(ids.lot)).toEqual(parentBefore);
    });

    it('R-13 LOT 상태 전이 영향의 출고량은 원래 LOT 의 분할 자손 출고를 함께 센다', async () => {
      const issuedFamily = await prisma.goods_issue_line.aggregate({
        where: { lot: { OR: [{ lot_id: ids.lot }, { parent_lot_id: ids.lot }, { parent_lot: { parent_lot_id: ids.lot } }] }, goods_issue: { status_code: 'POSTED' } },
        _sum: { issue_qty: true },
      });
      const response = await request(app.getHttpServer())
        .get(`/api/quality/lot-status-transitions?lotId=${String(ids.lot)}`)
        .set('Cookie', cookie)
        .expect(200);
      const hold = (response.body.transitions as { impact: { shippedQty: number } | null }[]).find((row) => row.impact !== null);
      const shipped = hold?.impact?.shippedQty;
      expect(shipped).toBeGreaterThan(0);
      expect(shipped).toBe(issuedFamily._sum.issue_qty?.toNumber());
    });

    it('US3-1·US3-2 출고 목록 lotId·awaitingShopfloorReceiptOnly — 분할 LOT 으로 받을 출고를 찾고, 받으면 빠진다', async () => {
      const { order, lines, workOrderId } = await releaseAndPick(100);
      const created = await issue(order, lines).expect(201);
      const issueId = created.body.goodsIssue.goodsIssueId as number;
      const line = created.body.lines[0] as { goodsIssueLineId: number; lotId: number };
      // 같은 분할 LOT 을 원천이 다른 출고(공급사 반품)로도 낸다 — 미입고 축에서 빠져야 한다.
      const receipt = await prisma.goods_receipt.create({
        data: {
          goods_receipt_no: `${PREFIX}-GR${++seq}`, receipt_type_code: 'MATERIAL', plant_id: ids.plant,
          warehouse_id: ids.wipWarehouse, receipt_datetime: new Date(OCCURRED_AT), status_code: 'POSTED',
        },
      });
      const returned = await request(app.getHttpServer())
        .post('/api/logistics/goods-issues')
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({
          issueTypeCode: 'SUPPLIER_RETURN', sourceDocumentTypeCode: 'GOODS_RECEIPT', sourceDocumentId: Number(receipt.goods_receipt_id),
          sourceWarehouseId: Number(ids.wipWarehouse), issuedAt: OCCURRED_AT, postImmediately: true, businessDate: BUSINESS_DATE, occurredAt: OCCURRED_AT,
          lines: [{ itemId: Number(ids.item), lotId: line.lotId, issueQty: 1, uomId: Number(ids.uom), sourceLocationId: Number(ids.wipLocation) }],
        })
        .expect(201);
      // 분할 LOT 을 반품해도 분할하지 않는다 — 원천이 피킹 지시가 아니다(FR-017).
      expect(returned.body.lines[0]).toMatchObject({ lotId: line.lotId, splitFromLotId: null });

      const listed = async (query: string): Promise<number[]> => {
        const response = await request(app.getHttpServer()).get(`/api/logistics/goods-issues?${query}`).set('Cookie', cookie).expect(200);
        return (response.body.items as { goodsIssueId: number }[]).map((row) => row.goodsIssueId).sort((a, b) => a - b);
      };
      expect(await listed(`lotId=${String(line.lotId)}`)).toEqual([issueId, returned.body.goodsIssue.goodsIssueId].sort((a, b) => a - b));
      expect(await listed(`lotId=${String(line.lotId)}&awaitingShopfloorReceiptOnly=true`)).toEqual([issueId]);
      // 원래 LOT 은 이 출고 라인에 없다 — 분할 출고는 원래 LOT 축으로 잡히지 않는다.
      expect(await listed(`lotId=${String(ids.lot)}&awaitingShopfloorReceiptOnly=true`)).not.toContain(issueId);

      // 분할 LOT 출고의 생산창고 입고 — 라인 LOT 대조가 분할 LOT 으로 통과한다.
      await request(app.getHttpServer())
        .post('/api/logistics/shopfloor-receipts')
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('X-Worker-No', `${PREFIX}-WK`)
        .send({
          goodsIssueId: issueId, workOrderId: Number(workOrderId), destinationLocationId: Number(ids.wipLocation),
          receivedAt: OCCURRED_AT, businessDate: BUSINESS_DATE, occurredAt: OCCURRED_AT,
          lines: [{
            goodsIssueLineId: line.goodsIssueLineId, itemId: Number(ids.item), lotId: line.lotId, uomId: Number(ids.uom),
            issuedQty: 100, receivedQty: 100,
          }],
        })
        .expect(201);
      expect(await listed(`lotId=${String(line.lotId)}&awaitingShopfloorReceiptOnly=true`)).toEqual([]);
    });

    it('Q25 같은 LOT 을 두 위치에서 동시에 부분 출고해도 분할 번호가 겹치지 않고 둘 다 된다', async () => {
      const second = await prisma.location.create({
        data: { warehouse_id: ids.materialWarehouse, location_code: `${PREFIX}-M1-02`, location_name: 'M1-02', location_type_code: 'DEFAULT' },
      });
      const parentRow = await prisma.inventory_balance.findFirstOrThrow({ where: { lot_id: ids.lot, location_id: ids.materialLocation } });
      await prisma.inventory_balance.create({
        data: {
          legal_entity_id: parentRow.legal_entity_id, business_unit_id: parentRow.business_unit_id, plant_id: ids.plant,
          warehouse_id: ids.materialWarehouse, location_id: second.location_id, item_id: ids.item, lot_id: ids.lot,
          quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE', ownership_type_code: 'OWNED', on_hand_qty: 1000, uom_id: ids.uom,
        },
      });
      const a = await releaseAndPick(100, 100);
      const b = await releaseAndPick(100, 0);
      // 둘째 지시는 둘째 위치에서 집은 것으로 바꾼다 — 출발 잔액 행이 달라 잔액 잠금으로는 줄을 서지 않는다.
      await prisma.picking_line.update({ where: { picking_line_id: b.lines[0] }, data: { location_id: second.location_id, picked_qty: 100 } });
      await prisma.inventory_balance.updateMany({ where: { lot_id: ids.lot, location_id: second.location_id }, data: { picked_qty: 100 } });

      const [one, two] = await Promise.all([
        issue(a.order, a.lines, 100),
        issue(b.order, b.lines, 100, second.location_id),
      ]);
      expect([one.status, two.status]).toEqual([201, 201]);
      expect(one.body.lines[0].lotNo).toMatch(SPLIT_NO(100));
      expect(two.body.lines[0].lotNo).toMatch(SPLIT_NO(100));
      expect(one.body.lines[0].lotNo).not.toBe(two.body.lines[0].lotNo);
    });
  });

  /** LOT 의 위치별 보유. */
  async function lotStock(lotId: bigint): Promise<Record<string, number>> {
    const rows = await prisma.inventory_balance.findMany({ where: { lot_id: lotId } });
    return Object.fromEntries(rows.map((row) => [String(row.location_id), row.on_hand_qty.toNumber()]));
  }

  async function parentPicked(): Promise<number> {
    const row = await prisma.inventory_balance.findFirstOrThrow({ where: { lot_id: ids.lot, location_id: ids.materialLocation } });
    return row.picked_qty.toNumber();
  }

  function splitLedgerCount(): Promise<number> {
    return prisma.inventory_transaction.count({ where: { source_document_type_code: 'GOODS_ISSUE_SPLIT', plant_id: ids.plant } });
  }

  async function childLots(): Promise<string[]> {
    const rows = await prisma.lot.findMany({ where: { parent_lot_id: ids.lot }, orderBy: { lot_id: 'asc' }, select: { lot_no: true } });
    return rows.map((row) => row.lot_no);
  }

  /** 배포로 요청·지시를 만들고 라인을 계획 수량만큼(또는 `pickQty` 만큼) 집는다. */
  async function releaseAndPick(
    orderQty: number,
    pickQty?: number,
    destinationLocationId?: bigint,
  ): Promise<{ order: bigint; lines: bigint[]; requestId: bigint; workOrderId: bigint }> {
    const workOrderId = await workOrder(destinationLocationId ?? ids.wipLocation);
    await request(app.getHttpServer())
      .post(`/api/production/work-orders/${String(workOrderId)}:release`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '1')
      .send({ lotSize: orderQty })
      .expect(200);

    const requestRow = await prisma.material_issue_request.findFirstOrThrow({
      where: { work_order_id: workOrderId },
    });
    const orderRow = await prisma.picking_order.findFirstOrThrow({
      where: {
        source_document_type_code: 'MATERIAL_ISSUE_REQUEST',
        source_document_id: requestRow.material_issue_request_id,
      },
      include: { picking_line: true },
    });
    // `:pick` 이 하는 일을 픽스처로 흉내 낸다 — 라인의 집은 양과 «잔액의 picked» 는 한 짝이다.
    // 잔액을 안 옮기면 출고의 피킹 소진이 0행을 만나 400 이 된다(`issue-posting.ts` R-4).
    for (const line of orderRow.picking_line) {
      const picked = pickQty ?? line.planned_qty.toNumber();
      await prisma.picking_line.update({
        where: { picking_line_id: line.picking_line_id },
        data: { picked_qty: picked },
      });
      await prisma.inventory_balance.updateMany({
        where: { lot_id: line.lot_id, location_id: line.location_id },
        data: { picked_qty: { increment: picked } },
      });
    }
    return {
      order: orderRow.picking_order_id,
      lines: orderRow.picking_line.map((line) => line.picking_line_id),
      requestId: requestRow.material_issue_request_id,
      workOrderId,
    };
  }

  /** 모바일 `M-01-08` 과 같은 본문 — **도착지를 비워** 보낸다. */
  function issue(orderId: bigint, pickingLineIds: bigint[], qty = 100, sourceLocationId = ids.materialLocation): request.Test {
    return request(app.getHttpServer())
      .post('/api/logistics/goods-issues')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        issueTypeCode: 'PRODUCTION',
        sourceDocumentTypeCode: 'PICKING_ORDER',
        sourceDocumentId: Number(orderId),
        sourceWarehouseId: Number(ids.materialWarehouse),
        issuedAt: OCCURRED_AT,
        postImmediately: true,
        businessDate: BUSINESS_DATE,
        occurredAt: OCCURRED_AT,
        lines: pickingLineIds.map((pickingLineId) => ({
          pickingLineId: Number(pickingLineId),
          itemId: Number(ids.item),
          lotId: Number(ids.lot),
          issueQty: qty,
          uomId: Number(ids.uom),
          sourceLocationId: Number(sourceLocationId),
        })),
      });
  }

  async function ledgerLines(goodsIssueId: number): Promise<
    { from_location_id: bigint | null; to_location_id: bigint | null; to_warehouse_id: bigint | null }[]
  > {
    const transaction = await prisma.inventory_transaction.findFirstOrThrow({
      where: { source_document_type_code: 'GOODS_ISSUE', source_document_id: BigInt(goodsIssueId) },
    });
    return prisma.inventory_transaction_line.findMany({
      where: {
        inventory_transaction_id: transaction.inventory_transaction_id,
        business_date: transaction.business_date,
      },
      orderBy: { line_no: 'asc' },
      select: { from_location_id: true, to_location_id: true, to_warehouse_id: true },
    });
  }

  async function onHand(locationId: bigint): Promise<number> {
    const rows = await prisma.inventory_balance.findMany({ where: { location_id: locationId } });
    return rows.reduce((sum, row) => sum + row.on_hand_qty.toNumber(), 0);
  }

  function pickingOrder(orderId: bigint) {
    return prisma.picking_order.findUniqueOrThrow({ where: { picking_order_id: orderId } });
  }

  async function workOrder(destinationLocationId: bigint): Promise<bigint> {
    const row = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WO${++seq}`,
        production_plan_id: ids.plan,
        routing_operation_id: ids.operation,
        item_id: ids.itemFg,
        order_qty: 100,
        uom_id: ids.uom,
        status_code: 'PLANNED',
        // 배포 전제 — 라인이 비면 `:release` 가 400 이다(omf-all-around#36).
        production_line_id: ids.productionLine,
        responsible_worker_id: ids.worker,
        default_wip_location_id: destinationLocationId,
        default_fg_location_id: destinationLocationId,
        default_scrap_location_id: destinationLocationId,
      },
    });
    return row.work_order_id;
  }

  async function makeFixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '출고검사법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const unit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '출고검사사업부' },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: '출고검사공장', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    ids.plant = plant.plant_id;
    ids.productionLine = (
      await prisma.production_line.create({
        data: { plant_id: plant.plant_id, line_code: `${PREFIX}-LN`, line_name: '출고검사라인' },
      })
    ).production_line_id;
    ids.uom = (await prisma.uom.findFirstOrThrow()).uom_id;
    ids.itemFg = (await prisma.item.create({
      data: { item_code: `${PREFIX}-FG`, item_name: 'FG', item_type_code: 'FINISHED', base_uom_id: ids.uom },
    })).item_id;
    ids.item = (await prisma.item.create({
      data: { item_code: `${PREFIX}-A`, item_name: 'A', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.uom },
    })).item_id;

    const process = await prisma.process.create({
      data: { process_code: `${PREFIX}-PR`, process_name: '사출', process_type_code: 'MACHINING' },
    });
    const routing = await prisma.routing.create({
      data: { item_id: ids.itemFg, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'CONFIRMED' },
    });
    ids.operation = (await prisma.routing_operation.create({
      data: { routing_id: routing.routing_id, operation_seq: 10, process_id: process.process_id, operation_name: '사출' },
    })).routing_operation_id;
    const bom = await prisma.bom.create({
      data: {
        parent_item_id: ids.itemFg, bom_code: `${PREFIX}-BOM`, bom_version: 1, status_code: 'CONFIRMED',
        effective_from: new Date('2026-01-01T00:00:00.000Z'), base_qty: 1, base_uom_id: ids.uom,
      },
    });
    await prisma.bom_component.create({
      data: {
        bom_id: bom.bom_id, component_item_id: ids.item, required_qty: 1,
        routing_operation_id: ids.operation, uom_id: ids.uom, sequence_no: 1,
      },
    });

    const warehouse = async (code: string, type: string) => {
      const wh = await prisma.warehouse.create({
        data: {
          plant_id: plant.plant_id, business_unit_id: unit.business_unit_id, warehouse_code: `${PREFIX}-${code}`,
          warehouse_name: code, warehouse_type_code: type, management_level_code: 'WAREHOUSE',
        },
      });
      const location = await prisma.location.create({
        data: { warehouse_id: wh.warehouse_id, location_code: `${PREFIX}-${code}-01`, location_name: code, location_type_code: 'DEFAULT' },
      });
      return { warehouseId: wh.warehouse_id, locationId: location.location_id };
    };
    const material = await warehouse('M1', 'MATERIAL');
    const wip = await warehouse('WIP', 'GENERAL');
    ids.materialWarehouse = material.warehouseId;
    ids.materialLocation = material.locationId;
    ids.wipWarehouse = wip.warehouseId;
    ids.wipLocation = wip.locationId;

    ids.worker = (await prisma.worker.create({
      data: { worker_no: `${PREFIX}-WK`, worker_name: '출고검사작업자', business_unit_id: unit.business_unit_id, plant_id: plant.plant_id, status_code: 'EMPLOYED' },
    })).worker_id;
    const lot = await prisma.lot.create({
      data: {
        lot_no: LOT_NO, item_id: ids.item, lot_type_code: 'MATERIAL', plant_id: plant.plant_id,
        initial_qty: 5000, uom_id: ids.uom, source_type_code: 'GOODS_RECEIPT', source_id: 0, status_code: 'NORMAL',
        lifecycle_status_code: 'ACTIVE', expiry_date: new Date('2027-07-31T00:00:00.000Z'),
      },
    });
    ids.lot = lot.lot_id;
    await prisma.inventory_balance.create({
      data: {
        legal_entity_id: entity.legal_entity_id, business_unit_id: unit.business_unit_id, plant_id: plant.plant_id,
        warehouse_id: material.warehouseId, location_id: material.locationId, item_id: ids.item, lot_id: lot.lot_id,
        quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE', ownership_type_code: 'OWNED',
        on_hand_qty: 5000, uom_id: ids.uom,
      },
    });

    const order = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO`, business_unit_id: unit.business_unit_id, plant_id: plant.plant_id,
        item_id: ids.itemFg, order_qty: 100, uom_id: ids.uom, status_code: 'RECEIVED',
      },
    });
    ids.plan = (await prisma.production_plan.create({
      data: {
        production_order_id: order.production_order_id, plan_no: `${PREFIX}-PP`, plan_date: new Date(`${BUSINESS_DATE}T00:00:00.000Z`),
        planned_qty: 100, uom_id: ids.uom, bom_id: bom.bom_id, routing_id: routing.routing_id, status_code: 'CONFIRMED',
      },
    })).production_plan_id;

    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: '출고검사', status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '출고검사용' } });
    await prisma.role_permission.createMany({
      data: ['W-02-04', 'W-02-10', 'M-01-08', 'W-01-05', 'W-03-02', 'M-01-09'].map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    const login = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    cookie = login.headers['set-cookie'] as unknown as string[];
  }

  async function cleanup(): Promise<void> {
    const plantScope = { plant: { plant_code: { startsWith: PREFIX } } };
    const workOrderScope = { work_order: { work_order_no: { startsWith: PREFIX } } };
    const warehouseScope = { warehouse: { warehouse_code: { startsWith: PREFIX } } };
    // ⛔ 원장은 트리거가 UPDATE·DELETE 를 막아 TRUNCATE 뿐이다. `goods_issue_line
    //    .inventory_transaction_line_id` FK 때문에 CASCADE 가 출고·입고 라인까지 함께 비운다
    //    (`logistics-goods-issue.e2e-spec.ts` 선례).
    await prisma.$executeRawUnsafe(
      `TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE`,
    );
    // 분할 LOT 출고의 생산창고 입고(US3-1) — 라인·적치 지시는 위 TRUNCATE CASCADE 가 비운다.
    await prisma.putaway_task.deleteMany({ where: { shopfloor_receipt_line: { shopfloor_receipt: { goods_issue: { warehouse: { warehouse_code: { startsWith: PREFIX } } } } } } });
    await prisma.shopfloor_receipt_line.deleteMany({ where: { item: { item_code: { startsWith: PREFIX } } } });
    await prisma.shopfloor_receipt.deleteMany({ where: { goods_issue: { warehouse: { warehouse_code: { startsWith: PREFIX } } } } });
    await prisma.goods_issue_line.deleteMany({ where: { item: { item_code: { startsWith: PREFIX } } } });
    await prisma.goods_issue.deleteMany({ where: { warehouse: { warehouse_code: { startsWith: PREFIX } } } });
    await prisma.goods_receipt_line.deleteMany({ where: { goods_receipt: { goods_receipt_no: { startsWith: PREFIX } } } });
    await prisma.goods_receipt.deleteMany({ where: { goods_receipt_no: { startsWith: PREFIX } } });
    await prisma.picking_line.deleteMany({ where: { picking_order: warehouseScope } });
    await prisma.picking_order.deleteMany({ where: warehouseScope });
    await prisma.material_issue_request_line.deleteMany({ where: { material_issue_request: workOrderScope } });
    await prisma.material_issue_request.deleteMany({ where: workOrderScope });
    await prisma.inventory_balance.deleteMany({ where: plantScope });
    await prisma.lot_lifecycle_history.deleteMany({ where: { lot: plantScope } });
    // 분할 계보(피처 008) — 부모·자식이 같은 공장이라 lot 은 한 문장으로 지운다.
    await prisma.lot_relation.deleteMany({ where: { lot_lot_relation_target_lot_idTolot: plantScope } });
    await prisma.lot.deleteMany({ where: plantScope });
    await prisma.work_order.deleteMany({ where: { work_order_no: { startsWith: PREFIX } } });
    await prisma.production_plan.deleteMany({ where: { plan_no: { startsWith: PREFIX } } });
    await prisma.production_order.deleteMany({ where: { production_order_no: { startsWith: PREFIX } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.location.deleteMany({ where: warehouseScope });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.bom_component.deleteMany({ where: { bom: { bom_code: { startsWith: PREFIX } } } });
    await prisma.bom.deleteMany({ where: { bom_code: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (user) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});

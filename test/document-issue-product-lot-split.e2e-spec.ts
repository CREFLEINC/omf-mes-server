/**
 * 피처 013 생산 LOT 수량 분리(omf-all-around#303) — 생산 LOT 라벨의 값(수량·W/O·생산일)과 단말 권한(D-7) (e2e).
 *
 * 시험 이름 앞의 ID 는 `specs/013-product-lot-split/verification.md`·`quickstart.md` 의 항목이다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { PLS_PREFIX, ProductLotSplitFixture, TerminalSession } from './support/product-lot-split-fixture';

describe('생산 LOT 분리 — 라벨 값·단말 권한 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let f: ProductLotSplitFixture;
  /** P-04-08 단말 — 라벨 출력은 W/O 공정이 아닌 다른 공정에만 켜져 있다. */
  let warehousePop: TerminalSession;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    f = new ProductLotSplitFixture(app, prisma);
    await f.setup();
    const other = (await prisma.process.findFirst({ where: { process_code: `${PLS_PREFIX}-PR2` } }))
      ?? await prisma.process.create({ data: { process_code: `${PLS_PREFIX}-PR2`, process_name: '분리검사창고', process_type_code: 'ASSEMBLY' } });
    warehousePop = await f.terminal('POP4', 'POP', f.ids.plant, true, other.process_id);
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  /** TSPL 렌디션의 TEXT 칸들. */
  const renditionTexts = async (documentIssueLogId: number): Promise<string> => {
    const response = await f.asTerminal(f.http().get(`/api/app/document-issues/${documentIssueLogId}/rendition?format=tspl`), f.pop)
      .buffer(true)
      .parse((stream, callback) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    return [...(response.body as Buffer).toString('utf8').matchAll(/^TEXT [^"]*"0",0,\d+,\d+,"(.*)"$/gm)].map((match) => match[1]).join('\n');
  };

  const issue = (lotIds: number[], session: TerminalSession, reissueReasonCode?: string) =>
    f.asTerminal(f.http().post('/api/app/document-issues').set('Idempotency-Key', randomUUID()), session).send({
      documentTypeCode: 'PRODUCTION_LOT_LABEL',
      targets: lotIds.map((targetId) => ({ targetTypeCode: 'LOT', targetId })),
      ...(reissueReasonCode === undefined ? {} : { reissueReasonCode }),
    });

  describe('렌디션 값', () => {
    it('US1-3·Q3·Q4 원래 LOT 라벨은 70(배분 100 − 분리 30), 자식은 30·W/O·생산일이 원래 LOT 의 것', async () => {
      const { workOrderId, workOrderNo } = await f.workOrder();
      const lot = await f.lot({ workOrderId, balances: [{ at: 'A', qty: 100 }] });
      await f.result(workOrderId, lot.lotId, 100, '2026-11-18T02:30:00.000Z');

      const split = await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 30 }).expect(200);

      const parent = await renditionTexts(split.body.parentLot.documentIssueLogId);
      const child = await renditionTexts(split.body.childLot.documentIssueLogId);
      for (const text of ['QTY: 70 PLSE2E-EA', `PROD  NORMAL  ${workOrderNo}`, 'MFG DT: 26-11-18 09:30']) expect(parent).toContain(text);
      for (const text of ['QTY: 30 PLSE2E-EA', `PROD  NORMAL  ${workOrderNo}`, 'MFG DT: 26-11-18 09:30', `LOT NO.: ${lot.lotNo}-S1`]) {
        expect(child).toContain(text);
      }
    });

    it('US1-5·Q5 손자 -S1-S1 도 W/O 는 뿌리의 것이고, 자식 라벨은 다시 나눈 만큼 줄어든다', async () => {
      const { workOrderId, workOrderNo } = await f.workOrder();
      const lot = await f.lot({ workOrderId, balances: [{ at: 'A', qty: 100 }] });
      const first = await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 30 }).expect(200);
      await prisma.product_lot_split.update({
        where: { product_lot_split_id: BigInt(first.body.productLotSplitId) },
        data: { confirmed_at: new Date(), confirmed_terminal_id: f.pda.terminalId },
      });

      const grand = await f.split({ lotId: first.body.childLot.lotId, locationId: f.locationOf('A'), qty: 10 }).expect(200);

      const grandChild = await renditionTexts(grand.body.childLot.documentIssueLogId);
      const child = await renditionTexts(grand.body.parentLot.documentIssueLogId);
      for (const text of ['QTY: 10 PLSE2E-EA', `PROD  NORMAL  ${workOrderNo}`]) expect(grandChild).toContain(text);
      for (const text of ['QTY: 20 PLSE2E-EA', `PROD  NORMAL  ${workOrderNo}`]) expect(child).toContain(text);
    });

    it('Q20 008 부분 출고 분할 자식은 원래 LOT 라벨 수량에서 빼지 않는다', async () => {
      const lot = await f.lot({ balances: [{ at: 'A', qty: 100 }] });
      const child = await prisma.lot.create({ data: {
        lot_no: `${lot.lotNo}-S1`, item_id: f.ids.itemA, lot_type_code: 'PRODUCTION', plant_id: f.ids.plant, initial_qty: 20,
        uom_id: f.ids.uom, source_type_code: 'GOODS_ISSUE_SPLIT', source_id: 1, parent_lot_id: BigInt(lot.lotId), status_code: 'NORMAL',
      } });
      await prisma.lot_relation.create({ data: {
        source_lot_id: BigInt(lot.lotId), target_lot_id: child.lot_id, relation_type_code: 'SPLIT', relation_qty: 20, uom_id: f.ids.uom,
        source_event_type_code: 'GOODS_ISSUE_LINE', source_event_id: 1, allocation_method_code: 'EXACT', trace_accuracy_code: 'EXACT', occurred_at: new Date(),
      } });

      const issued = await issue([lot.lotId], f.pop).expect(201);

      expect(await renditionTexts(issued.body.items[0].documentIssueLogId)).toContain('QTY: 100 PLSE2E-EA');
    });
  });

  describe('단말 권한 (D-7)', () => {
    it('US1-7 P-04-08 단말(다른 공정에 라벨 권한)이 분리 가족 두 LOT 을 다시 낸다 — 사람이 고른 사유로', async () => {
      const lot = await f.lot({ balances: [{ at: 'A', qty: 100 }] });
      const split = await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 30 }, warehousePop).expect(200);

      const again = await issue([lot.lotId, split.body.childLot.lotId], warehousePop, 'PRINT_FAILURE').expect(201);

      expect(again.body.items.map((item: { issueSeq: number; reissueReasonCode: string }) => [item.issueSeq, item.reissueReasonCode]))
        .toEqual([[2, 'PRINT_FAILURE'], [2, 'PRINT_FAILURE']]);
    });

    it('W/O 공정 단말 규칙은 그대로 — 가족 아닌 LOT 은 P-04-08 단말이면 403, W/O 공정 단말이면 201', async () => {
      const lot = await f.lot({ balances: [{ at: 'A', qty: 100 }] });

      const denied = await issue([lot.lotId], warehousePop).expect(403);

      expect(denied.body.errors[0]).toMatchObject({ code: 'PERMISSION_DENIED' });
      await issue([lot.lotId], f.pop).expect(201);
    });

    it('라벨 공정이 하나도 없는 POP 은 분리 가족이어도 403', async () => {
      const lot = await f.lot({ balances: [{ at: 'A', qty: 100 }] });
      const split = await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 30 }).expect(200);

      await issue([split.body.childLot.lotId], f.popNoLabel, 'PRINT_FAILURE').expect(403);
    });

    it('R-7 사람 요청이 재발행 사유 LOT_SPLIT 을 보내면 422 — 서버만 쓰는 사유다', async () => {
      const lot = await f.lot({ balances: [{ at: 'A', qty: 100 }] });
      await issue([lot.lotId], f.pop).expect(201);

      const rejected = await issue([lot.lotId], f.pop, 'LOT_SPLIT').expect(422);

      expect(rejected.body.errors[0]).toMatchObject({ field: 'reissueReasonCode', code: 'INVALID' });
    });
  });
});

/**
 * 적치 지시 조회 2건 + 뷰(I-12 PR ①). 완료·임시 적재 두 POST 는 PR ② 몫이다.
 *
 * ⛔ 여기서는 지시를 만들지 않는다 — 실제 `POST /logistics/goods-receipts` 로 만든다
 * (입고 스위트가 이미 못 박은 사실 — 라인마다 적치 지시가 생긴다). `temporaryOnly`·
 * `statusCode`·`assignedWorkerId`·`priorityNo` 테스트용 값은 `:complete` 없이
 * `prisma.putaway_task.update` 로 상태 칸만 직접 심는다(원장 없이).
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { seedRoute } from './approval-request.fixture';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-pt-probe';
const PASSWORD = 'PT-검사-비밀번호';
const PREFIX = 'PTE2E';
const ROLE = 'E2E_PT';
// ⭐ PR ② 가 셋을 더한다 — 후속 문서를 실 API 로 만들고(출고 W-01-06) 입고 취소를
// 요청·승인·실행하기(W-01-13 · W-03-09) 때문이다.
const PERMISSIONS = ['W-01-10', 'M-01-05', 'M-01-07', 'M-04-04', 'W-01-06', 'W-01-13', 'W-03-09'];
const NO_PERM_LOGIN = 'e2e-pt-noperm';
const DAY = '2026-05-11';
const AT = '2026-05-11T02:00:00.000Z';

function validator(operation: string, status = 200): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

interface TaskBody {
  putawayTaskId: number;
  warehouseId: number;
  warehouseManagementLevelCode: string;
  statusCode: string;
  priorityNo: number;
}
interface ReceiptLineDraft {
  itemId: number;
  lotId: number;
  receiptQty: number;
  uomId: number;
  qualityStatusCode: string;
  inventoryStatusCode: string;
  destinationLocationId: number;
}
interface ReceiptDraft {
  receiptTypeCode: string;
  plantId: number;
  warehouseId: number;
  receiptDatetime: string;
  businessDate: string;
  lines: ReceiptLineDraft[];
}
interface ReceiptResult {
  goodsReceipt: { goodsReceiptId: number };
  lines: { putawayTaskId: number | null }[];
}

describe('적치 지시 조회 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];

  let plantId: number;
  let warehouseId: number;
  let otherWarehouseId: number;
  let dockId: number;
  let rackId: number;
  let otherDockId: number;
  let uomId: number;
  let ruledItemId: number;
  let plainItemId: number;
  let worker1Id: number;

  let goodsReceipt1Id: number;
  let lotR1: number;
  let taskR1: number;
  let taskR2: number;
  let taskR3: number;
  let taskR4: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeUsers();
    await makeMasters();
    // 취소 결재선은 시드가 0행이다 — 단계 1(자기 결재). ⛔ 사업부 지정본으로 두지 못한다:
    // 상신이 `businessUnitId: null` 로 올라가 전 사업부 공통본만 고른다(`ROUTE_NOT_FOUND`).
    // 겹침은 없다 — 아래 `cleanup()` 이 이 유형의 결재선을 앞뒤로 비우고 스위트는 직렬이다.
    const me = await prisma.app_user.findUniqueOrThrow({ where: { login_id: LOGIN_ID } });
    await seedRoute(prisma, 'GOODS_RECEIPT_CANCEL', [me.app_user_id]);
    await makeTasks();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('목록이 goodsReceiptId 로 걸러진다', async () => {
    const { items } = await list(`goodsReceiptId=${goodsReceipt1Id}`);

    expect(items.map((task) => task.putawayTaskId)).toEqual([taskR1]);
  });

  it('⭐ 목록이 warehouseId 로 걸러지고 그 축이 goods_receipt.warehouse_id 다', async () => {
    const { items } = await list(`warehouseId=${warehouseId}`);
    const ids = items.map((task) => task.putawayTaskId);

    // 다른 창고 입고(taskR3)가 심겨 있는데도 나오지 않는다 — from_location_id 축이 아니다.
    expect(ids).toEqual(expect.arrayContaining([taskR1, taskR2, taskR4]));
    expect(ids).not.toContain(taskR3);
  });

  it('목록이 assignedWorkerId·lotId·statusCode 로 걸러진다', async () => {
    const byWorker = await list(`assignedWorkerId=${worker1Id}`);
    expect(byWorker.items.map((task) => task.putawayTaskId)).toEqual([taskR2]);

    const byLot = await list(`lotId=${lotR1}`);
    expect(byLot.items.map((task) => task.putawayTaskId)).toEqual([taskR1]);

    const byStatus = await list('statusCode=PENDING');
    const pendingIds = byStatus.items.map((task) => task.putawayTaskId);
    expect(pendingIds).toEqual(expect.arrayContaining([taskR1, taskR2, taskR4]));
    expect(pendingIds).not.toContain(taskR3);
  });

  // omf-all-around#26 — 관리웹 입고는 담당자를 못 채운다(계정↔작업자 연결 없음). 적치에 담당자는
  // 필요 없다(2026-09-19 사용자 결정): 모바일은 담당자 없이 단말 공장의 대기 지시를 읽는다.
  it('⭐ MOBILE 단말이 assignedWorkerId 없이 읽으면 미배정 대기 지시가 나온다', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/logistics/putaway-tasks?statusCode=PENDING&size=100')
      .set('Authorization', `Bearer ${await mobileToken()}`)
      .expect(200);
    const ids = (response.body as { items: TaskBody[] }).items.map((task) => task.putawayTaskId);

    expect(ids).toEqual(expect.arrayContaining([taskR1, taskR2, taskR4]));
    expect(ids).not.toContain(taskR3);
  });

  it('⭐ temporaryOnly=true 는 COMPLETED_TEMPORARY 만 낸다', async () => {
    const { items } = await list('temporaryOnly=true');

    expect(items.map((task) => task.putawayTaskId)).toContain(taskR3);
    expect(items.every((task) => task.statusCode === 'COMPLETED_TEMPORARY')).toBe(true);
  });

  it('temporaryOnly=true 와 statusCode=PENDING 이 겹치면 빈 목록이다', async () => {
    const { items } = await list('temporaryOnly=true&statusCode=PENDING');

    expect(items).toEqual([]);
  });

  it('목록이 priority_no asc · PK asc 로 온다', async () => {
    const { items } = await list(`warehouseId=${warehouseId}`);
    const ids = items.map((task) => task.putawayTaskId);

    // priority_no: taskR2(10) < taskR1(20) = taskR4(20) — 동률은 PK(생성 순서) 로 갈린다.
    expect(ids.indexOf(taskR2)).toBeLessThan(ids.indexOf(taskR1));
    expect(ids.indexOf(taskR1)).toBeLessThan(ids.indexOf(taskR4));
  });

  it('⭐ 항목이 warehouseId·warehouseManagementLevelCode 를 채운다', async () => {
    const main = await getDetail(taskR1).expect(200);
    const validate = validator('GET /logistics/putaway-tasks/{putawayTaskId}');
    expect(validate(main.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(main.body.warehouseId).toBe(warehouseId);
    expect(main.body.warehouseManagementLevelCode).toBe('LOCATION');

    // 다른 창고 지시는 그 창고의 관리 수준을 낸다 — 하드코딩이 아니라 조인이다.
    const other = await getDetail(taskR3).expect(200);
    expect(other.body.warehouseId).toBe(otherWarehouseId);
    expect(other.body.warehouseManagementLevelCode).toBe('RACK');
  });

  it('없는 지시는 404 이고 상세는 ETag 를 내린다', async () => {
    await getDetail(999999999).expect(404);

    const response = await getDetail(taskR1).expect(200);
    expect(response.headers.etag).toBeDefined();
  });

  /**
   * PR ② — 완료·임시 적재. ⛔ 위 8건(PR ①)의 픽스처와 순서를 건드리지 않는다: 여기서 쓰는
   * 지시는 전부 `freshTask()` 가 «새 입고»로 새로 만든다(완료는 되돌릴 수 없는 전이라 재사용
   * 할 수 없다).
   */
  describe('적치 완료 · 임시 적재', () => {
    it('⭐ M1 마디 — 적치 완료가 200 과 PutawayTask 를 내고 statusCode 가 COMPLETED 다', async () => {
      const task = await freshTask(ruledItemId, 10);

      const response = await callComplete(task.taskId, { actualLocationId: rackId }).expect(200);

      const validate = validator('POST /logistics/putaway-tasks/{putawayTaskId}:complete');
      expect(validate(response.body)).toBe(true);
      expect(validate.errors ?? []).toEqual([]);
      expect(response.body).toMatchObject({
        putawayTaskId: task.taskId, statusCode: 'COMPLETED', actualLocationId: rackId,
      });
      // ⛔ 200 에 낙관적 잠금 토큰이 없다 — 계약이 헤더를 선언하지 않았다. 보이는 것은
      //    Express 가 본문 해시로 붙이는 약한 ETag 라 `version_no` 가 아니다.
      expect(String(response.headers.etag)).toMatch(/^W\//);
      // `completed_at` 은 서버 시각이 아니라 본문 `occurredAt` 이다(R-13 ⓐ).
      expect(response.body.completedAt).toBe(new Date(AT).toISOString());
    });

    it('⭐ 원장이 from·to 를 «둘 다» 실은 라인 한 줄을 만든다', async () => {
      const task = await freshTask(ruledItemId, 10);

      await callComplete(task.taskId, { actualLocationId: rackId }).expect(200);

      const line = await ledgerLineOf(task.taskId);
      expect(line).toMatchObject({
        from_warehouse_id: BigInt(warehouseId), from_location_id: BigInt(dockId),
        from_quality_status_code: 'NORMAL', from_inventory_status_code: 'AVAILABLE',
        to_warehouse_id: BigInt(warehouseId), to_location_id: BigInt(rackId),
        to_quality_status_code: 'NORMAL', to_inventory_status_code: 'AVAILABLE',
        ownership_type_code: 'OWNED',
      });
      expect(Number(line.qty)).toBe(10);
      // 이동이라 두 잔량 흔적이 다 실린다 — 입고(도착만)·출고(출발만)와 갈리는 자리다.
      expect(Number(line.from_qty_after_transaction)).toBe(0);
      expect(Number(line.to_qty_after_transaction)).toBe(10);
    });

    it('⭐ inventory_balance 가 하역장 0 · 실제 위치 task_qty 로 옮겨진다', async () => {
      const task = await freshTask(ruledItemId, 10);

      await callComplete(task.taskId, { actualLocationId: rackId }).expect(200);

      expect(await onHand(task.lotId, dockId)).toBe(0);
      expect(await onHand(task.lotId, rackId)).toBe(10);
    });

    it('putaway_task.inventory_transaction_line_id 가 그 라인을 되짚는다', async () => {
      const task = await freshTask(ruledItemId, 10);

      await callComplete(task.taskId, { actualLocationId: rackId }).expect(200);

      const row = await prisma.putaway_task.findUniqueOrThrow({
        where: { putaway_task_id: BigInt(task.taskId) },
      });
      const line = await ledgerLineOf(task.taskId);
      expect(row.inventory_transaction_line_id).toBe(line.inventory_transaction_line_id);
      // ⛔ 응답 스키마에 없는 칸이다 — 저장은 하고 내리지는 않는다(문의 059+2).
      expect(row.version_no).toBe(2);
    });

    it('⚠ 원장 헤더가 sourceDocumentTypeCode=STOCK_TRANSFER · sourceDocumentId=putawayTaskId 다 — stock_transfer 가 «아니다»', async () => {
      const task = await freshTask(ruledItemId, 10);

      await callComplete(task.taskId, { actualLocationId: rackId }).expect(200);

      const header = await prisma.inventory_transaction.findFirstOrThrow({
        where: {
          source_document_type_code: 'STOCK_TRANSFER',
          source_document_id: BigInt(task.taskId),
        },
      });
      // ⚠ 설계 미정 — 문의 059. 값은 「대상 테이블 이름」인데 가리키는 표가 `putaway_task` 다.
      const transfer = await prisma.stock_transfer.findMany({
        where: { stock_transfer_id: BigInt(task.taskId) },
      });
      expect(transfer).toHaveLength(0);
      expect(header.transaction_type_code).toBe('STOCK_TRANSFER');
      expect(header.transaction_no).toMatch(/^PT-/);
      expect(header.status_code).toBe('POSTED');
    });

    it('권장 위치가 있는데 다른 위치면 400 INVALID(actualLocationId)', async () => {
      const task = await freshTask(ruledItemId, 10);

      const response = await callComplete(task.taskId, {
        actualLocationId: dockId, confirmedNoRule: true,
      }).expect(400);

      // ⛔ 권장이 있으면 `confirmedNoRule` 을 읽지 않는다 — 플래그로 안 풀린다(R-4).
      expect(response.body.errors[0]).toMatchObject({ code: 'INVALID', field: 'actualLocationId' });
      expect(response.body.errors[0].message).toContain('권장 위치');
    });

    it('권장이 없고 confirmedNoRule 이 없으면 400 REQUIRED(confirmedNoRule)', async () => {
      const task = await freshTask(plainItemId, 10);

      const response = await callComplete(task.taskId, { actualLocationId: rackId }).expect(400);

      expect(response.body.errors[0]).toMatchObject({ code: 'REQUIRED', field: 'confirmedNoRule' });
    });

    it('권장이 없고 confirmedNoRule=true 면 통과하고 실제 위치가 남는다', async () => {
      const task = await freshTask(plainItemId, 10);

      const response = await callComplete(task.taskId, {
        actualLocationId: rackId, confirmedNoRule: true,
      }).expect(200);

      expect(response.body.actualLocationId).toBe(rackId);
    });

    it('⭐ 출발 위치와 같아도 200 이고 잔액이 제자리다', async () => {
      const task = await freshTask(plainItemId, 10);

      await callComplete(task.taskId, { actualLocationId: dockId, confirmedNoRule: true }).expect(200);

      // 코어가 `-qty` 를 먼저 `+qty` 를 나중에 쓴다 — 같은 행이라 잔액이 제자리다(R-7).
      expect(await onHand(task.lotId, dockId)).toBe(10);
      const line = await ledgerLineOf(task.taskId);
      expect(line.from_location_id).toBe(line.to_location_id);
    });

    it('두 번 완료하면 400 STATE_LOCKED', async () => {
      const task = await freshTask(ruledItemId, 10);
      await callComplete(task.taskId, { actualLocationId: rackId }).expect(200);

      const response = await callComplete(task.taskId, { actualLocationId: rackId }).expect(400);

      expect(response.body.errors[0].code).toBe('STATE_LOCKED');
    });

    it('같은 Idempotency-Key 재전송이 같은 응답을 내고 원장이 1건 그대로다', async () => {
      const task = await freshTask(ruledItemId, 10);
      const key = randomUUID();

      const first = await callComplete(task.taskId, { actualLocationId: rackId }, { key }).expect(200);
      const again = await callComplete(task.taskId, { actualLocationId: rackId }, { key }).expect(200);

      expect(again.body).toEqual(first.body);
      const ledger = await prisma.inventory_transaction.count({
        where: {
          source_document_type_code: 'STOCK_TRANSFER',
          source_document_id: BigInt(task.taskId),
        },
      });
      expect(ledger).toBe(1);
    });

    it('⭐ 적치를 완료하면 그 입고의 :cancel 이 400 SUCCESSOR_EXISTS 다', async () => {
      const task = await freshTask(ruledItemId, 10);
      await callComplete(task.taskId, { actualLocationId: rackId }).expect(200);

      // 적치 원장은 `(STOCK_TRANSFER, task)` 라 「자기 전기 제외」 규칙을 안 지나 후속으로 센다.
      const response = await requestCancel(task.receiptId, 1).expect(400);

      expect(response.body.errors[0].code).toBe('SUCCESSOR_EXISTS');
    });

    it('취소된 입고의 지시는 400 STATE_LOCKED', async () => {
      const task = await freshTask(plainItemId, 10);
      await requestCancel(task.receiptId, 1).expect(202);
      await approveLastCancel();
      await callCancel(task.receiptId, 2).expect(200);

      const response = await callComplete(task.taskId, {
        actualLocationId: rackId, confirmedNoRule: true,
      }).expect(400);

      // ⭐ 상태 판정이 잔액 하한 «앞»이다 — 역처리로 잔액이 0 이어도 사유는 이쪽이다.
      expect(response.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    });

    it('잔액 행이 없으면 400 NEGATIVE_BALANCE', async () => {
      // 「그 LOT 의 재고가 없다」를 만드는 유일한 길 — 잔액 행은 psql 로 지울 수 없으므로
      // 입고가 세우지 «않은» LOT 을 실은 지시를 심는다(같은 하역장·같은 품목·다른 LOT).
      const base = await freshTask(plainItemId, 10);
      const line = await prisma.goods_receipt_line.findFirstOrThrow({
        where: { goods_receipt_id: BigInt(base.receiptId) },
      });
      const strayLot = await makeLot(plainItemId);
      const stray = await prisma.putaway_task.create({
        data: {
          putaway_task_no: `${PREFIX}-PT-STRAY`,
          goods_receipt_line_id: line.goods_receipt_line_id,
          item_id: BigInt(plainItemId), lot_id: BigInt(strayLot), task_qty: 1,
          uom_id: BigInt(uomId), from_location_id: BigInt(dockId), status_code: 'PENDING',
        },
      });

      const response = await callComplete(Number(stray.putaway_task_id), {
        actualLocationId: rackId, confirmedNoRule: true,
      }).expect(400);

      expect(response.body.errors[0]).toMatchObject({ scope: 'screen', code: 'NEGATIVE_BALANCE' });
    });

    it('보유 수량보다 많으면 400 NEGATIVE_BALANCE', async () => {
      const task = await freshTask(plainItemId, 10);
      // 완료 «전»에 같은 하역장에서 기타출고를 먼저 낸다 — 가용이 4 로 준다.
      await issueFromDock(task.receiptId, task.lotId, 6);

      const response = await callComplete(task.taskId, {
        actualLocationId: rackId, confirmedNoRule: true,
      }).expect(400);

      expect(response.body.errors[0]).toMatchObject({ scope: 'screen', code: 'NEGATIVE_BALANCE' });
    });

    it('X-Worker-No 가 없으면 400 REQUIRED', async () => {
      const task = await freshTask(ruledItemId, 10);

      const response = await callComplete(task.taskId, { actualLocationId: rackId }, {
        worker: null,
      }).expect(400);

      expect(response.body.errors[0]).toMatchObject({ code: 'REQUIRED', field: 'X-Worker-No' });
    });

    it('If-Match 가 어긋나면 409 이고 안 실으면 통과한다(C-9)', async () => {
      const stale = await freshTask(ruledItemId, 10);

      await callComplete(stale.taskId, { actualLocationId: rackId }, { ifMatch: 99 }).expect(409);
      // 큐는 토큰을 안 싣는다 — 부재는 그대로 통과한다.
      await callComplete(stale.taskId, { actualLocationId: rackId }).expect(200);
    });

    it('무권한 사용자는 403', async () => {
      const task = await freshTask(ruledItemId, 10);

      await callComplete(task.taskId, { actualLocationId: rackId }, {
        cookies: noPermCookie,
      }).expect(403);
    });

    it('임시 적재가 200 과 COMPLETED_TEMPORARY 를 내고 reason_code·remarks 를 저장한다', async () => {
      const task = await freshTask(plainItemId, 10);

      const response = await callComplete(task.taskId, {
        actualLocationId: rackId, reasonCode: 'NO_SPACE', remarks: '선반이 찼다',
      }, { path: 'complete-temporary' }).expect(200);

      const validate = validator('POST /logistics/putaway-tasks/{putawayTaskId}:complete-temporary');
      expect(validate(response.body)).toBe(true);
      expect(response.body.statusCode).toBe('COMPLETED_TEMPORARY');
      // ⚠ 응답 스키마에 `reasonCode` 가 없다 — 저장은 한다(문의 059+2).
      expect(response.body.reasonCode).toBeUndefined();
      const row = await prisma.putaway_task.findUniqueOrThrow({
        where: { putaway_task_id: BigInt(task.taskId) },
      });
      expect(row).toMatchObject({ reason_code: 'NO_SPACE', remarks: '선반이 찼다' });
    });

    it('임시 적재도 원장 한 줄을 쌓는다', async () => {
      const task = await freshTask(plainItemId, 10);

      await callComplete(task.taskId, {
        actualLocationId: rackId, reasonCode: 'NO_SPACE',
      }, { path: 'complete-temporary' }).expect(200);

      const line = await ledgerLineOf(task.taskId);
      expect(line.to_location_id).toBe(BigInt(rackId));
      expect(await onHand(task.lotId, rackId)).toBe(10);
    });

    it('사유도 비고도 없으면 400 REQUIRED', async () => {
      const task = await freshTask(plainItemId, 10);

      const response = await callComplete(task.taskId, { actualLocationId: rackId }, {
        path: 'complete-temporary',
      }).expect(400);

      expect(response.body.errors[0]).toMatchObject({ code: 'REQUIRED', field: 'reasonCode' });
    });

    it('그룹 밖 reasonCode 는 400 INVALID', async () => {
      const task = await freshTask(plainItemId, 10);

      const response = await callComplete(task.taskId, {
        actualLocationId: rackId, reasonCode: 'NOT_A_REASON',
      }, { path: 'complete-temporary' }).expect(400);

      expect(response.body.errors[0]).toMatchObject({ code: 'INVALID', field: 'reasonCode' });
    });

    it('임시 적재에는 권장 강제가 걸리지 않는다', async () => {
      const task = await freshTask(ruledItemId, 10);

      // 권장은 rack 인데 dock 에 둔다 — `M-01-05` 의 차단을 푸는 탈출구이므로 통과한다.
      const response = await callComplete(task.taskId, {
        actualLocationId: dockId, reasonCode: 'LOCATION_UNASSIGNED',
      }, { path: 'complete-temporary' }).expect(200);

      expect(response.body).toMatchObject({
        statusCode: 'COMPLETED_TEMPORARY', actualLocationId: dockId,
      });
    });

    /** 완료는 되돌릴 수 없는 전이라 갈래마다 «새» 입고로 지시를 하나씩 만든다. */
    async function freshTask(
      itemId: number,
      receiptQty: number,
    ): Promise<{ taskId: number; receiptId: number; lotId: number }> {
      const lotId = await makeLot(itemId);
      const receipt = await createReceipt(
        receiptDraft(itemId, lotId, warehouseId, dockId, receiptQty),
      );
      return {
        taskId: receipt.lines[0].putawayTaskId as number,
        receiptId: receipt.goodsReceipt.goodsReceiptId,
        lotId,
      };
    }

    function callComplete(
      putawayTaskId: number,
      body: Record<string, unknown>,
      opts: {
        key?: string; worker?: string | null; ifMatch?: number;
        cookies?: string[]; path?: string;
      } = {},
    ): request.Test {
      const call = request(app.getHttpServer())
        .post(`/api/logistics/putaway-tasks/${putawayTaskId}:${opts.path ?? 'complete'}`)
        .set('Cookie', opts.cookies ?? cookie)
        .set('Idempotency-Key', opts.key ?? randomUUID());
      if (opts.worker !== null) call.set('X-Worker-No', opts.worker ?? `${PREFIX}-W1`);
      if (opts.ifMatch !== undefined) call.set('If-Match', String(opts.ifMatch));
      return call.send({ businessDate: DAY, occurredAt: AT, ...body });
    }

    function requestCancel(goodsReceiptId: number, version: number): request.Test {
      return request(app.getHttpServer())
        .post(`/api/logistics/document-progress/GOODS_RECEIPT/${goodsReceiptId}:request-cancel`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', String(version))
        .send({ reason: '적치 e2e 취소' });
    }

    function callCancel(goodsReceiptId: number, version: number): request.Test {
      return request(app.getHttpServer())
        .post(`/api/logistics/document-progress/GOODS_RECEIPT/${goodsReceiptId}:cancel`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', String(version));
    }

    /** 결재선은 단계 1(자기 결재)이라 상신한 계정이 그대로 승인한다. */
    async function approveLastCancel(): Promise<void> {
      const approval = await prisma.approval_request.findFirstOrThrow({
        where: { approval_type_code: 'GOODS_RECEIPT_CANCEL' },
        orderBy: { approval_request_id: 'desc' },
      });
      const id = Number(approval.approval_request_id);
      const detail = await request(app.getHttpServer())
        .get(`/api/app/approval-requests/${id}`)
        .set('Cookie', cookie)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/app/approval-requests/${id}:approve`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', detail.headers.etag as string)
        .send({})
        .expect(200);
    }

    /** 「그 사이 잔액이 줄었다」를 실 API 로 만든다 — 같은 하역장에서 기타출고를 낸다. */
    async function issueFromDock(
      goodsReceiptId: number,
      lotId: number,
      issueQty: number,
    ): Promise<void> {
      await request(app.getHttpServer())
        .post('/api/logistics/goods-issues')
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({
          issueTypeCode: 'OTHER',
          sourceDocumentTypeCode: 'GOODS_RECEIPT',
          sourceDocumentId: goodsReceiptId,
          sourceWarehouseId: warehouseId,
          issuedAt: AT, businessDate: DAY, occurredAt: AT, postImmediately: true,
          lines: [
            {
              itemId: plainItemId, lotId, issueQty, uomId,
              sourceLocationId: dockId,
            },
          ],
        })
        .expect(201);
    }

    async function ledgerLineOf(putawayTaskId: number): Promise<{
      inventory_transaction_line_id: bigint;
      from_warehouse_id: bigint | null; from_location_id: bigint | null;
      to_warehouse_id: bigint | null; to_location_id: bigint | null;
      qty: unknown; from_qty_after_transaction: unknown; to_qty_after_transaction: unknown;
    }> {
      const header = await prisma.inventory_transaction.findFirstOrThrow({
        where: {
          source_document_type_code: 'STOCK_TRANSFER',
          source_document_id: BigInt(putawayTaskId),
        },
      });
      const lines = await prisma.inventory_transaction_line.findMany({
        where: { inventory_transaction_id: header.inventory_transaction_id },
      });
      expect(lines).toHaveLength(1);
      return lines[0];
    }

    async function onHand(lotId: number, locationId: number): Promise<number> {
      const row = await prisma.inventory_balance.findFirst({
        where: { lot_id: BigInt(lotId), location_id: BigInt(locationId) },
      });
      return row === null ? 0 : Number(row.on_hand_qty);
    }
  });

  function getDetail(putawayTaskId: number): request.Test {
    return request(app.getHttpServer())
      .get(`/api/logistics/putaway-tasks/${putawayTaskId}`)
      .set('Cookie', cookie);
  }

  async function mobileToken(): Promise<string> {
    const terminal = await prisma.terminal.create({
      data: {
        terminal_code: `${PREFIX}-PDA`,
        plant_id: BigInt(plantId),
        terminal_type_code: 'MOBILE',
        status_code: 'RUNNING',
      },
    });
    return app.get(JwtService).sign({
      sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version,
      terminalCode: terminal.terminal_code, plantId,
    });
  }

  async function list(query: string): Promise<{ items: TaskBody[] }> {
    const response = await request(app.getHttpServer())
      .get(`/api/logistics/putaway-tasks?${query}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /logistics/putaway-tasks');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body as { items: TaskBody[] };
  }

  async function createReceipt(draft: ReceiptDraft): Promise<ReceiptResult> {
    const response = await request(app.getHttpServer())
      .post('/api/logistics/goods-receipts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send(draft)
      .expect(201);
    return response.body as ReceiptResult;
  }

  /**
   * 입고 4건 — main 창고 3건(권장 있음 1 · 권장 없음 2) · 다른 창고 1건.
   * 그 뒤 완료·임시 적재 POST 없이 `prisma.putaway_task.update` 로 담당자·상태·
   * 우선순위만 직접 심는다(§8-1 — 이 값들을 내는 POST 는 PR ② 몫이다).
   */
  async function makeTasks(): Promise<void> {
    lotR1 = await makeLot(ruledItemId);
    const r1 = await createReceipt(receiptDraft(ruledItemId, lotR1, warehouseId, dockId, 10));
    goodsReceipt1Id = r1.goodsReceipt.goodsReceiptId;
    taskR1 = r1.lines[0].putawayTaskId as number;

    const lot2 = await makeLot(plainItemId);
    const r2 = await createReceipt(receiptDraft(plainItemId, lot2, warehouseId, dockId, 20));
    taskR2 = r2.lines[0].putawayTaskId as number;

    const lot3 = await makeLot(plainItemId);
    const r3 = await createReceipt(
      receiptDraft(plainItemId, lot3, otherWarehouseId, otherDockId, 30),
    );
    taskR3 = r3.lines[0].putawayTaskId as number;

    const lot4 = await makeLot(plainItemId);
    const r4 = await createReceipt(receiptDraft(plainItemId, lot4, warehouseId, dockId, 15));
    taskR4 = r4.lines[0].putawayTaskId as number;

    await prisma.putaway_task.update({
      where: { putaway_task_id: taskR2 },
      data: { assigned_worker_id: worker1Id, priority_no: 10 },
    });
    await prisma.putaway_task.update({
      where: { putaway_task_id: taskR3 },
      data: { status_code: 'COMPLETED_TEMPORARY' },
    });
    await prisma.putaway_task.update({
      where: { putaway_task_id: taskR1 },
      data: { priority_no: 20 },
    });
    await prisma.putaway_task.update({
      where: { putaway_task_id: taskR4 },
      data: { priority_no: 20 },
    });
  }

  function receiptDraft(
    itemId: number,
    lotId: number,
    forWarehouseId: number,
    destinationLocationId: number,
    receiptQty: number,
  ): ReceiptDraft {
    return {
      receiptTypeCode: 'MATERIAL',
      plantId,
      warehouseId: forWarehouseId,
      receiptDatetime: AT,
      businessDate: DAY,
      lines: [
        {
          itemId,
          lotId,
          receiptQty,
          uomId,
          qualityStatusCode: 'NORMAL',
          inventoryStatusCode: 'AVAILABLE',
          destinationLocationId,
        },
      ],
    };
  }

  let lotSeq = 0;
  async function makeLot(itemId: number): Promise<number> {
    lotSeq += 1;
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-${lotSeq}`,
        item_id: itemId,
        lot_type_code: 'MATERIAL',
        plant_id: plantId,
        initial_qty: 100,
        uom_id: uomId,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'INSPECTION_PENDING',
      },
    });
    return Number(lot.lot_id);
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '적치검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '적치검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '적치검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    plantId = Number(plant.plant_id);

    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);

    // ⚠ main 의 management_level_code 는 입고 e2e 실측값('LOCATION')과 맞춘다 — 두
    // 스위트가 다른 값을 쓸 이유가 없다(코드 값이지만 여기서는 임의 문자열로 충분하다).
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`,
        warehouse_name: '적치검사창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    warehouseId = Number(warehouse.warehouse_id);
    const otherWarehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH2`,
        warehouse_name: '적치검사창고2',
        warehouse_type_code: 'RAW',
        management_level_code: 'RACK',
      },
    });
    otherWarehouseId = Number(otherWarehouse.warehouse_id);

    const dock = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-DOCK`,
        location_name: '하역장',
        location_type_code: 'BIN',
      },
    });
    dockId = Number(dock.location_id);
    const rack = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-RACK`,
        location_name: '권장위치',
        location_type_code: 'BIN',
      },
    });
    rackId = Number(rack.location_id);
    const otherDock = await prisma.location.create({
      data: {
        warehouse_id: otherWarehouse.warehouse_id,
        location_code: `${PREFIX}-DOCK2`,
        location_name: '다른창고하역장',
        location_type_code: 'BIN',
      },
    });
    otherDockId = Number(otherDock.location_id);

    const ruled = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT1`,
        item_name: '적치검사품목권장',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    ruledItemId = Number(ruled.item_id);
    const plain = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT2`,
        item_name: '적치검사품목무권장',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    plainItemId = Number(plain.item_id);

    // 규칙은 권장 품목에만 둔다 — 무권장 품목의 지시는 recommendedLocationId 가 null 이다.
    await prisma.putaway_rule.create({
      data: {
        item_id: ruled.item_id,
        warehouse_id: warehouse.warehouse_id,
        location_id: rack.location_id,
        capacity_qty: 1000,
        uom_id: uom.uom_id,
      },
    });

    const worker = await prisma.worker.create({
      data: {
        worker_no: `${PREFIX}-W1`,
        worker_name: '적치검사작업자',
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        status_code: 'EMPLOYED',
      },
    });
    worker1Id = Number(worker.worker_id);
  }

  async function makeUsers(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '적치검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '적치검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });

    // 403 을 재려면 «권한이 하나도 없는» 계정이 따로 있어야 한다.
    const noPerm = await prisma.app_user.create({
      data: { login_id: NO_PERM_LOGIN, user_name: '적치무권한', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: noPerm.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });

    cookie = await login(LOGIN_ID);
    noPermCookie = await login(NO_PERM_LOGIN);
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

  /**
   * ⛔ 원장은 트리거가 행 삭제를 막아 TRUNCATE 뿐이다(입고 스위트와 같은 이유) —
   * CASCADE 가 `goods_receipt_line`·`putaway_task` 까지 함께 비운다.
   */
  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(
      `TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE`,
    );
    // 승인은 문서보다 «먼저» 지운다 — 단계 → 요청 → 결재선 순(FK 방향 · 문서진행 스위트 선례).
    const cancelType = { approval_type_code: 'GOODS_RECEIPT_CANCEL' };
    await prisma.approval_step.deleteMany({ where: { approval_request: cancelType } });
    await prisma.approval_request.deleteMany({ where: cancelType });
    await prisma.approval_route_step.deleteMany({ where: { approval_route: cancelType } });
    await prisma.approval_route.deleteMany({ where: cancelType });
    await prisma.$executeRawUnsafe(`
      DELETE FROM app.document_cancellation
       WHERE cancelled_by IN (SELECT app_user_id FROM app.app_user WHERE login_id = '${LOGIN_ID}')`);
    // TRUNCATE CASCADE 가 라인은 비웠고 헤더만 남는다 — 출고는 창고 축으로 짚는다.
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.goods_issue
       WHERE source_warehouse_id IN
             (SELECT warehouse_id FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.goods_receipt
       WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.putaway_rule
       WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM inventory.inventory_balance
       WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`);

    for (const loginId of [LOGIN_ID, NO_PERM_LOGIN]) {
      const target = await prisma.app_user.findUnique({ where: { login_id: loginId } });
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

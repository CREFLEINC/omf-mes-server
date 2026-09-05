import { HttpStatus, NotFoundException } from '@nestjs/common';

import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE } from '../../common/errors';
import { ApprovalService } from '../../core/approval';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { PurchaseOrderQueryService } from './purchase-order-query.service';
import { PurchaseOrderService } from './purchase-order.service';

/** 쓰기 검사는 채번을 부르지 않는다 — 호출되면 스텁이 바로 실패시킨다. */
const NUMBERING_STUB = {
  next: async () => {
    throw new Error('이 경로에서는 채번을 부르지 않는다');
  },
} as unknown as NumberingService;

/** 응답 조립(조회)은 다른 서비스 몫이다 — 쓰기 검사가 그 경로까지 가면 스텁이 실패시킨다. */
const QUERY_STUB = {
  get: async () => {
    throw new Error('이 경로에서는 조회 서비스를 부르지 않는다');
  },
} as unknown as PurchaseOrderQueryService;

/** 쓰기 검사가 상신 코어까지 가면 스텁이 실패시킨다. */
const APPROVAL_STUB = {
  request: async () => {
    throw new Error('이 경로에서는 상신 코어를 부르지 않는다');
  },
} as unknown as ApprovalService;

type Args = Record<string, unknown>;

const orderRow = (overrides: Args = {}): Args => ({
  purchase_order_id: 1n,
  purchase_order_no: 'PO-2026-000123',
  erp_purchase_order_no: null,
  supplier_id: 10n,
  business_unit_id: 20n,
  plant_id: 30n,
  order_date: new Date('2026-08-06T00:00:00.000Z'),
  expected_receipt_date: null,
  status_code: 'REGISTERED',
  version_no: 1,
  approval_request_id: null,
  source_inbound_receipt_line_id: null,
  ...overrides,
});

describe('PurchaseOrderService', () => {
  describe('update', () => {
    /** §7-4 — `STATE_LOCKED`·404·409 은 P/O 가 1차엔 도달 못 하는 자리라 e2e 로 못 세운다. */
    function updateStub(overrides: { current?: Args | null; updatedCount?: number } = {}) {
      const prisma = {
        purchase_order: {
          findUnique: async () => (overrides.current === undefined ? orderRow() : overrides.current),
          updateMany: async () => ({ count: overrides.updatedCount ?? 1 }),
          findUniqueOrThrow: async () => orderRow({ version_no: 2 }),
        },
      };
      return { prisma: prisma as unknown as PrismaService };
    }

    it('작성중(REGISTERED)이 아니면 400 STATE_LOCKED 다', async () => {
      const { prisma } = updateStub({ current: orderRow({ status_code: 'POSTED' }) });

      const error = await thrown(() =>
        new PurchaseOrderService(prisma, NUMBERING_STUB, QUERY_STUB, APPROVAL_STUB).update(
          1,
          1,
          { supplierId: 10, orderDate: '2026-08-06' },
          99,
        ),
      );

      expect(error).toBeInstanceOf(ContractException);
      expect((error as ContractException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect((error as ContractException).errors[0]).toMatchObject({
        field: 'statusCode',
        code: ERROR_CODE.STATE_LOCKED,
      });
    });

    it('없는 P/O 면 404 다', async () => {
      const { prisma } = updateStub({ current: null });

      const error = await thrown(() =>
        new PurchaseOrderService(prisma, NUMBERING_STUB, QUERY_STUB, APPROVAL_STUB).update(
          999,
          1,
          { supplierId: 10, orderDate: '2026-08-06' },
          99,
        ),
      );

      expect(error).toBeInstanceOf(NotFoundException);
    });

    it('낡은 If-Match 로 updateMany 가 0행이면 409 다(user)', async () => {
      const { prisma } = updateStub({ updatedCount: 0 });

      const error = await thrown(() =>
        new PurchaseOrderService(prisma, NUMBERING_STUB, QUERY_STUB, APPROVAL_STUB).update(
          1,
          1,
          { supplierId: 10, orderDate: '2026-08-06' },
          99,
        ),
      );

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).conflict.conflictCause).toBe('user');
    });
  });

  describe('replaceLines', () => {
    /**
     * `$transaction` 콜백을 그대로 돌리는 최소 스텁. 아래 넷은 전부 «쓰기 전»에 던지는
     * 자리라 create/update/$executeRaw 까지 가지 않는다 — 가면 스텁이 실패시킨다.
     */
    function replaceStub(overrides: { current?: Args | null; lines?: Args[] } = {}) {
      const tx = {
        purchase_order: {
          findUnique: async () => (overrides.current === undefined ? orderRow() : overrides.current),
          updateMany: async () => ({ count: 1 }),
        },
        purchase_order_line: {
          findMany: async () => overrides.lines ?? [],
          deleteMany: async () => ({ count: 0 }),
          create: async () => {
            throw new Error('이 검사는 쓰기까지 가지 않는다');
          },
          update: async () => {
            throw new Error('이 검사는 쓰기까지 가지 않는다');
          },
        },
        $executeRaw: async () => {
          throw new Error('이 검사는 쓰기까지 가지 않는다');
        },
      };
      const prisma = {
        $transaction: async (run: (client: unknown) => Promise<unknown>) => run(tx),
      };
      return { prisma: prisma as unknown as PrismaService };
    }

    const service = (prisma: PrismaService): PurchaseOrderService =>
      new PurchaseOrderService(prisma, NUMBERING_STUB, QUERY_STUB, APPROVAL_STUB);

    const line = (lineId: bigint, receivedQty = '0'): Args => ({
      purchase_order_line_id: lineId,
      received_qty: new Prisma.Decimal(receivedQty),
    });

    /** §7-4 — P/O 는 1차 내내 REGISTERED 라 이 가드는 e2e 로 못 세운다. */
    it('치환 — 작성중(REGISTERED)이 아니면 400 STATE_LOCKED 다', async () => {
      const { prisma } = replaceStub({ current: orderRow({ status_code: 'POSTED' }) });

      const error = await thrown(() =>
        service(prisma).replaceLines(1, 1, [{ itemId: 100, orderedQty: 1, uomId: 5 }], 99),
      );

      expect((error as ContractException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect((error as ContractException).errors[0]).toMatchObject({
        field: 'statusCode',
        code: ERROR_CODE.STATE_LOCKED,
      });
    });

    /** 계약이 `minItems` 를 안 걸어 가드가 빈 배열을 통과시킨다 — 서비스가 막는다. */
    it('치환 — 빈 배열이면 400 LINE_REQUIRED 다', async () => {
      const { prisma } = replaceStub();

      const error = await thrown(() => service(prisma).replaceLines(1, 1, [], 99));

      expect((error as ContractException).errors[0]).toMatchObject({
        field: 'items',
        code: ERROR_CODE.LINE_REQUIRED,
      });
    });

    it('치환 — 이 P/O 것이 아닌 purchaseOrderLineId 는 400 INVALID 다', async () => {
      const { prisma } = replaceStub({ lines: [line(1n)] });

      const error = await thrown(() =>
        service(prisma).replaceLines(
          1,
          1,
          [{ purchaseOrderLineId: 999, itemId: 100, orderedQty: 1, uomId: 5 }],
          99,
        ),
      );

      expect((error as ContractException).errors[0]).toMatchObject({
        field: 'items.0.purchaseOrderLineId',
        code: ERROR_CODE.INVALID,
      });
    });

    /** 안 막으면 같은 행에 update 가 두 번 걸려 라인이 «조용히» 사라진다(#194 Major-1). */
    it('치환 — 같은 purchaseOrderLineId 를 두 번 실으면 400 INVALID 다', async () => {
      const { prisma } = replaceStub({ lines: [line(1n), line(2n)] });

      const error = await thrown(() =>
        service(prisma).replaceLines(
          1,
          1,
          [
            { purchaseOrderLineId: 1, itemId: 100, orderedQty: 1, uomId: 5 },
            { purchaseOrderLineId: 1, itemId: 100, orderedQty: 2, uomId: 5 },
          ],
          99,
        ),
      );

      expect((error as ContractException).errors[0]).toMatchObject({
        field: 'items.1.purchaseOrderLineId',
        code: ERROR_CODE.INVALID,
      });
    });

    it('치환 — 이미 받은 수량을 밑도는 발주 수량은 400 RANGE 다(CHECK 이 500 으로 새지 않는다)', async () => {
      const { prisma } = replaceStub({ lines: [line(1n, '50')] });

      const error = await thrown(() =>
        service(prisma).replaceLines(
          1,
          1,
          [{ purchaseOrderLineId: 1, itemId: 100, orderedQty: 10, uomId: 5 }],
          99,
        ),
      );

      expect((error as ContractException).errors[0]).toMatchObject({
        field: 'items.0.orderedQty',
        code: ERROR_CODE.RANGE,
      });
    });
  });

  describe('requestApproval', () => {
    const NUMBER_STUB = { next: async () => 'AP-20260906-0001' } as unknown as NumberingService;

    it('상신 — 없는 P/O 면 404 다(계약 미선언 · R-1)', async () => {
      const prisma = {
        purchase_order: { findUnique: async () => null },
      } as unknown as PrismaService;

      const error = await thrown(() =>
        new PurchaseOrderService(prisma, NUMBER_STUB, QUERY_STUB, APPROVAL_STUB).requestApproval(
          999,
          1,
          '사유',
          99,
        ),
      );

      expect(error).toBeInstanceOf(NotFoundException);
    });

    /** 버전을 «안» 올리므로 조건부 UPDATE 가 없다 — 잠근 행과의 «비교»가 409 를 낸다. */
    it('상신 — 잠근 행의 version_no 와 If-Match 가 어긋나면 409 다(user)', async () => {
      const tx = {
        $queryRaw: async () => [{ version_no: 2, business_unit_id: 20n }],
        purchase_order: {
          update: async () => {
            throw new Error('비교에서 막혀 여기까지 오지 않는다');
          },
        },
      };
      const prisma = {
        purchase_order: { findUnique: async () => ({ purchase_order_id: 1n }) },
        $transaction: async (run: (client: unknown) => Promise<unknown>) => run(tx),
      } as unknown as PrismaService;

      const error = await thrown(() =>
        new PurchaseOrderService(prisma, NUMBER_STUB, QUERY_STUB, APPROVAL_STUB).requestApproval(
          1,
          1,
          '사유',
          99,
        ),
      );

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).conflict.conflictCause).toBe('user');
    });
  });
});

/** 던진 예외를 집어 온다 — `update` 는 자리마다 예외 종류가 갈린다(400/404/409). */
const thrown = (run: () => Promise<unknown>): Promise<unknown> =>
  run().then(
    () => {
      throw new Error('예외가 나지 않았다');
    },
    (error: unknown) => error,
  );

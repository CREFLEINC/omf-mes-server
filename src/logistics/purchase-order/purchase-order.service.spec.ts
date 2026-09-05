import { HttpStatus, NotFoundException } from '@nestjs/common';

import { ConflictException, ContractException, ERROR_CODE } from '../../common/errors';
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
        new PurchaseOrderService(prisma, NUMBERING_STUB, QUERY_STUB).update(
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
        new PurchaseOrderService(prisma, NUMBERING_STUB, QUERY_STUB).update(
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
        new PurchaseOrderService(prisma, NUMBERING_STUB, QUERY_STUB).update(
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
});

/** 던진 예외를 집어 온다 — `update` 는 자리마다 예외 종류가 갈린다(400/404/409). */
const thrown = (run: () => Promise<unknown>): Promise<unknown> =>
  run().then(
    () => {
      throw new Error('예외가 나지 않았다');
    },
    (error: unknown) => error,
  );

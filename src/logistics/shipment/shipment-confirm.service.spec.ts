import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException } from '../../common/errors';
import { DocumentStateService } from '../../core/document-state';
import { OutboxEnqueueInput, OutboxService } from '../../core/outbox';
import { PrismaService } from '../../prisma/prisma.service';
import { ShipmentConfirmService } from './shipment-confirm.service';
import { ShipmentQueryService } from './shipment-query.service';

/** ⭐ 값을 벌린다 — 출하 id · 지시 id · 창고 id · 판 번호가 같으면 칸을 뒤바꿔도 초록이다. */
const SHIPMENT_ID = 7101;
const REQUEST_ID = 7202n;
const WAREHOUSE_ID = 7303n;
const USER_ID = 9;
const VERSION = 4;
const NO = 'SH-20260910-0042';

type Row = Record<string, unknown>;

interface Seed {
  status?: string;
  version?: number;
  openCancel?: boolean;
  alreadyQueued?: boolean;
  missing?: boolean;
}

function build(seed: Seed = {}) {
  const order: string[] = [];
  const approvalWhere: Row[] = [];
  const updates: Row[] = [];
  const enqueued: OutboxEnqueueInput[] = [];
  const tx = {
    $queryRaw: () => {
      order.push('lock');
      return Promise.resolve(
        seed.missing === true
          ? []
          : [{
              shipment_id: BigInt(SHIPMENT_ID), shipment_no: NO, shipment_request_id: REQUEST_ID,
              warehouse_id: WAREHOUSE_ID, shipped_at: new Date('2026-09-10T03:00:00.000Z'),
              status_code: seed.status ?? 'UNCONFIRMED', version_no: seed.version ?? VERSION,
            }],
      );
    },
    approval_request: {
      findFirst: ({ where }: { where: Row }) => {
        order.push('approval');
        approvalWhere.push(where);
        return Promise.resolve(seed.openCancel === true ? { approval_request_id: 1n } : null);
      },
    },
    shipment: {
      update: (args: Row) => {
        order.push('update');
        updates.push(args);
        return Promise.resolve({});
      },
    },
    shipment_line: {
      findMany: () =>
        Promise.resolve([
          {
            item_id: 801n, shipped_qty: new Prisma.Decimal(5), uom_id: 13n,
            shipment_lot_allocation: [{ lot_id: 901n, allocated_qty: new Prisma.Decimal(5) }],
          },
        ]),
    },
  };
  const prisma = { $transaction: (run: (t: unknown) => Promise<unknown>) => run(tx) } as unknown as PrismaService;
  const outbox = {
    enqueue: (_tx: unknown, input: OutboxEnqueueInput) => {
      order.push('enqueue');
      enqueued.push(input);
      return Promise.resolve({ integrationMessageId: 1n, alreadyQueued: seed.alreadyQueued === true });
    },
  } as unknown as OutboxService;
  const queries = {
    get: () => Promise.resolve({ view: { shipmentId: SHIPMENT_ID }, versionNo: VERSION + 1 }),
  } as unknown as ShipmentQueryService;
  const service = new ShipmentConfirmService(prisma, new DocumentStateService(), outbox, queries);
  return { service, order, approvalWhere, updates, enqueued };
}

async function conflictOf(run: () => Promise<unknown>): Promise<ConflictException> {
  try {
    await run();
  } catch (error) {
    return error as ConflictException;
  }
  throw new Error('던지지 않았다');
}

describe('출하 확정 — 409 순위와 아웃박스 적재', () => {
  it('⭐ 확정 — 상태·확정자·판 번호를 올리고, 적재가 그 «뒤»다', async () => {
    const { service, order, updates } = build();

    await service.confirm(SHIPMENT_ID, VERSION, USER_ID);

    expect(updates[0]).toMatchObject({
      where: { shipment_id: BigInt(SHIPMENT_ID) },
      data: { status_code: 'CONFIRMED', confirmed_by: BigInt(USER_ID), version_no: { increment: 1 } },
    });
    expect(order.indexOf('update')).toBeLessThan(order.indexOf('enqueue'));
  });

  it('⭐ 적재 키는 2세그먼트 `IF-SHIPMENT-PGI-SEND:{출하번호}` 이고 대상은 이 출하다', async () => {
    const { service, enqueued } = build();

    await service.confirm(SHIPMENT_ID, VERSION, USER_ID);

    expect(enqueued[0]).toMatchObject({
      interfaceCode: 'IF-SHIPMENT-PGI-SEND',
      messageKey: `IF-SHIPMENT-PGI-SEND:${NO}`,
      targetTypeCode: 'SHIPMENT',
      targetId: BigInt(SHIPMENT_ID),
    });
    // 평탄 페이로드 — 지시 id 와 창고 id 가 «각자» 칸에서 온다.
    expect(enqueued[0].payload).toMatchObject({
      shipmentNo: NO,
      shipmentRequestId: Number(REQUEST_ID),
      warehouseId: Number(WAREHOUSE_ID),
      lines: [{ itemId: 801, shippedQty: 5, uomId: 13, allocations: [{ lotId: 901, allocatedQty: 5 }] }],
    });
  });

  it('⭐⭐ 순위 1 — 취소된 출하는 판 번호가 틀려도 INVALID_STATE 다', async () => {
    const { service, updates } = build({ status: 'CANCELLED', version: VERSION + 9, openCancel: true });

    const failure = await conflictOf(() => service.confirm(SHIPMENT_ID, VERSION, USER_ID));

    expect(failure.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(failure.conflict.code).toBe('INVALID_STATE');
    expect(updates).toHaveLength(0);
  });

  it('⭐⭐ 순위 2 — 이미 확정된 출하는 판 번호가 틀려도 ALREADY_CONFIRMED 다', async () => {
    const { service } = build({ status: 'CONFIRMED', version: VERSION + 9, openCancel: true });

    const failure = await conflictOf(() => service.confirm(SHIPMENT_ID, VERSION, USER_ID));

    expect(failure.conflict.code).toBe('ALREADY_CONFIRMED');
  });

  it('⭐⭐ 순위 3 — 열린 취소 결재가 판 번호보다 앞이다(J-7)', async () => {
    const { service } = build({ openCancel: true, version: VERSION + 9 });

    const failure = await conflictOf(() => service.confirm(SHIPMENT_ID, VERSION, USER_ID));

    expect(failure.conflict.code).toBe('CANCEL_IN_PROGRESS');
  });

  it('⛔ 열린 결재는 «유형 접두»까지 걸어 찾는다 — 없으면 다른 축의 결재가 대신한다', async () => {
    const { service, approvalWhere } = build();

    await service.confirm(SHIPMENT_ID, VERSION, USER_ID);

    expect(approvalWhere[0]).toEqual({
      target_type_code: 'SHIPMENT',
      target_id: BigInt(SHIPMENT_ID),
      approval_type_code: 'SHIPMENT_CANCEL',
      status_code: 'PENDING',
    });
  });

  it('순위 4 — 판 번호만 틀리면 VERSION_CONFLICT + currentVersion(문자열) + conflictCause user', async () => {
    const { service, updates, enqueued } = build({ version: VERSION + 2 });

    const failure = await conflictOf(() => service.confirm(SHIPMENT_ID, VERSION, USER_ID));

    expect(failure.conflict).toMatchObject({
      code: 'VERSION_CONFLICT',
      currentVersion: String(VERSION + 2),
      conflictCause: 'user',
    });
    expect(updates).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  it('⛔ 적재가 «이미» 있으면 조용히 지나지 않고 던진다 — 상태 잠금이 뚫린 것이다', async () => {
    const { service } = build({ alreadyQueued: true });

    await expect(service.confirm(SHIPMENT_ID, VERSION, USER_ID)).rejects.toThrow(/이미 있다/);
  });

  it('없는 출하는 404 다', async () => {
    const { service } = build({ missing: true });

    await expect(service.confirm(SHIPMENT_ID, VERSION, USER_ID)).rejects.toMatchObject({ status: 404 });
  });
});

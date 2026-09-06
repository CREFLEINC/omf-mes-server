import { Logger } from '@nestjs/common';

import { CancelEligibilityService, Tx } from './cancel-eligibility.service';
import { DocumentTypeRegistryChecker, DOCUMENT_TYPES } from './document-type-registry';

const DOC_ID = 11n;

type Args = Record<string, unknown>;

interface Seed {
  /** 대상 문서 행. `undefined` 면 찾지 못한 것으로 둔다. */
  document?: { status_code: string };
  /** 열린(`PENDING`) 취소 승인 요청의 id. */
  openApproval?: bigint;
  /** 이 문서가 만든 LOT — 입하는 널이 섞인다. */
  lotIds?: (bigint | null)[];
  counts?: Record<string, number>;
}

/** 「그 트랜잭션의 표」를 흉내낸다 — 어느 delegate 를 어떤 `where` 로 불렀는지가 이 스위트의 목이다. */
function fake(seed: Seed = {}) {
  const calls: string[] = [];
  const args: Record<string, Args[]> = {};
  const rec =
    <T>(name: string, result: () => T) =>
    async (a: Args) => {
      calls.push(name);
      (args[name] ??= []).push(a);
      return result();
    };
  const counted = (name: string) => rec(`${name}.count`, () => seed.counts?.[name] ?? 0);
  const found = (name: string) => rec(`${name}.findMany`, () => []);
  const lotRows = () => (seed.lotIds ?? []).map((lot_id) => ({ lot_id }));
  const tx = {
    inbound_receipt: { findUnique: rec('inbound_receipt.findUnique', () => seed.document ?? null) },
    goods_receipt: {
      findUnique: rec('goods_receipt.findUnique', () => seed.document ?? null),
      count: counted('goods_receipt'),
      findMany: found('goods_receipt'),
    },
    goods_issue: {
      findUnique: rec('goods_issue.findUnique', () => seed.document ?? null),
      count: counted('goods_issue'),
      findMany: found('goods_issue'),
    },
    picking_order: { count: counted('picking_order'), findMany: found('picking_order') },
    inventory_transaction: {
      count: counted('inventory_transaction'),
      findMany: found('inventory_transaction'),
    },
    material_consumption: {
      count: counted('material_consumption'),
      findMany: found('material_consumption'),
    },
    inbound_receipt_line: { findMany: rec('inbound_receipt_line.findMany', lotRows) },
    goods_receipt_line: { findMany: rec('goods_receipt_line.findMany', lotRows) },
    approval_request: {
      findFirst: rec('approval_request.findFirst', () =>
        seed.openApproval === undefined ? null : { approval_request_id: seed.openApproval },
      ),
    },
  };
  const where = (name: string, at = 0) => args[name]?.[at]?.where as Args | undefined;
  return { tx: tx as unknown as Tx, calls, args, where };
}

describe('CancelEligibilityService', () => {
  const service = new CancelEligibilityService();

  it('판정 — 취소 경로가 없는 6종은 TYPE_NOT_CANCELABLE 이다(행을 읽지 않는다)', async () => {
    const { tx, calls } = fake({ document: { status_code: 'REGISTERED' } });

    const result = await service.evaluate(tx, 'PURCHASE_ORDER', DOC_ID);

    expect(result.cancellable).toBe(false);
    expect(result.cancelBlockedReasonCode).toBe('TYPE_NOT_CANCELABLE');
    // 가장 싼 판정이다 — 대상 행도 승인 요청도 조회하지 않는다(§4-4 순위 1).
    expect(calls.filter((c) => c.endsWith('.findUnique'))).toHaveLength(0);
    expect(calls).not.toContain('approval_request.findFirst');
    // 빈 문자열이 응답으로 새지 않게 키 자체를 안 채운다 — 상태는 호출자가 자기 행에서 채운다.
    expect(result.statusCode).toBeUndefined();
  });

  it('판정 — 이미 CANCELLED 면 ALREADY_CANCELLED 다', async () => {
    const { tx } = fake({ document: { status_code: 'CANCELLED' } });

    const result = await service.evaluate(tx, 'GOODS_RECEIPT', DOC_ID);

    expect(result.cancelBlockedReasonCode).toBe('ALREADY_CANCELLED');
    expect(result.statusCode).toBe('CANCELLED');
  });

  it('판정 — CANCEL_REQUESTED 면 CANCEL_IN_PROGRESS 다', async () => {
    // 결재가 반려돼 열린 요청이 없어도 막는다 — 되돌릴 경로가 없어 잠긴 문서다(문의 033).
    const { tx } = fake({ document: { status_code: 'CANCEL_REQUESTED' } });

    const result = await service.evaluate(tx, 'INBOUND_RECEIPT', DOC_ID);

    expect(result.cancelBlockedReasonCode).toBe('CANCEL_IN_PROGRESS');
    expect(result.cancelApprovalRequestId).toBeUndefined();
  });

  it('판정 — 상태가 REGISTERED 인데 열린 승인 요청이 있으면 CANCEL_IN_PROGRESS 다', async () => {
    const { tx, where } = fake({ document: { status_code: 'REGISTERED' }, openApproval: 77n });

    const result = await service.evaluate(tx, 'GOODS_ISSUE', DOC_ID);

    expect(result.cancelBlockedReasonCode).toBe('CANCEL_IN_PROGRESS');
    expect(result.cancelApprovalRequestId).toBe(77n);
    // 다형 축으로 찾는다 — 대상 표의 approval_request_id FK 를 보지 않는다(plan.md §5 #12).
    expect(where('approval_request.findFirst')).toEqual({
      target_type_code: 'GOODS_ISSUE',
      target_id: DOC_ID,
      approval_type_code: 'GOODS_ISSUE_CANCEL',
      status_code: 'PENDING',
    });
  });

  it('판정 — 취소 경로가 없는 6종도 successorCount 는 센다', async () => {
    const { tx } = fake({ counts: { goods_issue: 2 } });

    const result = await service.evaluate(tx, 'MATERIAL_ISSUE_REQUEST', DOC_ID);

    // 순위 1 조기 종료는 cancellable·사유 코드에만 걸린다 — 「후속」 열은 진행현황이다(R-6 ⓐ).
    expect(result.successorCount).toBe(2);
    expect(result.cancelBlockedReasonCode).toBe('TYPE_NOT_CANCELABLE');
  });

  it('판정 — 취소 경로가 없으면 후속이 있어도 TYPE_NOT_CANCELABLE 이 이긴다(1 > 5)', async () => {
    const { tx } = fake({ counts: { goods_receipt: 1 } });

    const result = await service.evaluate(tx, 'STOCK_TRANSFER', DOC_ID);

    expect(result.cancelBlockedReasonCode).toBe('TYPE_NOT_CANCELABLE');
    expect(result.successorCount).toBe(1);
  });

  it('판정 — CANCELLED 이면서 열린 요청이 남아도 ALREADY_CANCELLED 가 이긴다(2 > 3)', async () => {
    const { tx } = fake({ document: { status_code: 'CANCELLED' }, openApproval: 5n });

    const result = await service.evaluate(tx, 'GOODS_RECEIPT', DOC_ID);

    expect(result.cancelBlockedReasonCode).toBe('ALREADY_CANCELLED');
    // 사유가 갈려도 승인 요청 id 는 실린다 — 화면이 결재함으로 이어 갈 수 있다.
    expect(result.cancelApprovalRequestId).toBe(5n);
  });

  it('판정 — 후속이 있으면 SUCCESSOR_EXISTS 이고 후속 조회는 맨 뒤에 돈다', async () => {
    const { tx, calls } = fake({
      document: { status_code: 'POSTED' },
      counts: { picking_order: 1 },
    });

    const result = await service.evaluate(tx, 'GOODS_ISSUE', DOC_ID);

    expect(result.cancelBlockedReasonCode).toBe('SUCCESSOR_EXISTS');
    // 가장 비싼 조회라 맨 뒤다 — 앞의 두 판정이 먼저 돈다(§4-4).
    expect(calls.indexOf('goods_issue.findUnique')).toBeLessThan(calls.indexOf('picking_order.count'));
    expect(calls.indexOf('approval_request.findFirst')).toBeLessThan(
      calls.indexOf('picking_order.count'),
    );
  });

  it('후속 — 문서 하류는 goods_receipt·goods_issue·picking_order 의 source_document_* 로 센다', async () => {
    const { tx, where } = fake({
      document: { status_code: 'POSTED' },
      counts: { goods_receipt: 1, goods_issue: 2, picking_order: 3 },
    });

    const result = await service.evaluate(tx, 'INBOUND_RECEIPT', DOC_ID);

    expect(result.successorCount).toBe(6);
    for (const delegate of ['goods_receipt', 'goods_issue', 'picking_order']) {
      expect(where(`${delegate}.count`)).toMatchObject({
        source_document_type_code: 'INBOUND_RECEIPT',
        source_document_id: DOC_ID,
      });
    }
  });

  it('후속 — 자기 자신의 전기 원장은 세지 않는다', async () => {
    const { tx, where } = fake({ document: { status_code: 'POSTED' }, lotIds: [9n] });

    await service.evaluate(tx, 'GOODS_RECEIPT', DOC_ID);

    // 그 행은 이 문서 «자신»이다 — 안 빼면 전기된 문서가 전건 취소 불가다(규칙 ①).
    expect(where('inventory_transaction.count')).toMatchObject({
      NOT: { source_document_type_code: 'GOODS_RECEIPT', source_document_id: DOC_ID },
    });
  });

  it('후속 — 이미 CANCELLED 인 후속은 세지 않는다(역순 취소가 풀린다)', async () => {
    const { tx, where } = fake({ document: { status_code: 'POSTED' } });

    await service.evaluate(tx, 'INBOUND_RECEIPT', DOC_ID);

    expect(where('goods_receipt.count')).toMatchObject({ status_code: { not: 'CANCELLED' } });
    expect(where('goods_issue.count')).toMatchObject({ status_code: { not: 'CANCELLED' } });
    // 피킹지시는 상태 값 목록이 없어 'CANCELLED' 를 지어 넣지 않는다(R-6 ⓑ).
    expect(DOCUMENT_TYPES.PICKING_ORDER.cancelledStatus).toBeNull();
    expect(where('picking_order.count')).not.toHaveProperty('status_code');
  });

  it('후속 — 역처리로 상쇄된 원장 쌍은 세지 않는다', async () => {
    const { tx, where } = fake({ document: { status_code: 'POSTED' }, lotIds: [9n] });

    await service.evaluate(tx, 'GOODS_RECEIPT', DOC_ID);

    // 가리키는 행(역행)도, 가리켜진 원 행도 뺀다 — 안 빼면 취소가 자기 후속을 만든다(규칙 ③).
    expect(where('inventory_transaction.count')).toMatchObject({
      reversal_of_transaction_id: null,
      reversed_by_transactions: { none: {} },
    });
  });

  it('후속 — 입하·입고는 자기 LOT 을 쓰는 원장·자재투입을 센다(LOT 축)', async () => {
    const { tx, where } = fake({
      document: { status_code: 'POSTED' },
      lotIds: [9n, null],
      counts: { inventory_transaction: 1, material_consumption: 2 },
    });

    const result = await service.evaluate(tx, 'INBOUND_RECEIPT', DOC_ID);

    expect(result.successorCount).toBe(3);
    // 널인 라인(LOT 미발번)은 축에서 빠진다.
    expect(where('material_consumption.count')).toEqual({ lot_id: { in: [9n] } });
    expect(where('inventory_transaction.count')).toMatchObject({
      inventory_transaction_line: { some: { lot_id: { in: [9n] } } },
    });
  });

  it('후속 — 출고에는 LOT 축을 걸지 않는다(출고가 만든 LOT 이 아니다)', async () => {
    const { tx, calls } = fake({ document: { status_code: 'POSTED' } });

    const result = await service.evaluate(tx, 'GOODS_ISSUE', DOC_ID);

    // 출고 라인의 LOT 은 출고가 만든 것이 아니다 — 세면 모든 출고가 영구히 취소 불가다(§4-2).
    expect(calls).not.toContain('inventory_transaction.count');
    expect(calls).not.toContain('material_consumption.count');
    expect(result.cancellable).toBe(true);
    expect(result.cancelBlockedReasonCode).toBeUndefined();
  });

  it('등록부 — entity_type_registry 에 없는 유형이면 부팅 대조가 경고한다(던지지 않는다)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const prisma = {
      entity_type_registry: { findMany: async () => [{ table_name: 'goods_receipt' }] },
    };

    const checker = new DocumentTypeRegistryChecker(prisma as never);
    await expect(checker.onModuleInit()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('PICKING_ORDER');
    expect(warn.mock.calls[0][0]).not.toContain('GOODS_RECEIPT');
    warn.mockRestore();
  });
});

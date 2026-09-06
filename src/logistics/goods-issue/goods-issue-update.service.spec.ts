import { HttpStatus, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';

import { attachSession } from '../../auth/session-resolver.service';
import { Session } from '../../auth/session.types';
import { ContractException, ERROR_CODE } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency';
import { rememberIfMatch } from '../../common/optimistic-lock';
import { ApprovalRequestInput, ApprovalService } from '../../core/approval';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { GoodsIssueLineCreate } from './goods-issue-rules';
import { GoodsIssueQueryService } from './goods-issue-query.service';
import { GoodsIssueUpdateService } from './goods-issue-update.service';
import { GoodsIssueController } from './goods-issue.controller';
import { GoodsIssueService } from './goods-issue.service';

const ISSUE = 700;
const WAREHOUSE = 1001;
const ITEM = 2001;
const LOT = 3001;
const UOM = 5;
const LOCATION = 4001;
const REQUEST_ID = 5001n;

type Row = Record<string, unknown>;

const item = (over: Partial<GoodsIssueLineCreate> = {}): GoodsIssueLineCreate => ({
  itemId: ITEM,
  lotId: LOT,
  issueQty: 10,
  uomId: UOM,
  sourceLocationId: LOCATION,
  ...over,
});

interface Seed {
  /** 헤더가 아예 없다(404 갈래). */
  missing?: boolean;
  statusCode?: string;
  versionNo?: number;
  /** 이 전표가 이미 갖고 있는 라인 id 들. */
  existingLineIds?: number[];
  /** `assertNoOpenRequest` 가 막는다(PENDING). */
  open?: boolean;
  /** `approval.request` 가 던지는 코드(결재선 갈래). */
  routeError?: string;
}

/**
 * 한 트랜잭션을 흉내 내는 스텁 — «어느 순서로 무엇을 만졌는지»를 잡는다. 잠금 순서가
 * 이 오퍼레이션들의 불변식이라 호출 순서를 함께 기록한다.
 */
function stub(seed: Seed = {}) {
  const order: string[] = [];
  const created: Row[] = [];
  const updated: Row[] = [];
  const removed: bigint[] = [];
  const bumps: Row[] = [];
  const headerWrites: Row[] = [];
  const requests: ApprovalRequestInput[] = [];
  const existingLineIds = seed.existingLineIds ?? [];

  const reads: Row = {
    goods_issue: {
      findUnique: async () =>
        (seed.missing ?? false)
          ? null
          : { goods_issue_id: BigInt(ISSUE), source_warehouse_id: BigInt(WAREHOUSE) },
    },
    item: { findMany: async () => [{ item_id: BigInt(ITEM) }] },
    lot: { findMany: async () => [{ lot_id: BigInt(LOT), item_id: BigInt(ITEM) }] },
    uom: { findMany: async () => [{ uom_id: BigInt(UOM) }] },
    location: {
      findMany: async () => [{ location_id: BigInt(LOCATION), warehouse_id: BigInt(WAREHOUSE) }],
    },
    picking_line: { findMany: async () => [] },
  };

  const tx: Row = {
    $queryRaw: async () => {
      order.push('lock');
      return (seed.missing ?? false)
        ? []
        : [{ status_code: seed.statusCode ?? 'REGISTERED', version_no: seed.versionNo ?? 3 }];
    },
    $executeRaw: async () => void order.push('shift'),
    goods_issue: {
      updateMany: async (args: Row) => {
        order.push('bump');
        bumps.push(args);
        return { count: 1 };
      },
      update: async (args: Row) => {
        order.push('header-write');
        headerWrites.push(args);
      },
    },
    goods_issue_line: {
      findMany: async (args: Row) => {
        if ('orderBy' in args) return finalRows();
        order.push('existing');
        return existingLineIds.map((id) => ({ goods_issue_line_id: BigInt(id) }));
      },
      deleteMany: async (args: { where: { goods_issue_line_id: { in: bigint[] } } }) => {
        order.push('delete');
        removed.push(...args.where.goods_issue_line_id.in);
      },
      create: async ({ data }: { data: Row }) => {
        order.push('create');
        created.push(data);
      },
      update: async (args: { where: Row; data: Row }) => {
        order.push('update');
        updated.push({ ...args.where, ...args.data });
      },
    },
  };

  /** 치환이 끝난 뒤의 라인 — 만든 것과 고친 것을 `line_no` 순으로 되돌려 준다. */
  function finalRows(): Row[] {
    return [...created, ...updated]
      .sort((left, right) => Number(left.line_no) - Number(right.line_no))
      .map((row, index) => ({
        goods_issue_line_id: BigInt((row.goods_issue_line_id as number | undefined) ?? 900 + index),
        goods_issue_id: BigInt(ISSUE),
        line_no: row.line_no as number,
        picking_line_id: null,
        item_id: BigInt(row.item_id as number),
        lot_id: BigInt(row.lot_id as number),
        issue_qty: new Prisma.Decimal(row.issue_qty as number),
        uom_id: BigInt(row.uom_id as number),
        source_location_id: BigInt(row.source_location_id as number),
        inventory_transaction_line_id: null,
      }));
  }

  const prisma = new Proxy(reads, {
    get: (target: Row, prop: string) =>
      prop === '$transaction'
        ? (work: (client: unknown) => Promise<unknown>) => work(tx)
        : target[prop],
  }) as unknown as PrismaService;

  const approvals = {
    assertNoOpenRequest: async () => {
      order.push('no-open');
      if (seed.open ?? false) {
        throw new ContractException(HttpStatus.BAD_REQUEST, [
          { scope: 'screen', code: ERROR_CODE.APPROVAL_IN_PROGRESS, message: '진행 중입니다.' },
        ]);
      }
    },
    request: async (_tx: unknown, input: ApprovalRequestInput) => {
      order.push('request');
      requests.push(input);
      if (seed.routeError !== undefined) {
        throw new ContractException(HttpStatus.BAD_REQUEST, [
          { scope: 'screen', code: seed.routeError, message: '결재선 문제입니다.' },
        ]);
      }
      return { approvalRequestId: REQUEST_ID };
    },
  } as unknown as ApprovalService;

  const service = new GoodsIssueUpdateService(prisma, approvals, {
    next: async () => 'AP-20260504-0001',
  } as unknown as NumberingService);

  return { service, order, created, updated, removed, bumps, headerWrites, requests };
}

/** 던진 `ContractException` 을 집어 온다 — 코드와 필드를 함께 봐야 하기 때문이다. */
const thrown = (run: () => Promise<unknown>): Promise<ContractException> =>
  run().then(
    () => {
      throw new Error('예외가 나지 않았다');
    },
    (error: ContractException) => error,
  );

const codes = (error: ContractException): string[] =>
  (error.getResponse() as { errors: { code: string }[] }).errors.map((row) => row.code);

describe('출고 라인 치환', () => {
  it('치환 — items 가 0건이면 400 LINE_REQUIRED 다', async () => {
    const { service, order } = stub();

    const error = await thrown(() => service.replaceLines(ISSUE, 3, [], 1));

    expect(codes(error)).toEqual([ERROR_CODE.LINE_REQUIRED]);
    // 트랜잭션을 열기도 전에 막는다.
    expect(order).toEqual([]);
  });

  it('치환 — 같은 goodsIssueLineId 가 두 번 오면 400 다(조용히 한 행에 두 번 쓰지 않는다)', async () => {
    const { service, order } = stub({ existingLineIds: [901] });

    const error = await thrown(() =>
      service.replaceLines(ISSUE, 3, [item({ goodsIssueLineId: 901 }), item({ goodsIssueLineId: 901 })], 1),
    );

    expect(codes(error)).toEqual([ERROR_CODE.INVALID]);
    expect(order).toEqual([]);
  });

  it('치환 — 없는 출고면 404', async () => {
    const { service } = stub({ missing: true });

    await expect(service.replaceLines(ISSUE, 3, [item()], 1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('치환 — POSTED 전표면 400 STATE_LOCKED 다', async () => {
    const { service, order } = stub({ statusCode: 'POSTED' });

    const error = await thrown(() => service.replaceLines(ISSUE, 3, [item()], 1));

    expect(codes(error)).toEqual([ERROR_CODE.STATE_LOCKED]);
    // 잠근 «뒤»에 상태를 본다 — 라인은 하나도 안 만졌다.
    expect(order).toEqual(['lock']);
  });

  it('치환 — 승인 대기(PENDING) 중이면 400 APPROVAL_IN_PROGRESS 다(§4-4)', async () => {
    const { service, order } = stub({ open: true });

    const error = await thrown(() => service.replaceLines(ISSUE, 3, [item()], 1));

    expect(codes(error)).toEqual([ERROR_CODE.APPROVAL_IN_PROGRESS]);
    expect(order).toEqual(['lock', 'no-open']);
  });

  it('치환 — 남의 전표 라인 id 를 주면 400 INVALID 다', async () => {
    const { service, removed } = stub({ existingLineIds: [901] });

    const error = await thrown(() =>
      service.replaceLines(ISSUE, 3, [item({ goodsIssueLineId: 555 })], 1),
    );

    expect(codes(error)).toEqual([ERROR_CODE.INVALID]);
    // 남의 라인을 이 전표로 끌어오지도, 기존 행을 지우지도 않았다.
    expect(removed).toEqual([]);
  });

  it('치환 — 요청에서 빠진 기존 행은 지운다 · id 없는 항목은 새로 만든다', async () => {
    const { service, removed, created, updated } = stub({ existingLineIds: [901, 902] });

    const result = await service.replaceLines(
      ISSUE,
      3,
      [item({ goodsIssueLineId: 902, issueQty: 7 }), item({ issueQty: 5 })],
      1,
    );

    // 901 은 요청에서 빠졌다.
    expect(removed).toEqual([901n]);
    expect(updated).toEqual([
      expect.objectContaining({ goods_issue_line_id: 902, line_no: 1, issue_qty: 7 }),
    ]);
    expect(created).toEqual([expect.objectContaining({ line_no: 2, issue_qty: 5, created_by: 1n })]);
    expect(result.items.map((line) => line.lineNo)).toEqual([1, 2]);
  });

  it('치환 — 부모 goods_issue 를 먼저 잠근 뒤 라인을 만진다', async () => {
    const { service, order, bumps } = stub({ existingLineIds: [901] });

    const result = await service.replaceLines(ISSUE, 3, [item({ goodsIssueLineId: 901 })], 1);

    expect(order).toEqual(['lock', 'no-open', 'existing', 'shift', 'update', 'bump']);
    // 라인이 바뀌면 부모 상세의 내용이 바뀐다 — 버전을 올린다(§6-3).
    expect(bumps[0]).toEqual({
      where: { goods_issue_id: ISSUE, version_no: 3 },
      data: { version_no: { increment: 1 }, updated_by: 1n },
    });
    expect(result.versionNo).toBe(4);
  });

  it('치환 — line_no 를 맞바꿔도 uq_goods_issue_line 을 안 깬다', async () => {
    const { service, order, updated } = stub({ existingLineIds: [901, 902] });

    await service.replaceLines(
      ISSUE,
      3,
      [item({ goodsIssueLineId: 902 }), item({ goodsIssueLineId: 901 })],
      1,
    );

    // 밀어 두는 한 문장이 «갱신보다 먼저» 돈다 — 제약이 `condeferrable=f` 라 문장마다 본다.
    expect(order.indexOf('shift')).toBeLessThan(order.indexOf('update'));
    expect(updated.map((row) => [row.goods_issue_line_id, row.line_no])).toEqual([
      [902, 1],
      [901, 2],
    ]);
  });

  it('치환 — 응답에 ETag 를 안 내린다(계약 미선언)', async () => {
    const controller = new GoodsIssueController(
      {} as GoodsIssueQueryService,
      {} as GoodsIssueService,
      { replaceLines: async () => ({ items: [], versionNo: 4 }) } as unknown as GoodsIssueUpdateService,
      { run: async (_options: unknown, work: () => Promise<unknown>) => ({ body: await work() }) } as unknown as IdempotencyService,
    );
    const request = { method: 'PUT', path: '/x', headers: {}, body: {} } as unknown as Request;
    attachSession(request, { userId: 1 } as Session);
    rememberIfMatch(request, 4);

    // 핸들러가 `Response` 를 받지 않는다 — `setEtag` 를 부를 자리 자체가 없다. 본문도
    // `{items}` 하나뿐이라 새 버전이 새어 나가지 않는다(계약 `GoodsIssueLineListResponse`).
    const body = await controller.replaceLines(request, ISSUE, { items: [] });
    expect(Object.keys(body)).toEqual(['items']);
  });
});

describe('기타 출고 품의 상신', () => {
  it('상신 — 없는 출고면 404', async () => {
    const { service } = stub({ missing: true });

    await expect(service.requestApproval(ISSUE, 3, '폐기합니다', 1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('상신 — POSTED 전표면 400 STATE_LOCKED 다(§8 ⓖ)', async () => {
    const { service, requests } = stub({ statusCode: 'POSTED' });

    const error = await thrown(() => service.requestApproval(ISSUE, 3, '폐기합니다', 1));

    expect(codes(error)).toEqual([ERROR_CODE.STATE_LOCKED]);
    expect(requests).toEqual([]);
  });

  it('상신 — approvalTypeCode 는 언제나 GOODS_ISSUE_DISPOSAL 이다(본문이 안 받는다)', async () => {
    const { service, requests } = stub();

    await service.requestApproval(ISSUE, 3, '폐기합니다', 1);

    // 자재 폐기(W-01-06)와 제품 폐기(W-04-10)를 «유형»으로 가르지 않는다(계약).
    expect(requests[0]).toMatchObject({
      approvalTypeCode: 'GOODS_ISSUE_DISPOSAL',
      targetTypeCode: 'GOODS_ISSUE',
      targetId: BigInt(ISSUE),
      requestedBy: 1n,
      reason: '폐기합니다',
    });
  });

  it('상신 — selectRoute 의 businessUnitId 는 null 이다(문의 022 · 8자리 공통본)', async () => {
    const { service, requests } = stub();

    await service.requestApproval(ISSUE, 3, '폐기합니다', 1);

    // `reasonCode` → 결재선 매핑이 계약 미정이라 사업부 축이 안 선다 — 공통본만 고른다.
    expect(requests[0].businessUnitId).toBeNull();
  });

  it('상신 — 활성 결재선이 둘이면 400 ROUTE_AMBIGUOUS 다', async () => {
    const { service, headerWrites } = stub({ routeError: ERROR_CODE.ROUTE_AMBIGUOUS });

    const error = await thrown(() => service.requestApproval(ISSUE, 3, '폐기합니다', 1));

    expect(codes(error)).toEqual([ERROR_CODE.ROUTE_AMBIGUOUS]);
    // 요청이 안 섰으니 전표에 되짚기도 안 남는다.
    expect(headerWrites).toEqual([]);
  });

  it('상신 — version_no 를 안 올린다(202 에 ETag 가 없다)', async () => {
    const { service, bumps, headerWrites } = stub();

    await service.requestApproval(ISSUE, 3, '폐기합니다', 1);

    // 올리면 다음 쓰기가 상세 GET 을 다시 돌 때까지 영원히 409 다(§6-3).
    expect(bumps).toEqual([]);
    expect(Object.keys(headerWrites[0].data as Row)).toEqual(['approval_request_id']);
  });

  it('상신 — approval_request_id 를 채우되 판정에는 안 쓴다', async () => {
    const { service, headerWrites, order } = stub();

    const result = await service.requestApproval(ISSUE, 3, '폐기합니다', 1);

    expect(result).toEqual({ approvalRequestId: Number(REQUEST_ID) });
    expect(headerWrites[0]).toEqual({
      where: { goods_issue_id: ISSUE },
      data: { approval_request_id: REQUEST_ID },
    });
    // ⛔ 이 FK 를 «읽는» 자리가 없다 — 승인 판정은 `assertApproved` 의 다형 축이다
    //    (plan.md §5 #12 · I-5 의 취소 품의가 이 칸을 덮는다).
    expect(order).toEqual(['lock', 'request', 'header-write']);
  });
});

import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import {
  Editability,
  Referrer,
  assertNotBlank,
  countReferences,
  optionalDate,
  toDateString,
} from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { PrismaService } from '../../prisma/prisma.service';
import { ROUTING_STATUS } from './routing-status';

/**
 * `planning.routing` 을 FK 로 가리키는 자리 전부. 실측(`pg_constraint`)이고 e2e 가 대조한다.
 *
 * ⚠ 자기 공정 라인(`routing_operation`)도 센다. 창고가 자기 로케이션을 세는 것과 같은
 * 규칙이다 — 잠금이 묻는 것은 「이 Rev 를 가리키는 곳이 있는가」이지 「남이 가리키는가」가
 * 아니다. 그래서 라인을 한 줄이라도 저장한 Rev 는 코드가 잠긴다. 코드는 Rev 를 여는
 * 순간(라인 없음) 고치는 값이다.
 */
export const ROUTING_REFERRERS: readonly Referrer[] = [
  ['planning.production_plan', 'routing_id'],
  ['planning.routing_operation', 'routing_id'],
  ['quality.inspection_plan', 'routing_id'],
];

/** 계약 `Routing` 과 동형. 필드는 `x-source-column` 을 그대로 따른다. */
interface RoutingView {
  routingId: number;
  itemId: number;
  routingCode: string;
  routingVersion: number;
  statusCode: string;
  /** ⛔ 없으면 «필드를 안 싣는다» — 계약 타입이 nullable 이 아니다(단말 `locationId` 와 같다). */
  effectiveFrom?: string;
  effectiveTo: string | null;
  isDefault: boolean;
}

export interface RoutingCreate {
  itemId: number;
  routingCode: string;
  effectiveFrom?: string;
  effectiveTo?: string | null;
}

export interface RoutingUpdate {
  routingCode: string;
  effectiveFrom?: string;
  effectiveTo?: string | null;
}

export interface RoutingQuery {
  itemId: number;
  usableOnly?: boolean;
}

type RoutingRow = Prisma.routingGetPayload<object>;

export interface RoutingResult {
  routing: RoutingView;
  editability: Editability;
  versionNo: number;
}

@Injectable()
export class RoutingService {
  constructor(private readonly prisma: PrismaService) {}

  /** 「Rev 목록은 품목당 소수라 페이지네이션을 두지 않는다」(계약). 최신이 위다. */
  async list(query: RoutingQuery): Promise<RoutingView[]> {
    const rows = await this.prisma.routing.findMany({
      where: { item_id: query.itemId, ...(query.usableOnly ? usableWhere() : {}) },
      orderBy: { routing_version: 'desc' },
    });
    return rows.map(view);
  }

  async get(routingId: number): Promise<RoutingResult> {
    const row = await this.prisma.routing.findUnique({ where: { routing_id: routingId } });
    if (!row) throw new NotFoundException('없는 Routing 입니다.');

    const referenceCount = await countReferences(this.prisma, ROUTING_REFERRERS, row.routing_id);
    return {
      routing: view(row),
      editability: {
        codeEditable: referenceCount === 0,
        reason: referenceCount === 0 ? 'EDITABLE' : 'REFERENCED',
        referenceCount,
      },
      versionNo: row.version_no,
    };
  }

  /**
   * 「품목에 아직 Routing 이 하나도 없을 때만 쓴다 — routingVersion 을 항상 1로,
   * statusCode 를 항상 작성중으로 채운다」(계약). 두 번째 이후 Rev 는 `:new-revision` 이다.
   */
  async create(input: RoutingCreate): Promise<RoutingView> {
    assertNotBlank([['routingCode', input.routingCode]]);
    assertDates(input.effectiveFrom, input.effectiveTo);
    await this.assertItem(input.itemId);

    const existing = await this.prisma.routing.findFirst({
      where: { item_id: input.itemId },
      select: { routing_id: true },
    });
    if (existing) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'field',
          field: 'itemId',
          code: ERROR_CODE.UNIQUE_VIOLATION,
          uniqueScope: ['itemId'],
          message: '이 품목에는 이미 Routing 이 있습니다. 신규 Rev 는 최신 확정 Rev 에서 발행합니다.',
        },
      ]);
    }

    return view(
      await this.prisma.routing.create({
        data: {
          item_id: input.itemId,
          routing_code: input.routingCode,
          routing_version: 1,
          status_code: ROUTING_STATUS.DRAFT,
          ...optionalDate('effective_from', input.effectiveFrom),
          ...optionalDate('effective_to', input.effectiveTo),
        },
      }),
    );
  }

  /** 「상태=작성중일 때만 허용한다 — 확정 Rev 는 in-place 수정을 금지한다」(결정 07). */
  async update(routingId: number, version: number, input: RoutingUpdate): Promise<RoutingResult> {
    assertNotBlank([['routingCode', input.routingCode]]);
    assertDates(input.effectiveFrom, input.effectiveTo);
    await this.assertDraft(routingId, '수정');

    const updated = await this.prisma.routing.updateMany({
      // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
      where: { routing_id: routingId, version_no: version },
      data: {
        routing_code: input.routingCode,
        ...optionalDate('effective_from', input.effectiveFrom),
        ...optionalDate('effective_to', input.effectiveTo),
        version_no: { increment: 1 },
      },
    });
    await this.assertExists(routingId, updated.count);
    return this.get(routingId);
  }

  /**
   * 「유효 기간이 겹치는 Rev 가 둘일 때 이 값으로 어느 것을 쓸지 정한다」(계약).
   *
   * ⛔ 한 트랜잭션에서 같은 품목의 기존 기본을 내리고 이것을 올린다. 순서를 뒤집으면
   * `uq_routing_default(item_id) WHERE is_default` 가 중간 상태에서 깨진다.
   */
  async setDefault(routingId: number): Promise<RoutingResult> {
    const row = await this.prisma.routing.findUnique({
      where: { routing_id: routingId },
      select: { item_id: true },
    });
    if (!row) throw new NotFoundException('없는 Routing 입니다.');

    await this.prisma.$transaction(async (tx) => {
      await tx.routing.updateMany({
        where: { item_id: row.item_id, is_default: true, routing_id: { not: routingId } },
        data: { is_default: false, version_no: { increment: 1 } },
      });
      await tx.routing.update({
        where: { routing_id: routingId },
        data: { is_default: true, version_no: { increment: 1 } },
      });
    });

    return this.get(routingId);
  }

  private async assertItem(itemId: number): Promise<void> {
    const item = await this.prisma.item.findUnique({
      where: { item_id: itemId },
      select: { item_id: true },
    });
    if (item) return;
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      { scope: 'field', field: 'itemId', code: ERROR_CODE.INVALID, message: '없는 품목입니다.' },
    ]);
  }

  /**
   * ⛔ 「상태≠작성중이면 400(`STATE_LOCKED`)」 — 409 가 아니다. 재로드해도 풀리지 않는
   * 잠금이라 저장 충돌과 갈라야 한다(공유계약 `G-1`).
   */
  private async assertDraft(routingId: number, action: string): Promise<void> {
    const row = await this.prisma.routing.findUnique({
      where: { routing_id: routingId },
      select: { status_code: true },
    });
    if (!row) throw new NotFoundException('없는 Routing 입니다.');
    if (row.status_code === ROUTING_STATUS.DRAFT) return;

    throw new ContractException(HttpStatus.BAD_REQUEST, [
      {
        scope: 'screen',
        code: ERROR_CODE.STATE_LOCKED,
        message: `확정되었거나 폐기된 Rev 는 ${action}할 수 없습니다. 신규 Rev 를 발행하세요.`,
      },
    ]);
  }

  /** 0행이 「없다」인지 「낡았다」인지 가른다 — 화면이 받는 상태 코드가 갈린다. */
  private async assertExists(routingId: number, count: number): Promise<void> {
    if (count > 0) return;
    const exists = await this.prisma.routing.findUnique({
      where: { routing_id: routingId },
      select: { routing_id: true },
    });
    if (!exists) throw new NotFoundException('없는 Routing 입니다.');
    assertUpdated(0);
  }
}

/**
 * 「지금 새 작업지시에 걸 수 있는 개정만 낸다. **판정은 서버가 한다**」(계약).
 * 확정 상태이고 유효 기간 안이다. 비어 있는 끝은 제한이 없다는 뜻이다.
 *
 * ⚠ 「지금」의 날짜를 UTC 로 읽는다. 계약이 이 자리에 날짜 파라미터를 두지 않았고,
 * Routing 은 공장에 매이지 않아 `plant.timezone_code` 로 풀 자리도 없다. 하노이
 * 로컬 00:00~07:00 에는 UTC 날짜가 하루 이르므로, 그 시간대에 「오늘부터」인 Rev 가
 * 아직 안 걸린다. 되돌림 §S 에 적었다.
 */
function usableWhere(): Prisma.routingWhereInput {
  const today = new Date(new Date().toISOString().slice(0, 10));
  return {
    status_code: ROUTING_STATUS.CONFIRMED,
    AND: [
      { OR: [{ effective_from: null }, { effective_from: { lte: today } }] },
      { OR: [{ effective_to: null }, { effective_to: { gte: today } }] },
    ],
  };
}

/** `ck_routing_dates` — 둘 다 있을 때만 본다. 「시작 없이 종료만」은 «~까지»라 뜻이 있다. */
function assertDates(from: string | undefined, to: string | null | undefined): void {
  if (from === undefined || to === undefined || to === null) return;
  if (to >= from) return;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    {
      scope: 'field',
      field: 'effectiveTo',
      code: ERROR_CODE.PAIR,
      message: '유효 종료일은 시작일보다 앞설 수 없습니다.',
    },
  ]);
}

function view(row: RoutingRow): RoutingView {
  return {
    routingId: Number(row.routing_id),
    itemId: Number(row.item_id),
    routingCode: row.routing_code,
    routingVersion: row.routing_version,
    statusCode: row.status_code,
    ...(row.effective_from === null ? {} : { effectiveFrom: toDateString(row.effective_from) ?? '' }),
    effectiveTo: toDateString(row.effective_to),
    isDefault: row.is_default,
  };
}

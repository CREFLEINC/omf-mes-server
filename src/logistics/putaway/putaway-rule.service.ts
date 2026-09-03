import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { Editability, Referrer, countReferences, filter, optional } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';

/** `logistics.putaway_rule` 을 FK 로 가리키는 자리 전부. e2e 가 대조한다. */
export const PUTAWAY_RULE_REFERRERS: readonly Referrer[] = [
  // ⚠ 컬럼 이름이 `applied_putaway_rule_id` 다 — 「적용된」 규칙이라는 뜻이라 이름이 길다.
  ['logistics.putaway_task', 'applied_putaway_rule_id'],
];

/** 계약 `PutawayRule` 과 동형. */
interface PutawayRuleView {
  putawayRuleId: number;
  itemId: number;
  warehouseId: number;
  locationId: number | null;
  capacityQty: number;
  uomId: number;
  priorityNo: number;
  remarks: string | null;
  isActive: boolean;
}

export interface PutawayRuleCreate {
  itemId: number;
  warehouseId: number;
  locationId?: number | null;
  capacityQty: number;
  uomId: number;
  priorityNo?: number;
  remarks?: string | null;
}

export interface PutawayRuleUpdate {
  locationId?: number | null;
  capacityQty: number;
  uomId: number;
  priorityNo?: number;
  remarks?: string | null;
}

export interface PutawayRuleQuery {
  warehouseId?: number;
  itemId?: number;
  locationId?: number;
  includeInactive?: boolean;
  page?: number;
  size?: number;
}

/** 계약 `UncoveredItem` 과 동형. */
interface UncoveredItemView {
  itemId: number;
  itemCode: string;
  itemName: string;
  lastReceivedAt: string | null;
}

type RuleRow = Prisma.putaway_ruleGetPayload<object>;

export interface PutawayRuleResult {
  putawayRule: PutawayRuleView;
  editability: Editability;
  versionNo: number;
}

/** 적치 규칙. 화면은 `W-06-14`(적치 규칙 마스터)가 소유한다. */
@Injectable()
export class PutawayRuleService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: PutawayRuleQuery): Promise<PagedResponse<PutawayRuleView>> {
    const page = pageRequest(query);
    const where: Prisma.putaway_ruleWhereInput = {
      ...(query.includeInactive ? {} : { is_active: true }),
      ...filter('warehouse_id', query.warehouseId),
      ...filter('item_id', query.itemId),
      ...filter('location_id', query.locationId),
    };
    const [rows, total] = await Promise.all([
      this.prisma.putaway_rule.findMany({
        where,
        // 「작을수록 먼저 권장한다」(계약) — 화면이 그 순서로 읽는다.
        orderBy: [{ priority_no: 'asc' }, { putaway_rule_id: 'asc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.putaway_rule.count({ where }),
    ]);
    return pagedResponse(rows.map(view), total, page);
  }

  async get(putawayRuleId: number): Promise<PutawayRuleResult> {
    const row = await this.load(putawayRuleId);
    const referenceCount = await countReferences(
      this.prisma,
      PUTAWAY_RULE_REFERRERS,
      row.putaway_rule_id,
    );
    return {
      putawayRule: view(row),
      editability: {
        codeEditable: referenceCount === 0,
        reason: referenceCount === 0 ? 'EDITABLE' : 'REFERENCED',
        referenceCount,
      },
      versionNo: row.version_no,
    };
  }

  /**
   * 「같은 품목·창고·위치 조합이 이미 있으면 400 이다」(계약).
   *
   * ⛔ 중지된 규칙도 센다. `uq_putaway_rule(item_id, warehouse_id, COALESCE(location_id,0))`
   * 이 **부분 인덱스가 아니라서** 활성 여부를 가리지 않는다 — 미리 안 보면 그 인덱스가
   * 500 을 낸다. 물리 삭제가 없으므로 같은 조합을 다시 쓰려면 «되살리는» 것이 맞다.
   */
  async create(input: PutawayRuleCreate): Promise<PutawayRuleView> {
    await this.assertTargets(input.itemId, input.warehouseId, input.locationId, input.uomId);
    await this.assertCombinationFree(input.itemId, input.warehouseId, input.locationId, null);

    return view(
      await this.prisma.putaway_rule.create({
        data: {
          item_id: input.itemId,
          warehouse_id: input.warehouseId,
          capacity_qty: input.capacityQty,
          uom_id: input.uomId,
          ...optional('location_id', input.locationId),
          ...optional('priority_no', input.priorityNo),
          ...optional('remarks', input.remarks),
        },
      }),
    );
  }

  /** ⛔ 품목·창고는 이 요청에 없다 — 조합이 바뀌면 다른 규칙이다(계약 `PutawayRuleUpdate`). */
  async update(
    putawayRuleId: number,
    version: number,
    input: PutawayRuleUpdate,
  ): Promise<PutawayRuleResult> {
    const current = await this.load(putawayRuleId);
    await this.assertTargets(
      Number(current.item_id),
      Number(current.warehouse_id),
      input.locationId,
      input.uomId,
    );
    // ⛔ 위치를 바꾸면 조합이 바뀐다 — 다른 규칙의 자리로 옮겨 가면 유일 인덱스가 깨진다.
    await this.assertCombinationFree(
      Number(current.item_id),
      Number(current.warehouse_id),
      input.locationId,
      putawayRuleId,
    );

    const updated = await this.prisma.putaway_rule.updateMany({
      // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
      where: { putaway_rule_id: putawayRuleId, version_no: version },
      data: {
        capacity_qty: input.capacityQty,
        uom_id: input.uomId,
        ...optional('location_id', input.locationId),
        ...optional('priority_no', input.priorityNo),
        ...optional('remarks', input.remarks),
        version_no: { increment: 1 },
      },
    });
    await this.assertExists(putawayRuleId, updated.count);
    return this.get(putawayRuleId);
  }

  /**
   * 「같은 (품목, 창고, 위치, 우선순위)로 이미 활성인 규칙이 있으면 400 이다 — 같은 조합에
   * 활성 규칙이 둘이면 **어느 것을 적용할지 정해지지 않으므로** 계약이 막는다」(`B-12`).
   *
   * ⚠ **지금은 걸릴 수 없다.** `uq_putaway_rule` 이 부분 인덱스가 아니라 같은 (품목, 창고,
   * 위치)의 행이 **애초에 둘일 수 없기** 때문이다 — 우선순위까지 볼 것도 없다. 계약이
   * 요구한 검사라 그대로 두되, 인덱스가 부분(`WHERE is_active`)으로 바뀌면 그때 살아난다.
   * 되돌림 §W.
   */
  async setActive(
    putawayRuleId: number,
    version: number,
    isActive: boolean,
  ): Promise<PutawayRuleResult> {
    const current = await this.load(putawayRuleId);
    if (isActive) {
      const clash = await this.prisma.putaway_rule.findFirst({
        where: {
          putaway_rule_id: { not: putawayRuleId },
          is_active: true,
          item_id: current.item_id,
          warehouse_id: current.warehouse_id,
          location_id: current.location_id,
          priority_no: current.priority_no,
        },
        select: { putaway_rule_id: true },
      });
      if (clash) {
        throw new ContractException(HttpStatus.BAD_REQUEST, [
          {
            scope: 'screen',
            code: ERROR_CODE.UNIQUE_VIOLATION,
            uniqueScope: ['itemId', 'warehouseId', 'locationId', 'priorityNo'],
            message: '같은 조합·우선순위로 이미 활성인 규칙이 있습니다.',
          },
        ]);
      }
    }

    const updated = await this.prisma.putaway_rule.updateMany({
      where: { putaway_rule_id: putawayRuleId, version_no: version },
      data: { is_active: isActive, version_no: { increment: 1 } },
    });
    await this.assertExists(putawayRuleId, updated.count);
    return this.get(putawayRuleId);
  }

  /**
   * 「그 창고에 **입고 이력이 있는데** 활성 규칙이 없는 품목」(계약).
   *
   * ⛔ 「등록된 것만 보이면 **비어 있다는 사실이 어디에도 드러나지 않는다**」 — 규칙이
   * 없으면 현장이 위치 검증 없이 통과한다(`M-01-05` §5-2-1 둘째 갈래 · 공유계약 `G-12`).
   *
   * 입고 이력은 `logistics.goods_receipt`(창고·시각) × `goods_receipt_line`(품목)에서 읽는다.
   * 「오래된 것부터 채울지 판단하는 근거」라 마지막 입고가 이른 것이 위다.
   */
  async uncoveredItems(
    warehouseId: number,
    query: { page?: number; size?: number },
  ): Promise<PagedResponse<UncoveredItemView>> {
    const page = pageRequest(query);
    const [rows, total] = await Promise.all([
      this.prisma.$queryRaw<
        { item_id: bigint; item_code: string; item_name: string; last_received_at: Date | null }[]
      >`
        ${uncoveredSelect(warehouseId)}
        ORDER BY last_received_at ASC NULLS FIRST, i.item_code ASC
        LIMIT ${page.take} OFFSET ${page.skip}`,
      this.prisma.$queryRaw<{ total: bigint }[]>`
        SELECT count(*)::bigint AS total FROM (${uncoveredSelect(warehouseId)}) counted`,
    ]);

    return pagedResponse(
      rows.map((row) => ({
        itemId: Number(row.item_id),
        itemCode: row.item_code,
        itemName: row.item_name,
        lastReceivedAt: row.last_received_at === null ? null : row.last_received_at.toISOString(),
      })),
      Number(total[0]?.total ?? 0),
      page,
    );
  }

  /** `uq_putaway_rule` 을 요청 안에서 먼저 본다 — 부딪히게 두면 500 이 나간다. */
  private async assertCombinationFree(
    itemId: number,
    warehouseId: number,
    locationId: number | null | undefined,
    self: number | null,
  ): Promise<void> {
    const taken = await this.prisma.putaway_rule.findFirst({
      where: {
        item_id: itemId,
        warehouse_id: warehouseId,
        location_id: locationId ?? null,
        ...(self === null ? {} : { putaway_rule_id: { not: self } }),
      },
      select: { putaway_rule_id: true },
    });
    if (!taken) return;
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      {
        scope: 'screen',
        code: ERROR_CODE.UNIQUE_VIOLATION,
        uniqueScope: ['itemId', 'warehouseId', 'locationId'],
        message: '같은 품목·창고·위치의 규칙이 이미 있습니다. 중지된 규칙이면 다시 사용하세요.',
      },
    ]);
  }

  private async assertTargets(
    itemId: number,
    warehouseId: number,
    locationId: number | null | undefined,
    uomId: number,
  ): Promise<void> {
    const errors: ErrorItem[] = [];
    const [item, warehouse, uom] = await Promise.all([
      this.prisma.item.findUnique({ where: { item_id: itemId }, select: { item_id: true } }),
      this.prisma.warehouse.findUnique({
        where: { warehouse_id: warehouseId },
        select: { warehouse_id: true },
      }),
      this.prisma.uom.findUnique({ where: { uom_id: uomId }, select: { uom_id: true } }),
    ]);
    if (!item) errors.push(invalid('itemId', '없는 품목입니다.'));
    if (!warehouse) errors.push(invalid('warehouseId', '없는 창고입니다.'));
    if (!uom) errors.push(invalid('uomId', '없는 단위입니다.'));

    if (locationId != null) {
      // ⛔ 위치는 «그 창고의» 것이어야 한다 — 남의 창고 위치를 권장하면 현장이 갈 곳이 없다.
      const location = await this.prisma.location.findFirst({
        where: { location_id: locationId, warehouse_id: warehouseId },
        select: { location_id: true },
      });
      if (!location) errors.push(invalid('locationId', '이 창고의 위치가 아닙니다.'));
    }

    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  }

  private async load(putawayRuleId: number): Promise<RuleRow> {
    const row = await this.prisma.putaway_rule.findUnique({
      where: { putaway_rule_id: putawayRuleId },
    });
    if (!row) throw new NotFoundException('없는 적치 규칙입니다.');
    return row;
  }

  /** 0행이 「없다」인지 「낡았다」인지 가른다 — 화면이 받는 상태 코드가 갈린다. */
  private async assertExists(putawayRuleId: number, count: number): Promise<void> {
    if (count > 0) return;
    const exists = await this.prisma.putaway_rule.findUnique({
      where: { putaway_rule_id: putawayRuleId },
      select: { putaway_rule_id: true },
    });
    if (!exists) throw new NotFoundException('없는 적치 규칙입니다.');
    assertUpdated(0);
  }
}

/**
 * 「입고 이력은 있는데 활성 규칙이 없는 품목」을 고르는 질의.
 *
 * Prisma 의 `groupBy` 로는 「다른 표에 없음(NOT EXISTS)」을 걸 수 없어 SQL 로 쓴다.
 * 창고 번호는 바인딩 파라미터로만 들어간다 — 문자열을 잇지 않는다.
 */
function uncoveredSelect(warehouseId: number): Prisma.Sql {
  return Prisma.sql`
    SELECT i.item_id, i.item_code, i.item_name, max(gr.receipt_datetime) AS last_received_at
      FROM logistics.goods_receipt_line grl
      JOIN logistics.goods_receipt gr ON gr.goods_receipt_id = grl.goods_receipt_id
      JOIN mdm.item i ON i.item_id = grl.item_id
     WHERE gr.warehouse_id = ${warehouseId}
       AND NOT EXISTS (
             SELECT 1 FROM logistics.putaway_rule pr
              WHERE pr.item_id = grl.item_id
                AND pr.warehouse_id = ${warehouseId}
                AND pr.is_active)
     GROUP BY i.item_id, i.item_code, i.item_name`;
}

function invalid(field: string, message: string): ErrorItem {
  return { scope: 'field', field, code: ERROR_CODE.INVALID, message };
}

function view(row: RuleRow): PutawayRuleView {
  return {
    putawayRuleId: Number(row.putaway_rule_id),
    itemId: Number(row.item_id),
    warehouseId: Number(row.warehouse_id),
    locationId: row.location_id === null ? null : Number(row.location_id),
    capacityQty: Number(row.capacity_qty),
    uomId: Number(row.uom_id),
    priorityNo: row.priority_no,
    remarks: row.remarks,
    isActive: row.is_active,
  };
}


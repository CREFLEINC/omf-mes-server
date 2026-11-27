import { Prisma } from '@prisma/client';

import { InventoryPostingService } from '../../core/inventory-posting';
import { GOODS_ISSUE_SPLIT_SOURCE, lockLotSplitFamilies, splitLotWithin } from '../../core/lot';

type Tx = Prisma.TransactionClient;

/** 분할 원장의 거래 유형 — 원천 유형을 `GOODS_ISSUE` 와 갈라야 출고 취소 역전기가 출고 원장 하나만 찾는다(R-3). */
const LOT_SPLIT_TRANSACTION = 'LOT_SPLIT';
const GOODS_ISSUE_LINE_EVENT = 'GOODS_ISSUE_LINE';
const POSTED = 'POSTED';

export interface IssueSplitLine {
  goodsIssueLineId: bigint;
  itemId: bigint;
  lotId: bigint;
  issueQty: Prisma.Decimal;
  uomId: bigint;
  sourceLocationId: bigint;
}

/** 출발 잔액 행에서 되읽는 차원 — 분할 원장 두 줄이 같은 값을 싣는다. */
export interface IssueSplitDimension {
  quality_status_code: string;
  inventory_status_code: string;
  ownership_type_code: string;
  owner_partner_id: bigint | null;
}

export interface IssueSplitInput {
  goodsIssueId: bigint;
  goodsIssueNo: string;
  sourceWarehouseId: bigint;
  plantId: bigint;
  businessDate: string;
  occurredAt: Date;
  lines: IssueSplitLine[];
  /** 라인과 같은 자리 — 잠근 출발 잔액 행. */
  dimensions: IssueSplitDimension[];
}

/**
 * 부분 출고 분할(피처 008 R-1~R-3) — 출고해도 그 LOT 재고가 어디든 남는 줄마다 분할 LOT 을 만들고,
 * 분할 원장 한 건으로 출발 위치에서 부모 → 분할 LOT 으로 재고를 옮긴다. 돌려준 «라인 자리 → 분할 LOT» 으로
 * 호출자가 출고 원장과 출고 라인을 쓴다.
 *
 * ⭐ 출고 원장과 «따로» 둔다 — 한 원장에 넣으면 출고 취소 역전기가 분할 LOT 을 부모로 되돌려 합친다(FR-015).
 * ⭐ 판정은 LOT 의 모든 창고·위치 재고 합 > 이 출고의 그 LOT 줄 합이다. picked 소진은 부모 행에서 이미 끝났다.
 */
export async function splitPartialIssueLines(
  tx: Tx,
  posting: InventoryPostingService,
  input: IssueSplitInput,
  appUserId: number | undefined,
): Promise<Map<number, bigint>> {
  const partial = await partialLineIndexes(tx, input.lines);
  const splits = new Map<number, bigint>();
  if (partial.length === 0) return splits;

  const parents = await tx.lot.findMany({
    where: { lot_id: { in: [...new Set(partial.map((index) => input.lines[index].lotId))] } },
    select: { lot_no: true },
  });
  // 줄마다 잡기 전에 한꺼번에 정렬해 잡는다 — 두 출고가 가족 둘을 반대 순서로 잡는 교착을 막는다.
  await lockLotSplitFamilies(tx, parents.map((lot) => lot.lot_no));
  const createdBy = appUserId == null ? null : BigInt(appUserId);
  for (const index of partial) {
    const line = input.lines[index];
    const child = await splitLotWithin(tx, {
      parentLotId: line.lotId,
      qty: line.issueQty,
      sourceTypeCode: GOODS_ISSUE_SPLIT_SOURCE,
      sourceId: line.goodsIssueLineId,
      sourceEventTypeCode: GOODS_ISSUE_LINE_EVENT,
      sourceEventId: line.goodsIssueLineId,
      occurredAt: input.occurredAt,
      createdBy,
    });
    splits.set(index, child.lotId);
  }

  const posted = await posting.post(tx, {
    businessDate: input.businessDate,
    occurredAt: input.occurredAt,
    transactionTypeCode: LOT_SPLIT_TRANSACTION,
    transactionNo: `${input.goodsIssueNo}-S`,
    statusCode: POSTED,
    plantId: Number(input.plantId),
    sourceDocumentTypeCode: GOODS_ISSUE_SPLIT_SOURCE,
    sourceDocumentId: Number(input.goodsIssueId),
    idempotencyKey: `${LOT_SPLIT_TRANSACTION}:${input.goodsIssueNo}`,
    createdBy: appUserId,
    lines: partial.flatMap((index) => {
      const line = input.lines[index];
      const dimension = input.dimensions[index];
      const at = {
        warehouseId: Number(input.sourceWarehouseId),
        locationId: Number(line.sourceLocationId),
        qualityStatusCode: dimension.quality_status_code,
        inventoryStatusCode: dimension.inventory_status_code,
      };
      const common = {
        itemId: Number(line.itemId),
        qty: Number(line.issueQty),
        uomId: Number(line.uomId),
        ownershipTypeCode: dimension.ownership_type_code,
        ...(dimension.owner_partner_id === null ? {} : { ownerPartnerId: Number(dimension.owner_partner_id) }),
      };
      return [
        { ...common, lotId: Number(line.lotId), from: at },
        { ...common, lotId: Number(splits.get(index)), to: at },
      ];
    }),
  });
  if (posted.alreadyPosted) {
    throw new Error(`분할 원장이 이미 있다 — 상태 잠금을 지나쳤다: ${input.goodsIssueNo}`);
  }
  return splits;
}

/** 출고 뒤에도 재고가 남는 LOT 의 줄 자리. 출고 줄 합이 재고 합과 같으면(전량) 분할하지 않는다(US1-6). */
async function partialLineIndexes(tx: Tx, lines: IssueSplitLine[]): Promise<number[]> {
  const issued = new Map<bigint, Prisma.Decimal>();
  for (const line of lines) {
    issued.set(line.lotId, (issued.get(line.lotId) ?? new Prisma.Decimal(0)).plus(line.issueQty));
  }
  const stock = await tx.$queryRaw<{ lot_id: bigint; on_hand: Prisma.Decimal }[]>`
    SELECT lot_id, SUM(on_hand_qty) AS on_hand
      FROM inventory.inventory_balance
     WHERE lot_id = ANY(${[...issued.keys()]}::bigint[])
     GROUP BY lot_id`;
  const remains = new Set(
    stock.filter((row) => new Prisma.Decimal(row.on_hand).greaterThan(issued.get(row.lot_id) ?? 0)).map((row) => row.lot_id),
  );
  return lines.flatMap((line, index) => (remains.has(line.lotId) ? [index] : []));
}

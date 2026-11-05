import { Prisma } from '@prisma/client';

import { DocumentStateService } from '../document-state';
import { PickingHandoverNotifier } from '../picking';
import { availableQty, lockPairs, pairKey, plannedLines, sumPlanned } from './planned-stock';
import { MaterialIssueReleaser } from './release-request';
import { recordRequestAudit } from './request-lifecycle';

/**
 * 창고 보충 요청 만들기(피처 004 · research R-3) — 직접 요청(W-02-12)과 자동 보충 러너가 같은 함수를 탄다.
 *
 * 줄을 출고 자재 창고별로 묶어(FR-007) 창고마다 요청 한 장. (출고 자재 창고, 품목) 쌍을 잠근 뒤 쓸 수 있는 양
 * (가용 − 예정)까지만 요청하고 넘는 양은 줄의 부족으로 남긴다. 쓸 수 있는 양이 0 인 줄은 만들지 않는다(건너뛴 줄).
 * 만든 요청은 같은 트랜잭션에서 배포한다(003 `MaterialIssueReleaser` — 피킹 지시·인계 알림, 담당자 없음).
 *
 * ⛔ 채번은 부르는 쪽이 트랜잭션 밖에서 `sourceGroups` 수만큼 한다 — 안에서 부르면 한 요청이 커넥션을 둘 쥔다. 못 쓴 번호는 결번이다.
 * 모든 줄을 건너뛰면 요청이 없다 — 그 판단(409 인지 실행 기록인지)은 부르는 쪽 몫이다.
 */

const ZERO = new Prisma.Decimal(0);

export interface ReplenishmentLine {
  itemId: bigint;
  uomId: bigint;
  requestedQty: Prisma.Decimal;
  sourceWarehouseId: bigint;
}

export interface ReplenishmentCreateInput {
  productionWarehouseId: bigint;
  destinationLocationId: bigint;
  /** 공장 현지 오늘(YYYY-MM-DD) — 출고 작업일. */
  issueWorkDate: string;
  origin: 'DIRECT' | 'AUTO';
  runId?: bigint | null;
  lines: ReplenishmentLine[];
  remarks?: string | null;
  actorId: number | null;
  now: Date;
  /** 러너가 현장 새벽에 배포할 때만 — 인계 알림 Zalo 를 미룬다(003 FR-021a). */
  zaloNotBefore?: Date;
}

export interface ReplenishmentNumbers {
  requestNos: string[];
  pickingNos: string[];
}

export interface CappedLine {
  line: ReplenishmentLine;
  requested: Prisma.Decimal;
  shortage: Prisma.Decimal;
  freeQty: Prisma.Decimal;
}

export interface ReplenishmentCreated {
  /** 출고 자재 창고 순. */
  requests: { requestId: bigint; sourceWarehouseId: bigint; lines: CappedLine[] }[];
  /** 쓸 수 있는 양이 0 이라 만들지 않은 줄. */
  skippedLines: CappedLine[];
}

/** 출고 자재 창고별 묶음 수 = 요청 장 수의 최대 — 채번할 수. */
export function sourceGroups(lines: readonly ReplenishmentLine[]): bigint[] {
  return [...new Set(lines.map((line) => line.sourceWarehouseId))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 줄마다 요청 = min(요청, 쓸 수 있는 양), 부족 = 나머지. 쓸 수 있는 양 = max(가용 − 예정, 0).
 * 같은 쌍이 두 줄이면 앞 줄이 먼저 쓴다(직접 요청은 막고, 러너는 만들지 않는다).
 */
export function planLines(
  lines: readonly ReplenishmentLine[],
  available: ReadonlyMap<string, Prisma.Decimal>,
  planned: ReadonlyMap<string, Prisma.Decimal>,
): { kept: CappedLine[]; skipped: CappedLine[] } {
  const used = new Map<string, Prisma.Decimal>();
  const kept: CappedLine[] = [];
  const skipped: CappedLine[] = [];
  for (const line of lines) {
    const key = pairKey(line.sourceWarehouseId, line.itemId);
    const free = Prisma.Decimal.max((available.get(key) ?? ZERO).minus(planned.get(key) ?? ZERO).minus(used.get(key) ?? ZERO), ZERO);
    const requested = Prisma.Decimal.min(line.requestedQty, free);
    const row = { line, requested, shortage: line.requestedQty.minus(requested), freeQty: free };
    if (requested.lte(0)) {
      skipped.push(row);
      continue;
    }
    used.set(key, (used.get(key) ?? ZERO).plus(requested));
    kept.push(row);
  }
  return { kept, skipped };
}

export class ReplenishmentCreator {
  private readonly releaser: MaterialIssueReleaser;

  constructor(documentState: DocumentStateService, pickingNotices: PickingHandoverNotifier) {
    this.releaser = new MaterialIssueReleaser(documentState, pickingNotices);
  }

  async write(tx: Prisma.TransactionClient, input: ReplenishmentCreateInput, numbers: ReplenishmentNumbers): Promise<ReplenishmentCreated> {
    const sources = sourceGroups(input.lines);
    const itemIds = [...new Set(input.lines.map((line) => line.itemId))];
    await lockPairs(tx, input.lines.map((line) => ({ warehouseId: line.sourceWarehouseId, itemId: line.itemId })));
    const [available, planned] = await Promise.all([
      availableQty(tx, sources, itemIds),
      plannedLines(tx, { warehouseIds: sources, itemIds }).then(sumPlanned),
    ]);
    const { kept, skipped } = planLines(input.lines, available, planned);

    const result: ReplenishmentCreated = { requests: [], skippedLines: skipped };
    for (const [index, sourceWarehouseId] of sources.entries()) {
      const rows = kept.filter((row) => row.line.sourceWarehouseId === sourceWarehouseId);
      if (rows.length === 0) continue;
      const requestId = await this.writeRequest(tx, input, sourceWarehouseId, rows, numbers.requestNos[index]);
      await this.releaser.release(tx, requestId, numbers.pickingNos[index], input.actorId, {
        now: input.now,
        ...(input.zaloNotBefore === undefined ? {} : { zaloNotBefore: input.zaloNotBefore }),
      });
      result.requests.push({ requestId, sourceWarehouseId, lines: rows });
    }
    return result;
  }

  private async writeRequest(
    tx: Prisma.TransactionClient,
    input: ReplenishmentCreateInput,
    sourceWarehouseId: bigint,
    rows: CappedLine[],
    requestNo: string,
  ): Promise<bigint> {
    const actor = input.actorId === null ? null : BigInt(input.actorId);
    const header = await tx.material_issue_request.create({
      data: {
        issue_request_no: requestNo,
        request_type_code: 'REPLENISHMENT',
        replenishment_origin_code: input.origin,
        replenishment_run_id: input.runId ?? null,
        source_warehouse_id: sourceWarehouseId,
        destination_location_id: input.destinationLocationId,
        issue_work_date: new Date(`${input.issueWorkDate}T00:00:00.000Z`),
        status_code: 'WAITING',
        requested_by: actor,
        remarks: input.remarks ?? null,
        created_at: input.now,
        created_by: actor,
        updated_at: input.now,
        updated_by: actor,
      },
      select: { material_issue_request_id: true },
    });
    const id = header.material_issue_request_id;
    await tx.material_issue_request_line.createMany({
      data: rows.map(({ line, requested, shortage }, index) => ({
        material_issue_request_id: id,
        line_no: index + 1,
        item_id: line.itemId,
        requested_qty: requested,
        shortage_qty: shortage,
        uom_id: line.uomId,
        created_by: actor,
      })),
    });
    await recordRequestAudit(tx, { requestId: id, action: 'CREATED', actorId: input.actorId, detail: { reason: input.origin }, at: input.now });
    return id;
  }
}

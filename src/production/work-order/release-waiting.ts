import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';

import { MaterialIssueReleaser } from '../../core/material-issue/release-request';
import { recordRequestAudit } from '../../core/material-issue/request-lifecycle';
import { chooseSources, resolveCandidates } from '../../core/material-issue/source-warehouse';
import { MaterialIssueLine } from './material-issue';
import { WaitingPlan } from './release-plan';

const WAITING = 'WAITING';
const ZERO = new Prisma.Decimal(0);

/** 배포 응답의 요청 요약 — 창고별로 한 장씩(계약 `WorkOrderReleaseResult.materialIssueRequests`). */
export interface ReleasedRequest {
  materialIssueRequestId: number;
  issueRequestNo: string;
  sourceWarehouseId: number;
  statusCode: string;
  issueWorkDate: string;
}

/** 재고 있는 생산 창고가 없어 요청에 넣지 못한 자재(FR-007a). */
export interface UnsourcedShortage {
  itemId: number;
  itemCode: string;
  itemName: string;
  shortageQty: number;
  uomCode: string;
}

export interface WaitingResult {
  materialIssueRequests: ReleasedRequest[];
  unsourcedShortages: UnsourcedShortage[];
}

type Draft = MaterialIssueLine & { shortage_qty: Prisma.Decimal };

/**
 * 생산 창고 공장의 W/O 배포 — 출발 창고별 대기 요청(피처 003 · research R-5·R-7, FR-006~008·012).
 *
 * 자물쇠를 잡고 자재마다 창고를 고른 뒤, 그 창고의 쓸 수 있는 양을 넘는 소요는 줄여서 담고 줄인 양을 줄의
 * `shortage_qty` 에 남긴다(배포는 막지 않는다). 후보가 없는 자재는 요청에 넣지 않고 W/O 단위 부족 행에 남긴다.
 * 출고 작업일이 이미 오늘 이하면 같은 트랜잭션에서 배포한다 — 00:00 러너와 같은 함수다.
 */
export async function writeWaitingRequests(
  tx: Prisma.TransactionClient,
  input: { workOrderId: bigint; waiting: WaitingPlan; lines: MaterialIssueLine[]; appUserId: number },
  releaser: MaterialIssueReleaser,
): Promise<WaitingResult> {
  const { waiting, lines } = input;
  await assertSameCandidates(tx, waiting);
  const choice = await chooseSources(tx, { warehouseIds: waiting.warehouseIds, itemIds: lines.map((l) => l.item_id) });

  const byWarehouse = new Map<bigint, Draft[]>();
  const freeLeft = new Map([...choice.chosen].map(([itemId, source]) => [itemId, source.freeQty]));
  for (const line of lines) {
    const source = choice.chosen.get(line.item_id);
    if (source === undefined) continue;
    const free = freeLeft.get(line.item_id) ?? ZERO;
    const requested = Prisma.Decimal.min(line.requested_qty, free);
    freeLeft.set(line.item_id, free.minus(requested));
    const drafts = byWarehouse.get(source.warehouseId) ?? [];
    drafts.push({ ...line, requested_qty: requested, shortage_qty: line.requested_qty.minus(requested) });
    byWarehouse.set(source.warehouseId, drafts);
  }

  const materialIssueRequests: ReleasedRequest[] = [];
  const warehouses = [...byWarehouse.keys()].sort((a, b) => (a < b ? -1 : 1));
  for (const [index, warehouseId] of warehouses.entries()) {
    const header = await tx.material_issue_request.create({
      data: {
        issue_request_no: waiting.issueRequestNos[index],
        work_order_id: input.workOrderId,
        source_warehouse_id: warehouseId,
        destination_location_id: waiting.destinationLocationId,
        issue_work_date: new Date(`${waiting.issueWorkDate}T00:00:00.000Z`),
        status_code: WAITING,
        requested_by: input.appUserId,
        created_by: input.appUserId,
      },
      select: { material_issue_request_id: true, issue_request_no: true },
    });
    await tx.material_issue_request_line.createMany({
      data: (byWarehouse.get(warehouseId) ?? []).map((line, lineIndex) => ({
        ...line,
        line_no: lineIndex + 1,
        material_issue_request_id: header.material_issue_request_id,
      })),
    });
    await recordRequestAudit(tx, {
      requestId: header.material_issue_request_id,
      action: 'CREATE',
      actorId: input.appUserId,
      after: { statusCode: WAITING, sourceWarehouseId: Number(warehouseId), issueWorkDate: waiting.issueWorkDate },
    });
    const released =
      waiting.releaseNow &&
      (await releaser.release(tx, header.material_issue_request_id, waiting.pickingOrderNos[index], input.appUserId));
    materialIssueRequests.push({
      materialIssueRequestId: Number(header.material_issue_request_id),
      issueRequestNo: header.issue_request_no,
      sourceWarehouseId: Number(warehouseId),
      statusCode: released ? 'REGISTERED' : WAITING,
      issueWorkDate: waiting.issueWorkDate,
    });
  }

  return { materialIssueRequests, unsourcedShortages: await writeUnsourced(tx, input.workOrderId, lines, choice.unsourced) };
}

/**
 * D 는 트랜잭션 밖에서 읽었다 — 그 사이 부서 생산 창고 연결이 바뀌었으면 옛 D 로 요청을 만들지 않는다.
 * 다시 배포하면 새 연결로 풀린다(저장 충돌과 같은 뜻이라 STALE_VERSION).
 */
async function assertSameCandidates(tx: Prisma.TransactionClient, waiting: WaitingPlan): Promise<void> {
  const now = await resolveCandidates(tx, { plantId: waiting.plantId, productionLineId: waiting.productionLineId });
  const same =
    !('errors' in now) &&
    now.destinationLocationId === waiting.destinationLocationId &&
    now.warehouseIds.join() === waiting.warehouseIds.join();
  if (same) return;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    { scope: 'screen', code: ERROR_CODE.STALE_VERSION, message: '배포하는 사이 부서 생산 창고 연결이 바뀌었습니다. 다시 배포하세요.' },
  ]);
}

/** 자재마다 한 행(소요 합). 같은 자재 줄이 여럿이어도 한 행이다 — UNIQUE (W/O, 자재). */
async function writeUnsourced(
  tx: Prisma.TransactionClient,
  workOrderId: bigint,
  lines: MaterialIssueLine[],
  itemIds: bigint[],
): Promise<UnsourcedShortage[]> {
  if (itemIds.length === 0) return [];
  const totals = itemIds.map((itemId) => {
    const own = lines.filter((line) => line.item_id === itemId);
    return { itemId, uomId: own[0].uom_id, qty: own.reduce((sum, line) => sum.plus(line.requested_qty), ZERO) };
  });
  await tx.material_issue_unsourced_shortage.createMany({
    data: totals.map((row) => ({ work_order_id: workOrderId, item_id: row.itemId, uom_id: row.uomId, shortage_qty: row.qty })),
  });
  const [items, uoms] = await Promise.all([
    tx.item.findMany({ where: { item_id: { in: itemIds } }, select: { item_id: true, item_code: true, item_name: true } }),
    tx.uom.findMany({ where: { uom_id: { in: totals.map((row) => row.uomId) } }, select: { uom_id: true, uom_code: true } }),
  ]);
  const itemOf = new Map(items.map((item) => [item.item_id, item]));
  const uomOf = new Map(uoms.map((uom) => [uom.uom_id, uom.uom_code]));
  return totals.map((row) => ({
    itemId: Number(row.itemId),
    itemCode: itemOf.get(row.itemId)?.item_code ?? '',
    itemName: itemOf.get(row.itemId)?.item_name ?? '',
    shortageQty: row.qty.toNumber(),
    uomCode: uomOf.get(row.uomId) ?? '',
  }));
}

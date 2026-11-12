import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { MATERIAL_LOT_BATCH_SOURCE, PREISSUED_LIFECYCLE, VOIDED_LIFECYCLE, parseMaterialLotNo } from '../../core/lot';

/** 본문 `lots[]` 한 줄 — 미리 만든 LOT(`lotId`) 또는 공급사 사전부착 라벨(`lotNo`). */
export interface InboundLotReceiveEntry {
  lotId?: number;
  lotNo?: string;
  supplierLotNo?: string | null;
}

export type ReceiveRejectionCode = 'ALREADY_RECEIVED' | 'VOIDED' | 'NOT_MATERIAL_LOT';

interface ResolvedBase {
  index: number;
  lotNo: string;
  qty: Prisma.Decimal;
  itemId: bigint;
  supplierId: bigint;
}
/** 미리 만든 대기 LOT — 받기가 L4 로 옮긴다. */
export interface WaitingLot extends ResolvedBase { kind: 'waiting'; lotId: bigint; batchId: bigint }
/** 시스템에 없는 사전부착 라벨 — 받기가 이 자리에서 만든다. */
export interface LabelLot extends ResolvedBase { kind: 'label'; supplierLotNo: string | null }
export type ResolvedReceiveLot = WaitingLot | LabelLot;

const MATERIAL_LOT_TYPE = 'MATERIAL';
const SUPPLIER_LOT_NO_MAX = 100;

interface LotFacts {
  lot_id: bigint;
  lot_no: string;
  plant_id: bigint;
  item_id: bigint;
  initial_qty: Prisma.Decimal;
  lot_type_code: string;
  source_type_code: string;
  source_id: bigint;
  lifecycle_status_code: string | null;
  inbound_lot_no: string | null;
  inbound_lot_status_code: string | null;
}

/** 트랜잭션 밖에서 보는 형식 — 라벨 형식(P-3)·공급사 LOT 길이·같은 값 두 번. */
export function assertReceiveEntries(entries: readonly InboundLotReceiveEntry[]): void {
  const errors: ErrorItem[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const key = entry.lotId === undefined ? `no:${String(entry.lotNo)}` : `id:${String(entry.lotId)}`;
    if (seen.has(key)) errors.push(field(`lots.${String(index)}`, ERROR_CODE.INVALID, '같은 LOT 을 한 요청에 두 번 실었습니다.'));
    seen.add(key);
    if (entry.lotNo === undefined) continue;
    try {
      parseMaterialLotNo(entry.lotNo);
    } catch {
      errors.push(field(`lots.${String(index)}.lotNo`, ERROR_CODE.INVALID, '사전부착 LOT 번호 형식이 올바르지 않습니다.'));
    }
    if ((entry.supplierLotNo?.trim().length ?? 0) > SUPPLIER_LOT_NO_MAX) {
      errors.push(field(`lots.${String(index)}.supplierLotNo`, ERROR_CODE.RANGE, `공급사 LOT 번호는 ${String(SUPPLIER_LOT_NO_MAX)}자 안입니다.`));
    }
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

/**
 * 본문의 LOT 들을 풀어 받을 수 있는지 가른다. `lock` 이면 LOT 행을 `lot_id` 오름차순으로 잠근다(받기·폐기·해제가 같은 순서).
 * 400(없는 LOT·다른 공장·라벨 코드가 MES 에 없음·같은 LOT 두 번)을 먼저, 그다음 409(대기가 아님 — 줄마다 까닭)다.
 */
export async function resolveReceiveLots(
  db: Prisma.TransactionClient,
  plantId: bigint,
  entries: readonly InboundLotReceiveEntry[],
  lock: boolean,
): Promise<ResolvedReceiveLot[]> {
  const facts = await readLots(db, plantId, entries, lock);
  const byId = new Map(facts.map((row) => [row.lot_id, row]));
  const byNo = new Map(facts.filter((row) => row.plant_id === plantId).map((row) => [row.lot_no, row]));
  const errors: ErrorItem[] = [];
  const found: { index: number; row: LotFacts }[] = [];
  const labels: { index: number; lotNo: string; supplierLotNo: string | null }[] = [];
  for (const [index, entry] of entries.entries()) {
    const row = entry.lotId === undefined ? byNo.get(entry.lotNo as string) : byId.get(BigInt(entry.lotId));
    if (row !== undefined && row.plant_id === plantId) found.push({ index, row });
    else if (entry.lotId === undefined) labels.push({ index, lotNo: entry.lotNo as string, supplierLotNo: entry.supplierLotNo?.trim() || null });
    else errors.push(field(`lots.${String(index)}.lotId`, ERROR_CODE.INVALID, '없는 LOT 입니다.'));
  }
  const counted = new Map<bigint, number>();
  for (const { index, row } of found) {
    if (counted.has(row.lot_id)) errors.push(field(`lots.${String(index)}`, ERROR_CODE.INVALID, '같은 LOT 을 한 요청에 두 번 실었습니다.'));
    counted.set(row.lot_id, index);
  }
  const labelLots = await resolveLabels(db, labels, errors);
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  rejectNotWaiting(found);

  const batchIds = [...new Set(found.map(({ row }) => row.source_id))];
  const batches = await db.material_lot_batch.findMany({
    where: { material_lot_batch_id: { in: batchIds } }, select: { material_lot_batch_id: true, supplier_id: true },
  });
  const supplierOf = new Map(batches.map((batch) => [batch.material_lot_batch_id, batch.supplier_id]));
  const waiting: WaitingLot[] = found.map(({ index, row }) => ({
    kind: 'waiting', index, lotId: row.lot_id, lotNo: row.lot_no, qty: row.initial_qty, itemId: row.item_id,
    supplierId: supplierOf.get(row.source_id) as bigint, batchId: row.source_id,
  }));
  return [...waiting, ...labelLots].sort((left, right) => left.index - right.index);
}

async function readLots(
  db: Prisma.TransactionClient, plantId: bigint, entries: readonly InboundLotReceiveEntry[], lock: boolean,
): Promise<LotFacts[]> {
  const ids = entries.flatMap((entry) => (entry.lotId === undefined ? [] : [Prisma.sql`${BigInt(entry.lotId)}::bigint`]));
  const nos = entries.flatMap((entry) => (entry.lotNo === undefined ? [] : [entry.lotNo]));
  const byId = ids.length === 0 ? Prisma.sql`false` : Prisma.sql`l.lot_id IN (${Prisma.join(ids)})`;
  const byNo = nos.length === 0 ? Prisma.sql`false` : Prisma.sql`(l.plant_id = ${plantId} AND l.lot_no IN (${Prisma.join(nos)}))`;
  return db.$queryRaw<LotFacts[]>`
    SELECT l.lot_id, l.lot_no, l.plant_id, l.item_id, l.initial_qty, l.lot_type_code, l.source_type_code, l.source_id,
           l.lifecycle_status_code, il.inbound_lot_no, il.status_code AS inbound_lot_status_code
      FROM trace.lot l
      LEFT JOIN trace.inbound_lot il ON il.inbound_lot_id = l.inbound_lot_id
     WHERE ${byId} OR ${byNo}
     ORDER BY l.lot_id
     ${lock ? Prisma.sql`FOR UPDATE OF l` : Prisma.empty}`;
}

/** 시스템에 없는 라벨 — 라벨의 품목·공급사 코드가 MES 에 있어야 한다(P-3). 수량은 라벨의 수량 칸이다. */
async function resolveLabels(
  db: Prisma.TransactionClient,
  labels: { index: number; lotNo: string; supplierLotNo: string | null }[],
  errors: ErrorItem[],
): Promise<LabelLot[]> {
  if (labels.length === 0) return [];
  const parsed = labels.map((label) => ({ ...label, segments: parseMaterialLotNo(label.lotNo) }));
  const [items, suppliers] = await Promise.all([
    db.item.findMany({ where: { item_code: { in: parsed.map((label) => label.segments.itemCode) } }, select: { item_id: true, item_code: true } }),
    db.partner.findMany({ where: { partner_code: { in: parsed.map((label) => label.segments.supplierCode) } }, select: { partner_id: true, partner_code: true } }),
  ]);
  const itemOf = new Map(items.map((item) => [item.item_code, item.item_id]));
  const supplierOf = new Map(suppliers.map((supplier) => [supplier.partner_code, supplier.partner_id]));
  const resolved: LabelLot[] = [];
  for (const label of parsed) {
    const at = `lots.${String(label.index)}.lotNo`;
    const itemId = itemOf.get(label.segments.itemCode);
    const supplierId = supplierOf.get(label.segments.supplierCode);
    const qty = new Prisma.Decimal(label.segments.qty);
    if (itemId === undefined) errors.push(field(at, ERROR_CODE.INVALID, '사전부착 LOT 번호의 제품코드가 MES 에 없습니다.'));
    if (supplierId === undefined) errors.push(field(at, ERROR_CODE.INVALID, '사전부착 LOT 번호의 공급사코드가 MES 에 없습니다.'));
    if (!qty.greaterThan(0)) errors.push(field(at, ERROR_CODE.INVALID, '사전부착 LOT 번호의 수량이 0 입니다.'));
    if (itemId === undefined || supplierId === undefined) continue;
    resolved.push({ kind: 'label', index: label.index, lotNo: label.lotNo, qty, itemId, supplierId, supplierLotNo: label.supplierLotNo });
  }
  return resolved;
}

/**
 * 대기(미리 만든 자재 관리 LOT)가 아니면 줄마다 까닭을 달아 409 — 하나라도 있으면 아무것도 등록하지 않는다.
 * 이미 등록된 LOT 은 속한 입하 LOT 의 번호·상태를 함께 싣는다 — 화면이 그 카드 없이 「어느 입하 LOT 에 이미 있는지」를 그린다.
 */
function rejectNotWaiting(found: { index: number; row: LotFacts }[]): void {
  const rejected = found.flatMap(({ index, row }) => {
    const reasonCode = rejectionOf(row);
    return reasonCode === null ? [] : [{
      index, lotId: Number(row.lot_id), lotNo: row.lot_no, reasonCode,
      inboundLotNo: row.inbound_lot_no, inboundLotStatusCode: row.inbound_lot_status_code,
    }];
  });
  if (rejected.length === 0) return;
  throw new ContractException(HttpStatus.CONFLICT, rejected.map((lot) => field(
    `lots.${String(lot.index)}`, ERROR_CODE.STATE_LOCKED, `${MESSAGE[lot.reasonCode]} (LOT ${lot.lotNo})`,
  )), { rejectedLots: rejected });
}

const MESSAGE: Record<ReceiveRejectionCode, string> = {
  ALREADY_RECEIVED: '이미 입하된 LOT 입니다.',
  VOIDED: '폐기된 LOT 입니다.',
  NOT_MATERIAL_LOT: '자재 관리 LOT 이 아닙니다.',
};

function rejectionOf(row: LotFacts): ReceiveRejectionCode | null {
  if (row.lot_type_code !== MATERIAL_LOT_TYPE) return 'NOT_MATERIAL_LOT';
  if (row.lifecycle_status_code === VOIDED_LIFECYCLE) return 'VOIDED';
  if (row.lifecycle_status_code === PREISSUED_LIFECYCLE && row.source_type_code === MATERIAL_LOT_BATCH_SOURCE) return null;
  return 'ALREADY_RECEIVED';
}

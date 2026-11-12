import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field, one } from '../../common/errors';
import { recordTerminalWorkerAudit, type TerminalWorkerAuditActor } from '../../audit/terminal-worker-audit';
import { LotLifecycleService } from './lot-lifecycle.service';
import { INITIAL_LOT_STATUS, PREISSUED_LIFECYCLE, nextMaterialLotNos, type Tx } from './lot-registry.service';
import { MATERIAL_LOT_BATCH_SOURCE } from './lot-source';

/**
 * 자재 관리 LOT 발행 묶음(피처 005 R-3·R-4) — 공급사·품목으로 대기 LOT N 개를 한 번에 미리 만든다.
 * ⛔ 보류·IQC 요청·재고·입하 LOT 을 만들지 않는다 — 실물이 아직 없다. 그것은 PDA 받기(L4)가 한다.
 * ⛔ `lot_lifecycle_history` 를 쓰지 않는다 — 생산 선발행(`preIssueWithin`)과 같다: `WAITING` 은 태어남이지 전이가 아니다.
 */

export const MATERIAL_LOT_COUNT_MAX = 200;
const MATERIAL_LOT_TYPE = 'MATERIAL';
const SUPPLIER_LOT_IDENTIFIER = 'SUPPLIER_LOT';
const SUPPLIER_LOT_NO_MAX = 100;
const VOID_ACTION = 'material-lot-voided';

export interface MaterialPackageInput {
  uomId: number;
  count: number;
  qtyPerPackage: number;
}

export interface MaterialLotBatchInput {
  plantId: number;
  supplierId: number;
  itemId: number;
  lotQty: number;
  /** 보내면 품목 기본 단위여야 한다 — 수량 단위는 LOT 마다 고르지 않는다(FR-002). */
  uomId?: number | null;
  package?: MaterialPackageInput | null;
  supplierLotNo?: string | null;
  lotCount: number;
  businessDate: string;
}

export type MaterialLotBatchActor =
  | { channel: 'WEB'; appUserId: number }
  | { channel: 'POP'; workerId: bigint; terminalAudit: TerminalWorkerAuditActor };

export interface MaterialLotBatchCreated {
  batchId: bigint;
  lotIds: bigint[];
}

/** 형식 검사 — DB CHECK(`ck_lot_package`·`ck_material_lot_batch_*`)가 500 으로 내기 전에 400 으로 앞당긴다. */
export function assertMaterialLotBatchShape(input: MaterialLotBatchInput): void {
  const errors: ErrorItem[] = [];
  if (!(input.lotQty > 0)) errors.push(field('lotQty', ERROR_CODE.RANGE, '재고 수량은 0 보다 커야 합니다.'));
  if (!Number.isInteger(input.lotCount) || input.lotCount < 1 || input.lotCount > MATERIAL_LOT_COUNT_MAX) {
    errors.push(field('lotCount', ERROR_CODE.RANGE, `개수는 1~${String(MATERIAL_LOT_COUNT_MAX)} 입니다.`));
  }
  const pack = input.package;
  if (pack !== undefined && pack !== null) {
    if (!Number.isInteger(pack.count) || pack.count < 1) {
      errors.push(field('package.count', ERROR_CODE.RANGE, '패키징 수는 1 이상입니다.'));
    }
    if (!(pack.qtyPerPackage > 0)) {
      errors.push(field('package.qtyPerPackage', ERROR_CODE.RANGE, '패키징당 수량은 0 보다 커야 합니다.'));
    }
    if (errors.length === 0 && !packageMatches(input.lotQty, pack)) {
      errors.push(field('package', ERROR_CODE.INVALID, '재고 수량이 「패키징 수 × 패키징당 수량」과 같아야 합니다.'));
    }
  }
  if ((normalizedSupplierLotNo(input.supplierLotNo)?.length ?? 0) > SUPPLIER_LOT_NO_MAX) {
    errors.push(field('supplierLotNo', ERROR_CODE.RANGE, `공급사 LOT 번호는 ${String(SUPPLIER_LOT_NO_MAX)}자 안입니다.`));
  }
  if (errors.length > 0) throw new ContractException(400, errors);
}

/** 부동소수 곱이 아니라 십진으로 — 0.1 × 3 이 0.3 과 같아야 한다. */
export function packageMatches(lotQty: number, pack: MaterialPackageInput): boolean {
  return new Prisma.Decimal(pack.qtyPerPackage).times(pack.count).equals(new Prisma.Decimal(lotQty));
}

export function normalizedSupplierLotNo(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** 묶음 행 + 대기 LOT `lotCount` 개 + (있으면) LOT 마다 공급사 LOT 식별자(N:1). 번호 충돌 재시도는 호출자 몫이다. */
export async function issueMaterialLotBatchWithin(
  tx: Tx,
  input: MaterialLotBatchInput,
  actor: MaterialLotBatchActor,
): Promise<MaterialLotBatchCreated> {
  assertMaterialLotBatchShape(input);
  const baseUomId = await assertReferences(tx, input);
  const pack = input.package ?? null;
  const supplierLotNo = normalizedSupplierLotNo(input.supplierLotNo);
  const createdBy = actor.channel === 'WEB' ? BigInt(actor.appUserId) : null;

  const batch = await tx.material_lot_batch.create({
    data: {
      plant_id: input.plantId,
      item_id: input.itemId,
      supplier_id: input.supplierId,
      lot_qty: input.lotQty,
      package_uom_id: pack === null ? null : pack.uomId,
      package_count: pack === null ? null : pack.count,
      qty_per_package: pack === null ? null : pack.qtyPerPackage,
      supplier_lot_no: supplierLotNo,
      lot_count: input.lotCount,
      created_channel_code: actor.channel,
      created_by: createdBy,
      created_worker_id: actor.channel === 'POP' ? actor.workerId : null,
    },
    select: { material_lot_batch_id: true },
  });
  const lotNos = await nextMaterialLotNos(tx, {
    plantId: input.plantId, itemId: input.itemId, receivedQty: input.lotQty,
    supplierId: input.supplierId, businessDate: input.businessDate,
  }, input.lotCount, 'lotQty');

  // 200 개를 한 줄씩 넣으면 왕복이 200 번이다(SC-001 3초) — 묶어 넣고 번호로 되읽는다.
  await tx.lot.createMany({
    data: lotNos.map((lotNo) => ({
      lot_no: lotNo,
      item_id: input.itemId,
      lot_type_code: MATERIAL_LOT_TYPE,
      plant_id: input.plantId,
      initial_qty: input.lotQty,
      uom_id: baseUomId,
      source_type_code: MATERIAL_LOT_BATCH_SOURCE,
      source_id: batch.material_lot_batch_id,
      status_code: INITIAL_LOT_STATUS,
      lifecycle_status_code: PREISSUED_LIFECYCLE,
      package_uom_id: pack === null ? null : pack.uomId,
      package_count: pack === null ? null : pack.count,
      qty_per_package: pack === null ? null : pack.qtyPerPackage,
      created_by: createdBy,
    })),
  });
  const lots = await tx.lot.findMany({
    where: { plant_id: input.plantId, lot_no: { in: lotNos } },
    select: { lot_id: true, lot_no: true },
  });
  const idByNo = new Map(lots.map((lot) => [lot.lot_no, lot.lot_id]));
  const lotIds = lotNos.map((lotNo) => idByNo.get(lotNo) as bigint);

  if (supplierLotNo !== null) {
    await tx.lot_external_identifier.createMany({
      data: lotIds.map((lotId) => ({
        lot_id: lotId,
        identifier_type_code: SUPPLIER_LOT_IDENTIFIER,
        external_identifier: supplierLotNo,
        partner_id: input.supplierId,
        created_by: createdBy,
      })),
    });
  }
  if (actor.channel === 'POP') {
    await recordTerminalWorkerAudit(tx, {
      actor: actor.terminalAudit, targetTypeCode: 'MATERIAL_LOT_BATCH',
      targetId: batch.material_lot_batch_id, eventTypeCode: 'CREATED',
    });
  }
  return { batchId: batch.material_lot_batch_id, lotIds };
}

/** 공장·공급사·품목·패키징 단위가 있는가, 그리고 수량 단위(품목 기본 단위). 없으면 400 `INVALID`(FK 위반 500 을 앞당긴다). */
async function assertReferences(tx: Tx, input: MaterialLotBatchInput): Promise<bigint> {
  const packageUomId = input.package?.uomId;
  const [plant, supplier, item, packageUom] = await Promise.all([
    tx.plant.findUnique({ where: { plant_id: input.plantId }, select: { plant_id: true } }),
    tx.partner.findUnique({ where: { partner_id: input.supplierId }, select: { partner_id: true } }),
    tx.item.findUnique({ where: { item_id: input.itemId }, select: { base_uom_id: true } }),
    packageUomId === undefined ? null : tx.uom.findUnique({ where: { uom_id: packageUomId }, select: { uom_id: true } }),
  ]);
  const errors: ErrorItem[] = [];
  if (plant === null) errors.push(field('plantId', ERROR_CODE.INVALID, '없는 공장입니다.'));
  if (supplier === null) errors.push(field('supplierId', ERROR_CODE.INVALID, '없는 공급사입니다.'));
  if (item === null) errors.push(field('itemId', ERROR_CODE.INVALID, '없는 품목입니다.'));
  if (packageUomId !== undefined && packageUom === null) {
    errors.push(field('package.uomId', ERROR_CODE.INVALID, '없는 단위입니다.'));
  }
  if (item !== null && input.uomId !== undefined && input.uomId !== null && BigInt(input.uomId) !== item.base_uom_id) {
    errors.push(field('uomId', ERROR_CODE.INVALID, '재고 수량의 단위는 품목 기본 단위여야 합니다.'));
  }
  if (errors.length > 0 || item === null) throw new ContractException(400, errors);
  return item.base_uom_id;
}

export interface MaterialLotVoidOutcome {
  lotId: bigint;
  lotNo: string;
  voided: boolean;
  errorCode: string | null;
}

interface VoidCandidate {
  lot_id: bigint;
  lot_no: string;
  lot_type_code: string;
  source_type_code: string;
  source_id: bigint;
  lifecycle_status_code: string | null;
}

/**
 * 대기 자재 관리 LOT 폐기(L5). ⭐ 건별 결과다 — 대기가 아닌 LOT(이미 입하·폐기, 생산 슬롯 등)은 그 건만
 * `STATE_LOCKED` 로 남기고 나머지는 폐기한다. 없는 LOT 이 섞이면 아무것도 하지 않고 400 이다.
 * 번호는 폐기돼도 그 행에 남아 다시 매겨지지 않는다(일련은 남은 행의 최댓값 다음이다).
 */
export async function voidMaterialLotsWithin(
  tx: Tx,
  lifecycle: LotLifecycleService,
  lotIds: readonly bigint[],
  changedAt: Date,
): Promise<MaterialLotVoidOutcome[]> {
  const unique = [...new Set(lotIds)];
  if (unique.length === 0) throw one(field('lotIds', ERROR_CODE.REQUIRED, '폐기할 LOT 을 고르세요.'));
  // 받기(L4)와 겹치지 않게 잠그고 판정한다 — `lot_id` 오름차순(다른 잠금 자리와 같은 순서).
  const rows = await tx.$queryRaw<VoidCandidate[]>`
    SELECT lot_id, lot_no, lot_type_code, source_type_code, source_id, lifecycle_status_code
      FROM trace.lot
     WHERE lot_id IN (${Prisma.join(unique.map((id) => Prisma.sql`${id}::bigint`))})
     ORDER BY lot_id
       FOR UPDATE`;
  if (rows.length !== unique.length) throw one(field('lotIds', ERROR_CODE.INVALID, '없는 LOT 이 섞여 있습니다.'));

  const eligible = rows.filter((row) => row.lot_type_code === MATERIAL_LOT_TYPE
    && row.source_type_code === MATERIAL_LOT_BATCH_SOURCE && row.lifecycle_status_code === PREISSUED_LIFECYCLE);
  const byBatch = new Map<bigint, bigint[]>();
  for (const row of eligible) byBatch.set(row.source_id, [...(byBatch.get(row.source_id) ?? []), row.lot_id]);
  const moved = new Set<bigint>();
  for (const [batchId, ids] of byBatch) {
    const result = await lifecycle.moveWithin(tx, {
      lotIds: ids, action: VOID_ACTION, sourceDocumentTypeCode: MATERIAL_LOT_BATCH_SOURCE,
      sourceDocumentId: batchId, changedAt,
    });
    result.movedLotIds.forEach((id) => moved.add(id));
  }
  const byId = new Map(rows.map((row) => [row.lot_id, row]));
  return unique.map((id) => {
    const voided = moved.has(id);
    return { lotId: id, lotNo: (byId.get(id) as VoidCandidate).lot_no, voided, errorCode: voided ? null : ERROR_CODE.STATE_LOCKED };
  });
}

import { HttpStatus, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { packageMatches, type MaterialPackageInput } from './lot-registry-batch';
import { PREISSUED_LIFECYCLE, nextMaterialLotNos, type Tx } from './lot-registry.service';
import { MATERIAL_LOT_BATCH_SOURCE } from './lot-source';

/**
 * 출력 전 자재 관리 LOT 수정(피처 014 R-7 · FR-016·017) — 같은 LOT 의 수량·패키징을 고친다. 수량이 바뀌면 번호의 수량 자리가 바뀌므로
 * 새 접두사(품목·수량·날짜·공급사)의 다음 일련을 받는다. 대기 LOT 은 재고·원장이 없어 번호를 바꿔도 남는 기록이 없다.
 * `lot_id`·몫 기록은 그대로라 몫 계산이 따라간다(줄이면 빈 몫을 다음 조회가 다시 만들고, 늘리면 만들 양이 줄어든다).
 * 번호 충돌(`uq_lot`) 재시도는 호출자 몫이다.
 */

export const ALREADY_PRINTED = 'ALREADY_PRINTED';
const MATERIAL_LOT_LABEL = 'MATERIAL_LOT_LABEL';

export interface MaterialLotRevision {
  qty: number;
  package: MaterialPackageInput | null;
  /** 새 번호의 날짜 자리 — 수량이 바뀔 때만 쓴다. */
  businessDate: string;
}

export interface MaterialLotRevised {
  lotId: bigint;
  oldLotNo: string;
  lotNo: string;
  renumbered: boolean;
}

interface LockedLot {
  lot_id: bigint;
  lot_no: string;
  plant_id: bigint;
  item_id: bigint;
  lot_type_code: string;
  lifecycle_status_code: string | null;
  source_type_code: string;
  source_id: bigint;
  initial_qty: Prisma.Decimal;
}

export async function reviseMaterialLotWithin(tx: Tx, lotId: bigint, revision: MaterialLotRevision): Promise<MaterialLotRevised> {
  assertRevisionShape(revision);
  const [lot] = await tx.$queryRaw<LockedLot[]>`
    SELECT lot_id, lot_no, plant_id, item_id, lot_type_code, lifecycle_status_code, source_type_code, source_id, initial_qty
      FROM trace.lot WHERE lot_id = ${lotId} FOR UPDATE`;
  if (lot === undefined) throw new NotFoundException('없는 LOT 입니다.');
  if (lot.lot_type_code !== 'MATERIAL' || lot.lifecycle_status_code !== PREISSUED_LIFECYCLE
    || lot.source_type_code !== MATERIAL_LOT_BATCH_SOURCE) {
    throw conflict(ERROR_CODE.STATE_LOCKED, '입하 전 대기 자재 관리 LOT 만 고칠 수 있습니다.');
  }
  const printed = await tx.document_issue_log.count({ where: { lot_id: lotId, document_type_code: MATERIAL_LOT_LABEL } });
  if (printed > 0) throw conflict(ALREADY_PRINTED, '이미 출력한 LOT 은 수량·패키징을 고칠 수 없습니다.');
  const pack = revision.package;
  if (pack !== null && await tx.uom.findUnique({ where: { uom_id: pack.uomId }, select: { uom_id: true } }) === null) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [field('package.uomId', ERROR_CODE.INVALID, '없는 단위입니다.')]);
  }

  const renumbered = !lot.initial_qty.equals(new Prisma.Decimal(revision.qty));
  let lotNo = lot.lot_no;
  if (renumbered) {
    const batch = await tx.material_lot_batch.findUniqueOrThrow({
      where: { material_lot_batch_id: lot.source_id }, select: { supplier_id: true },
    });
    [lotNo] = await nextMaterialLotNos(tx, {
      plantId: Number(lot.plant_id), itemId: Number(lot.item_id), receivedQty: revision.qty,
      supplierId: Number(batch.supplier_id), businessDate: revision.businessDate,
    }, 1, 'qty');
  }
  await tx.lot.update({
    where: { lot_id: lotId },
    data: {
      lot_no: lotNo,
      initial_qty: revision.qty,
      package_uom_id: pack === null ? null : pack.uomId,
      package_count: pack === null ? null : pack.count,
      qty_per_package: pack === null ? null : pack.qtyPerPackage,
      updated_at: new Date(),
      version_no: { increment: 1 },
    },
  });
  return { lotId, oldLotNo: lot.lot_no, lotNo, renumbered };
}

function assertRevisionShape(revision: MaterialLotRevision): void {
  const errors: ErrorItem[] = [];
  if (!(revision.qty > 0)) errors.push(field('qty', ERROR_CODE.RANGE, '수량은 0 보다 커야 합니다.'));
  const pack = revision.package;
  if (pack !== null) {
    if (!Number.isInteger(pack.count) || pack.count < 1) errors.push(field('package.count', ERROR_CODE.RANGE, '패키징 수는 1 이상입니다.'));
    if (!(pack.qtyPerPackage > 0)) errors.push(field('package.qtyPerPackage', ERROR_CODE.RANGE, '패키징당 수량은 0 보다 커야 합니다.'));
    if (errors.length === 0 && !packageMatches(revision.qty, pack)) {
      errors.push(field('package', ERROR_CODE.INVALID, '수량이 「패키징 수 × 패키징당 수량」과 같아야 합니다.'));
    }
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

function conflict(code: string, message: string): ContractException {
  return new ContractException(HttpStatus.CONFLICT, [{ scope: 'screen', code, message }]);
}

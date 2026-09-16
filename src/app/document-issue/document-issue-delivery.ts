import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { oqcPassedByLine } from '../../logistics/shipment-request/shipment-oqc';
import { DocumentIssueTargetFacts, PreparedDocumentIssueTarget } from './document-issue-create-rules';
import { targetKey } from './document-issue-target-lookup';

type Tx = Prisma.TransactionClient;

interface AllocationRow {
  shipment_lot_allocation_id: bigint;
  lot_id: bigint;
  shipment_request_line_id: bigint;
  plant_id: bigint;
}

/**
 * ⭐ 배분은 이제 납품 라벨의 대상이 «아니다»(SHIP-UNIT-01 · 장부 P-24) — 자격 판정에서
 * 걸러 422 가 난다. 이 잠금은 **기존 발행 이력을 되읽는 경로**만 받치므로 남긴다.
 * ⛔ 배분에 번호를 매기던 `delivery_label_no` 는 더 쓰지 않는다(장부 P-27). 컬럼 삭제는
 *    다음 릴리스다 — 마이그레이션 하위 호환 규칙(사용 제거 배포 → 다음 릴리스에서 삭제).
 */

export async function lockDeliveryAllocations(
  tx: Tx,
  targets: PreparedDocumentIssueTarget[],
  terminalId: bigint | null,
  workerNo: string | undefined,
): Promise<Map<string, DocumentIssueTargetFacts>> {
  const relevant = targets.filter((target) => target.targetTypeCode === 'SHIPMENT_LOT_ALLOCATION');
  if (relevant.length === 0) return new Map();
  const ids = [...relevant.map((target) => target.targetId)].sort(bigintOrder);
  const rows = await tx.$queryRaw<AllocationRow[]>(Prisma.sql`
    SELECT a.shipment_lot_allocation_id,a.lot_id,
           sl.shipment_request_line_id,w.plant_id
    FROM logistics.shipment_lot_allocation a
    JOIN logistics.shipment_line sl ON sl.shipment_line_id=a.shipment_line_id
    JOIN logistics.shipment s ON s.shipment_id=sl.shipment_id
    JOIN mdm.warehouse w ON w.warehouse_id=s.warehouse_id
    WHERE a.shipment_lot_allocation_id IN (${Prisma.join(ids)})
    ORDER BY a.shipment_lot_allocation_id FOR UPDATE OF a`);

  const terminal = terminalId === null ? null : await tx.terminal.findUnique({
    where: { terminal_id: terminalId },
    select: { plant_id: true, terminal_type_code: true, is_active: true },
  });
  if (terminalId !== null && (!terminal || !terminal.is_active
    || terminal.terminal_type_code !== 'POP')) throw forbidden();
  const worker = terminalId === null ? null : await tx.worker.findUnique({
    where: { worker_no: workerNo ?? '' },
    select: { plant_id: true, is_active: true },
  });
  if (terminalId !== null && (!terminal || !worker || !worker.is_active
    || worker.plant_id !== terminal.plant_id)) throw forbidden();

  const oqc = await oqcPassedByLine(tx, rows.map((row) => row.shipment_request_line_id));
  return new Map(rows.map((row) => {
    if (terminal && row.plant_id !== terminal.plant_id) throw forbidden();
    return [targetKey('SHIPMENT_LOT_ALLOCATION', row.shipment_lot_allocation_id), {
      targetTypeCode: 'SHIPMENT_LOT_ALLOCATION' as const,
      targetId: row.shipment_lot_allocation_id,
      lotId: row.lot_id,
      plantId: row.plant_id,
      oqcPassed: oqc.get(String(row.shipment_request_line_id)) === true,
    }];
  }));
}

function forbidden(): ContractException {
  return new ContractException(HttpStatus.FORBIDDEN, [field('targets', ERROR_CODE.PERMISSION_DENIED,
    '이 단말과 작업자는 해당 출하 배분의 납품 라벨을 발급할 수 없습니다.')]);
}

function bigintOrder(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

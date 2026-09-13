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
  delivery_label_no: string | null;
}

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
           sl.shipment_request_line_id,w.plant_id,a.delivery_label_no
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
      deliveryLabelNo: row.delivery_label_no,
    }];
  }));
}

export async function assignDeliveryLabelNumbers(
  tx: Tx,
  facts: Iterable<DocumentIssueTargetFacts>,
  issuedAt: Date,
): Promise<void> {
  const rows = [...facts].filter((fact): fact is Extract<DocumentIssueTargetFacts,
    { targetTypeCode: 'SHIPMENT_LOT_ALLOCATION' }> => fact.targetTypeCode === 'SHIPMENT_LOT_ALLOCATION');
  for (const row of rows) {
    if (row.deliveryLabelNo !== null) continue;
    const number = await nextDeliveryNumberWithin(tx, issuedAt);
    await tx.shipment_lot_allocation.update({
      where: { shipment_lot_allocation_id: row.targetId },
      data: { delivery_label_no: number },
    });
    row.deliveryLabelNo = number;
  }
}

async function nextDeliveryNumberWithin(tx: Tx, issuedAt: Date): Promise<string> {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric',
    month: '2-digit', day: '2-digit' }).format(issuedAt).replace(/-/g, '');
  const rules = await tx.$queryRaw<Array<{ numbering_rule_id: bigint; pattern: string; is_active: boolean }>>(Prisma.sql`
    INSERT INTO app.numbering_rule (document_type_code,pattern,reset_cycle_code)
    VALUES ('DELIVERY_LABEL','DL-{YYYYMMDD}-{SEQ4}','DAILY')
    ON CONFLICT (document_type_code,COALESCE(plant_id,0),COALESCE(lot_type_code,''))
      DO UPDATE SET updated_at=clock_timestamp()
    RETURNING numbering_rule_id,pattern,is_active`);
  const rule = rules[0];
  if (!rule || !rule.is_active || rule.pattern !== 'DL-{YYYYMMDD}-{SEQ4}')
    throw new Error('납품 라벨 번호 규칙이 비활성이거나 승인된 형식과 다릅니다.');
  const counter = await tx.$queryRaw<Array<{ last_value: bigint }>>(Prisma.sql`
    INSERT INTO app.numbering_counter (numbering_rule_id,period_key,last_value)
    VALUES (${rule.numbering_rule_id},${day},1)
    ON CONFLICT ON CONSTRAINT uq_numbering_counter
      DO UPDATE SET last_value=app.numbering_counter.last_value+1,
                    updated_at=clock_timestamp()
    RETURNING last_value`);
  return `DL-${day}-${String(counter[0].last_value).padStart(4, '0')}`;
}

function forbidden(): ContractException {
  return new ContractException(HttpStatus.FORBIDDEN, [field('targets', ERROR_CODE.PERMISSION_DENIED,
    '이 단말과 작업자는 해당 출하 배분의 납품 라벨을 발급할 수 없습니다.')]);
}

function bigintOrder(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

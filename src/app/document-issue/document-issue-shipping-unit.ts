import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { DocumentIssueTargetFacts } from './document-issue-create-rules';
import { targetKey } from './document-issue-target-lookup';

type Tx = Prisma.TransactionClient;

interface ShippingUnitRow {
  shipping_unit_id: bigint;
  status_code: string;
  plant_id: bigint;
}

/**
 * 납품 라벨 대상의 사실 — **출하 단위**(SHIP-UNIT-01 · 장부 P-24).
 *
 * ⭐ 종전에는 출하 LOT 배분이 대상이라 **상자 하나에 납품 라벨이 여러 장** 나왔다. 주인이
 * 출하 단위로 옮겨가면서 단위 하나에 한 장이 된다.
 *
 * ⛔ **행을 잠근다**(`FOR UPDATE`) — 마감과 발행이 겹치면 「아직 안 닫힌 단위」의 라벨이
 * 나가거나, 닫히는 중인 단위를 두 번 찍는다. 배분 대상일 때와 같은 태도다.
 * ⛔ `lot_id` 는 **없다** — 한 단위에 LOT 이 여럿이라 하나를 고를 수 없다. 그래서 발행
 * 기록의 LOT 칸이 null 이 되고, LOT 으로 발행 이력을 되짚는 조회는 이 라벨을 못 본다
 * (상자 → 배분 → LOT 을 한 단 더 타야 한다 · 설계 문의 195 와 같은 모양).
 */
export async function loadShippingUnitFacts(
  tx: Tx,
  targets: { targetTypeCode: string; targetId: bigint }[],
  terminalId: bigint | null,
  workerNo: string | undefined,
): Promise<Map<string, DocumentIssueTargetFacts>> {
  const relevant = targets.filter((target) => target.targetTypeCode === 'SHIPPING_UNIT');
  if (relevant.length === 0) return new Map();
  const ids = [...relevant.map((target) => target.targetId)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const rows = await tx.$queryRaw<ShippingUnitRow[]>(Prisma.sql`
    SELECT u.shipping_unit_id,u.status_code,w.plant_id
    FROM logistics.shipping_unit u
    JOIN logistics.shipment s ON s.shipment_id=u.shipment_id
    JOIN mdm.warehouse w ON w.warehouse_id=s.warehouse_id
    WHERE u.shipping_unit_id IN (${Prisma.join(ids)})
    ORDER BY u.shipping_unit_id FOR UPDATE OF u`);

  // 단말·작업자 판정은 배분 대상과 «같은 규칙»이다 — POP 전용, 작업자와 단말의 공장 일치.
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

  return new Map(rows.map((row) => {
    if (terminal && row.plant_id !== terminal.plant_id) throw forbidden();
    return [targetKey('SHIPPING_UNIT', row.shipping_unit_id), {
      targetTypeCode: 'SHIPPING_UNIT' as const,
      targetId: row.shipping_unit_id,
      plantId: row.plant_id,
      statusCode: row.status_code,
    }];
  }));
}

/** 문구가 대상마다 다르다 — 배분 쪽(`document-issue-delivery.ts`)과 갈라 둔다. */
function forbidden(): ContractException {
  return new ContractException(HttpStatus.FORBIDDEN, [field('targets', ERROR_CODE.PERMISSION_DENIED,
    '이 단말과 작업자는 해당 출하 단위의 납품 라벨을 발급할 수 없습니다.')]);
}

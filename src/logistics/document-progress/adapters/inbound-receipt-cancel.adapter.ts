import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../../common/errors';

/**
 * 입하 취소 — ⛔ 원장 역처리가 «없다». 입하는 전기 경로 자체가 없어(`plan-api.md` S02)
 * `reversed` 가 언제나 거짓이다. 대신 발주 라인의 수취 누계를 되돌린다.
 *
 * ⭐ 불변식 — `purchase_order_line.received_qty` 를 쓰는 경로는 부모 `purchase_order` 를 «먼저»
 *    오름차순 한 문장으로 잠근다(I-3.md §3-2). ⛔ `inbound-receipt.service.ts` 의 `lockParentsOf`
 *    를 «복제»한다 — 취소는 입하 도메인 service 를 주입하지 않고, 사용처 둘이 서로 다른 축이라
 *    공유 헬퍼로 뽑지도 않는다(CLAUDE.md).
 * ⛔ `inbound_receipt_line.lot_id` 도 `trace.lot` 도 손대지 않는다 — 쓰인 LOT 은 후속 판정이
 *    «먼저» 막으니 여기 닿는 것은 안 쓰인 LOT 뿐이고, 끊으면 「어느 LOT 이 이 입하에서 났나」가
 *    지워진다(B-3 · I-3.md R-12 ⓒ). 상태를 옮길 전이 액션도 없다 — F-6.
 */
export async function cancelInboundReceipt(
  tx: Prisma.TransactionClient,
  documentId: bigint,
): Promise<void> {
  const lines = await tx.inbound_receipt_line.findMany({
    where: { inbound_receipt_id: documentId },
    select: { purchase_order_line_id: true, received_qty: true },
  });
  const attributed = lines.flatMap((line) =>
    line.purchase_order_line_id === null
      ? []
      : [{ lineId: line.purchase_order_line_id, qty: line.received_qty }],
  );
  if (attributed.length === 0) return;
  const lineIds = attributed.map((line) => line.lineId);

  const owners = await tx.purchase_order_line.findMany({
    where: { purchase_order_line_id: { in: lineIds } },
    select: { purchase_order_id: true },
  });
  const parentIds = [...new Set(owners.map((row) => row.purchase_order_id))].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  await tx.$queryRaw`
    SELECT purchase_order_id FROM logistics.purchase_order
     WHERE purchase_order_id IN (${Prisma.join(parentIds)})
     ORDER BY purchase_order_id FOR UPDATE`;

  // 라인마다 되돌린다 — 한 발주 라인에 입하 줄이 둘 붙을 수 있다.
  for (const line of attributed) {
    await tx.purchase_order_line.update({
      where: { purchase_order_line_id: line.lineId },
      data: { received_qty: { decrement: line.qty } },
    });
  }

  // 잠근 뒤 되읽어 하한을 본다 — `received_qty` 에 CHECK(≥0)가 없어 안 보면 음수가 그대로 남는다.
  // ⛔ `Number()` 로 비교하지 않는다 — `Decimal(20,6)` 을 배정도로 접으면 경계가 흔들린다.
  const after = await tx.purchase_order_line.findMany({
    where: { purchase_order_line_id: { in: lineIds } },
    select: { received_qty: true },
  });
  if (after.some((row) => row.received_qty.lessThan(0))) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      {
        scope: 'screen',
        code: ERROR_CODE.RANGE,
        message: '발주 수취 누계가 음수가 됩니다. 먼저 되돌려야 할 입하가 있습니다.',
      },
    ]);
  }
}

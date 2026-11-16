import { Prisma } from '@prisma/client';

import { REVISION_STATUS } from '../revision-status';
import { recordRoutingAudit } from './routing-audit';

/**
 * 추적 시스템 연동(OA)이 라우팅 없는 품목에 만드는 1공정 라우팅(사용자 결정 2026-11-05 · flowtrack 연동 제안 §7-3 의 2).
 * 확정·기본으로 바로 세운다 — 사람이 고칠 Rev 가 아니다. 유효 기간은 비운다(서버가 날짜를 지어내지 않는다).
 * 줄 설정은 실적 관리만 켠다 — 공정 검사·설비·금형·자재 투입 관리는 끈다.
 */
export async function createAutoRouting(
  tx: Prisma.TransactionClient,
  input: { itemId: bigint; itemCode: string; processId: bigint; operationName: string },
): Promise<bigint> {
  const routing = await tx.routing.create({
    data: {
      item_id: input.itemId,
      routing_code: autoRoutingCode(input.itemCode),
      routing_version: 1,
      status_code: REVISION_STATUS.CONFIRMED,
      confirmed_at: new Date(),
      is_default: true,
    },
  });
  await tx.routing_operation.create({
    data: {
      routing_id: routing.routing_id,
      operation_seq: 10,
      process_id: input.processId,
      operation_name: input.operationName,
      mes_managed: true,
      production_result_managed: true,
      inspection_managed: false,
      equipment_required: false,
      mold_required: false,
      material_input_managed: false,
    },
  });
  await recordRoutingAudit(tx, {
    routingId: routing.routing_id,
    eventTypeCode: 'CREATE',
    actorId: null,
    after: { routingCode: routing.routing_code, routingVersion: routing.routing_version, statusCode: routing.status_code },
  });
  return routing.routing_id;
}

/** 라우팅 코드 관례 `RT-<품목 코드>-01`. 칸이 50자라 품목 코드가 44자를 넘으면 만들지 않는다. */
export function autoRoutingCode(itemCode: string): string {
  const code = `RT-${itemCode}-01`;
  if (code.length > 50) throw new Error(`품목 코드가 길어 Routing 코드(${code})를 만들 수 없습니다 — 50자까지입니다.`);
  return code;
}

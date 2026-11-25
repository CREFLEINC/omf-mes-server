import { Prisma } from '@prisma/client';

type Db = Pick<Prisma.TransactionClient, 'routing_operation'>;

/**
 * Routing 의 마지막 공정인가 — 공정 순번이 가장 큰 것(의존 그래프는 보지 않는다).
 * ERP 생산입고(마지막 공정 W/O 만 보냄)와 배포의 LOT 유형(마지막이 아니면 반제품 · 피처 016 R-2)이 같은 답을
 * 봐야 「제품 LOT = ERP 로 가는 W/O 의 LOT」이 맞는다 — 그래서 한자리에 둔다.
 */
export async function isLastOperation(
  db: Db,
  operation: { routing_id: bigint; operation_seq: number },
): Promise<boolean> {
  const last = await db.routing_operation.aggregate({
    where: { routing_id: operation.routing_id },
    _max: { operation_seq: true },
  });
  return last._max.operation_seq === operation.operation_seq;
}

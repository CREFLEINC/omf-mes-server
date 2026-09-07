import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * ERP 아웃박스 적재 코어(I-6.md R-11) — 호출자가 연 트랜잭션 안에 `integration_message`
 * 한 줄을 세우는 것만 한다. 사용처가 두 도메인(생산 `:close` · 출하 확정 I-23)이라
 * `src/integration/message/` 가 아니라 여기 선다 — 거기 두면 생산이 연계 도메인의
 * service 를 부르게 된다(`server-architecture.md` 「도메인이 다른 도메인의 service 를
 * 부르지 않는다」).
 */

/** 계약 `IntegrationMessage.directionCode` enum — 이 함수는 나가는 메시지만 적재한다. */
export const OUTBOX_DIRECTION = 'OUTBOUND';
/**
 * 적재 직후 상태. `MESSAGE_STATUS.PENDING`(`integration-message.service.ts`) 과 같은 값이고
 * 시드 `INTEGRATION_MESSAGE_STATUS` 4값 중 하나다.
 * ⛔ 그 파일을 import 하지 않는다 — 코어가 도메인을 의존하게 된다.
 */
export const OUTBOX_PENDING = 'PENDING';
/** W/O 마감 송신 인터페이스. ⚠ `interface_definition` 0행 — 문의 037-b(알려둘 것). */
export const IF_WO_CLOSE = 'IF-WO-CLOSE-SEND';

export type Tx = Prisma.TransactionClient;

export interface OutboxEnqueueInput {
  interfaceCode: string;
  messageKey: string;
  targetTypeCode: string;
  targetId: bigint;
  /** ⛔ 서버가 값을 해석하지 않는다 — 받은 그대로 싣는다(I-6.md §5-6). */
  payload: Prisma.InputJsonValue;
}

/**
 * `message_key` 규약 — `{인터페이스}:{문서번호}`.
 * ⭐ **버전을 안 붙인다** — 재마감이 금지(R83)이고 `trg_work_order_closed_immutable` 이
 * 물리로 막으므로 한 W/O 는 평생 한 번만 적재된다.
 * ⚠ 키 규약이 두 갈래다 — 평생 1회 송신(I-6·I-23)은 문서번호까지, 되풀이 가능한 요청
 * (I-24 `:resync`)은 호출부에서 멱등키를 덧붙인다.
 */
export function outboxMessageKey(interfaceCode: string, documentNo: string): string {
  return `${interfaceCode}:${documentNo}`;
}

@Injectable()
export class OutboxService {
  /**
   * ⛔ 개발품 제외 판정을 두지 않는다 — `mdm.item` 에 그 칸이 없고 계약이 「전건 적재」로
   *    물러났다(I-6.md §5-6). 분기 자체를 만들지 않는다.
   * ⛔ `interface_definition` 을 읽지 않는다(0행).
   * ⛔ INSERT 의 P2002 를 잡아 되읽는 길은 abort 된 tx 안이라 25P02 로 막힌다(리뷰 #217) —
   *    INSERT «앞»의 선조회가 흡수 자리다. 경합의 마지막 그물은 `message_key @unique` 이고
   *    그때의 P2002 는 공용 그물이 409 로 낸다(여기서 잡지 않는다).
   */
  async enqueue(
    tx: Tx,
    input: OutboxEnqueueInput,
  ): Promise<{ integrationMessageId: bigint; alreadyQueued: boolean }> {
    const queued = await tx.integration_message.findUnique({
      where: { message_key: input.messageKey },
      select: { integration_message_id: true },
    });
    if (queued !== null) {
      return { integrationMessageId: queued.integration_message_id, alreadyQueued: true };
    }

    // `retry_count`·`created_at`·`available_at` 은 쓰지 않는다 — DB 기본값이 답이다.
    const created = await tx.integration_message.create({
      data: {
        message_key: input.messageKey,
        interface_code: input.interfaceCode,
        direction_code: OUTBOX_DIRECTION,
        target_type_code: input.targetTypeCode,
        target_id: input.targetId,
        payload: input.payload,
        status_code: OUTBOX_PENDING,
      },
      select: { integration_message_id: true },
    });
    return { integrationMessageId: created.integration_message_id, alreadyQueued: false };
  }
}

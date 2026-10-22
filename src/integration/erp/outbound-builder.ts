import { Prisma } from '@prisma/client';

import { RowDraft } from './outbound-rows';

/** 보낼 일 하나 — 아웃박스(`integration_message`)에 적힌 묶음(W/O 마감 하나 같은). */
export interface OutboundMessage {
  id: bigint;
  interfaceCode: string;
  targetTypeCode: string;
  targetId: bigint;
  payload: Prisma.JsonValue;
}

/**
 * 묶음 하나를 중계 DB 행으로 바꾼다 — 인터페이스마다 하나. 보낼 때 MES DB 를 읽어 바꾼다(아웃박스엔 무엇을 보낼지만 있다).
 * 바꿀 수 없으면(ERP 값 짝이 없다 등) 사유를 담아 던진다 — 그 메시지만 실패로 남고 사람이 고친 뒤 재처리한다.
 * `[]` 를 돌려주면 보낼 것이 없다는 뜻이다(바로 완료).
 */
export interface OutboundBuilder {
  interfaceCode: string;
  build(message: OutboundMessage): Promise<RowDraft[]>;
}

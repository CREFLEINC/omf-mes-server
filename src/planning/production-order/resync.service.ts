import { Injectable, NotFoundException } from '@nestjs/common';

import { OutboxService, outboxMessageKey } from '../../core/outbox';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * ERP 재동기 요청 인터페이스. ⚠ `interface_definition` 은 0행이고 정의 행을 만들지
 * 않는다 — 기존 문의 #66 이 그 표의 주인을 아직 정하지 못했다(I-6 과 같은 자리).
 */
const IF_PO_RESYNC = 'IF-PO-RESYNC-REQUEST';
/** 시드 `INTERFACE_TARGET` 5값 밖이나 그룹이 열려 있다 — I-6 이 `'WORK_ORDER'` 로 선례를 만들었다. */
const PRODUCTION_ORDER_TARGET = 'PRODUCTION_ORDER';

/**
 * `POST …:resync` — 202 접수 + `integration.integration_message` 한 줄까지다(부분 건너뜀 ·
 * 전송기 없음). ⚠ `direction_code='OUTBOUND'` 인데 뜻은 「우리가 ERP 에 «다시 보내 달라»고
 * 요청한다」다 — 나가는 메시지가 맞다.
 */
@Injectable()
export class ResyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  async resync(productionOrderId: number, idempotencyKey: string): Promise<void> {
    const order = await this.prisma.production_order.findUnique({
      where: { production_order_id: BigInt(productionOrderId) },
      select: { production_order_no: true, erp_order_no: true },
    });
    if (order === null) throw new NotFoundException('없는 생산오더입니다.');

    await this.prisma.$transaction((tx) =>
      this.outbox.enqueue(tx, {
        interfaceCode: IF_PO_RESYNC,
        // ⭐ 문서번호가 아니라 **id + 멱등키**다 — `message_key` 는 `VarChar(150)` 인데
        //    `production_order_no` 가 `VarChar(100)` 이라 문서번호로 이으면 최악 159자로 넘친다.
        //    멱등키를 덧붙이는 이유는 `outbox.service.ts:34-40` 주석에 적었다.
        messageKey: `${outboxMessageKey(IF_PO_RESYNC, String(productionOrderId))}:${idempotencyKey}`,
        targetTypeCode: PRODUCTION_ORDER_TARGET,
        targetId: BigInt(productionOrderId),
        // ⛔ 서버가 값을 해석하지 않는다.
        payload: {
          productionOrderNo: order.production_order_no,
          erpOrderNo: order.erp_order_no,
          requestedAt: new Date().toISOString(),
        },
      }),
    );
  }
}

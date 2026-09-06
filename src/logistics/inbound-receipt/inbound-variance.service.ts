import { Injectable, NotFoundException } from '@nestjs/common';

import { assertCodeValues } from '../../common/master';
import { PrismaService } from '../../prisma/prisma.service';
import { InboundVarianceView, inboundVarianceView } from './inbound-variance-view';

/** 계약 `InboundVarianceCreate`. ⛔ `approvalRequestId` 는 요청 칸이 아니다 — 채우는 경로가
 *  계약에 0건이라 늘 널로 선다(I-3.md §5-1). */
export interface InboundVarianceCreateInput {
  varianceTypeCode: string;
  varianceQty: number;
  uomId: number;
  /** ⛔ 「선택이다 — 현장이 사유를 모를 때 오류 기록 자체가 막히면 안 된다」(계약). */
  reasonCode?: string | null;
}

/** 입하 차이 조회·등록 — 화면 `M-01-06`. 「한 번 등록하면 고칠 수 없다」(계약)라 수정·삭제가 없다. */
@Injectable()
export class InboundVarianceService {
  constructor(private readonly prisma: PrismaService) {}

  /** ⛔ 기록 전용이다 — `received_qty`·라인 상태·LOT·원장 어느 것도 안 움직인다. 「상태: 보류」는
   *  LOT 축(`lot_hold`)이 이미 진다(`M-01-06` §8 #2-b). ⛔ `varianceQty` 상한도 없다 — 무발주
   *  라인에는 비교할 축이 아예 없다(I-3.md §4-4). */
  async create(
    inboundReceiptLineId: number,
    input: InboundVarianceCreateInput,
    appUserId: number,
  ): Promise<InboundVarianceView> {
    const line = await this.prisma.inbound_receipt_line.findUnique({
      where: { inbound_receipt_line_id: inboundReceiptLineId },
      select: { inbound_receipt_line_id: true },
    });
    // 계약이 이 경로에 404 를 선언하지 않았다 — 없는 라인의 차이를 만들 수는 없다(알려둘 것).
    if (line === null) throw new NotFoundException('없는 입하 라인입니다.');

    await assertCodeValues(this.prisma, [
      { field: 'varianceTypeCode', value: input.varianceTypeCode, groupCode: 'INBOUND_VARIANCE_TYPE' },
      { field: 'reasonCode', value: input.reasonCode, groupCode: 'INBOUND_VARIANCE_REASON' },
    ]);

    const row = await this.prisma.inbound_variance.create({
      data: {
        inbound_receipt_line_id: line.inbound_receipt_line_id,
        variance_type_code: input.varianceTypeCode,
        variance_qty: input.varianceQty,
        uom_id: input.uomId,
        reason_code: input.reasonCode ?? null,
        // 주체는 계정 세션이다 — `X-Worker-No` 는 덧붙임이라 없어도 400 이 아니다(§6-4).
        created_by: BigInt(appUserId),
      },
    });
    return inboundVarianceView(row);
  }

  /** 없는 라인이면 빈 배열이다 — 계약이 이 경로에 404 를 선언하지 않았다(P/O `lines()` 선례). */
  async list(inboundReceiptLineId: number): Promise<InboundVarianceView[]> {
    const rows = await this.prisma.inbound_variance.findMany({
      where: { inbound_receipt_line_id: inboundReceiptLineId },
      orderBy: { inbound_variance_id: 'asc' },
    });
    return rows.map(inboundVarianceView);
  }
}

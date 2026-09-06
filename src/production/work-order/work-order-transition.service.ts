import { HttpStatus, Injectable } from '@nestjs/common';

import { assertNotBlank } from '../../common/master';
import { DocumentStateService } from '../../core/document-state';
import { PrismaService } from '../../prisma/prisma.service';
import { assertVersion, lockWorkOrder } from './work-order-write.service';

/** 계약 `WorkOrderHold` — 셋 다 «저장하지 않는다»(담을 칸이 없다 · 문의 035). */
export interface WorkOrderHold {
  reasonCode: string;
  occurredAt: string;
  note?: string;
}

/** 계약 `WorkOrderResume` — 마찬가지로 저장할 칸이 없다. */
export interface WorkOrderResume {
  occurredAt: string;
  note?: string;
}

const STATUS_COLUMN = 'production.work_order.status_code';

/**
 * W/O 층의 중단·재개. ⭐ **세션에 손대지 않는다** — 계약이 두 번 못박았다(⌜세션은 닫지
 * 않는다⌝·⌜세션은 다시 열지 않는다⌝). 세션 구간 «안»의 STOP·RESUME 은 다른 축이고
 * `POST /production/work-sessions/{id}/events` 가 진다(I-11).
 *
 * ⚠ 저장할 칸이 하나도 없다 — `work_order` 에 사유·발생시각·비고 칸이 없고 W/O 층의 중단
 * 구간 표도 저장소에 0개다. 표를 만들지 않고 상태만 옮긴다(문의 035 · §6-2 ⓐ).
 * ⚠ `X-Worker-No` 를 읽지 않는다 — 담을 칸이 없고 없어도 400 이 아니다(§6-2 ⓔ).
 */
@Injectable()
export class WorkOrderTransitionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentState: DocumentStateService,
  ) {}

  async hold(
    workOrderId: number,
    version: number | undefined,
    body: WorkOrderHold,
    appUserId?: number,
  ): Promise<void> {
    // ⛔ `assertCodeValues` 를 걸지 않는다 — `WORK_ORDER_HOLD_REASON` 그룹에 값이 0건이라
    //    대조를 켜면 «모든» `:hold` 가 400 이 된다. 값이 오면 그때 켠다(문의 035 ⓓ).
    //    `occurredAt` 은 계약 검증(`format: date-time`)이 이미 봤다 — 다시 파싱하지 않는다.
    assertNotBlank([['reasonCode', body.reasonCode]]);
    await this.move(workOrderId, version, 'work-order-hold', appUserId);
  }

  resume(
    workOrderId: number,
    version: number | undefined,
    appUserId?: number,
  ): Promise<void> {
    return this.move(workOrderId, version, 'work-order-resume', appUserId);
  }

  /** 순서: 잠금 → (선택) 버전 대조 → 전이 판정 → 상태·버전·수정자만 쓴다. 404 가 전이보다 앞이다. */
  private async move(
    workOrderId: number,
    version: number | undefined,
    action: string,
    appUserId: number | undefined,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockWorkOrder(tx, workOrderId);
      assertVersion(locked, version);
      // ⛔ 400 이다 — 409 는 If-Match 저장 충돌이 쓴다(§1-6 · `approval.service.ts:263`).
      const transition = this.documentState.assertTransition(
        STATUS_COLUMN,
        action,
        locked.status_code,
        HttpStatus.BAD_REQUEST,
      );

      await tx.work_order.update({
        where: { work_order_id: BigInt(workOrderId) },
        // `updated_at` 은 트리거가 찍는다 — `updated_by` 를 같이 쓰지 않으면 두 감사 칸이 어긋난다.
        data: {
          status_code: transition.to,
          version_no: { increment: 1 },
          updated_by: appUserId ?? null,
        },
      });
    });
  }
}

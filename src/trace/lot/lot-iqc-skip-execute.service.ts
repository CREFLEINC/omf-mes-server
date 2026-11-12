import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { INSPECTION_HOLD_REASON, LotHoldService, LotQualityStatusService, Tx } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { recordInspectionRequestEvent } from '../../quality/inspection/inspection-request-event';
import { IQC_SKIP_TARGET_TYPE, IQC_SKIP_TYPE, lockSkipTarget } from './lot-iqc-skip.service';

const APPROVED = 'APPROVED';
const SKIP_RELEASE_REASON = 'INCOMING_INSPECTION_SKIPPED';
/** 아직 검사가 끝나지 않은 의뢰만 닫는다 — 확정·취소된 것은 그대로다. */
const OPEN_REQUEST_STATUSES = ['REQUESTED', 'IN_PROGRESS'];
const SKIPPED = 'SKIPPED';

const isVoided = (summary: Prisma.JsonValue): boolean =>
  typeof summary === 'object' && summary !== null && !Array.isArray(summary) && summary.voidedAt != null;
const stateLocked = (message: string): ContractException =>
  new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message }]);

/**
 * 승인된 긴급 IQC 생략의 «실행»(omf-all-around#105 · 장부 P-36). 요청(`requestSkip`)과 승인은
 * LOT 을 옮기지 않는다(공유계약 J-8) — 승인 뒤 이 액션이 의뢰·보류·LOT 을 한 트랜잭션에서 옮긴다.
 * 경로의 LOT 은 «그 입하 LOT» 을 가리킨다(피처 005 FR-032 · R-16) — 입하 LOT 의 IQC 요청을 `SKIPPED`, 자재 관리 LOT 전부 C22.
 *
 * ⭐ 합격 확정(`inspection-confirm.service.ts` `moveTargetLot`)과 같은 규율: 수입검사 보류만 닫고,
 *    다른 열린 보류(의심자재 등)가 남아 있으면 LOT 을 정상으로 «올리지 않는다».
 */
@Injectable()
export class LotIqcSkipExecuteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly holds: LotHoldService,
    private readonly qualities: LotQualityStatusService,
  ) {}

  async execute(lotId: number, appUserId: number): Promise<{ inboundLotNo: string; lotCount: number }> {
    return this.prisma.$transaction(async (tx) => {
      const target = await lockSkipTarget(tx, lotId, 'execute');
      // 이전된 옛 요청은 LOT 대상(`lot_id`)이고 입하 LOT 칸이 빈 것도 있다 — 둘 다 이 입하 LOT 의 요청이다.
      const requestWhere = {
        inspection_type_code: 'IQC', status_code: { in: OPEN_REQUEST_STATUSES },
        OR: [{ inbound_lot_id: target.inboundLotId }, { lot_id: { in: target.lotIds } }],
      };
      // ⛔ IQC 의뢰가 아직 열려 있어야 한다(#105 리뷰) — 보류(HELD)로 확정돼 끝난 의뢰나 이미 생략된 의뢰에 승인을 쓰면
      //    판정을 건너뛰고 정상이 된다. 생략이 의뢰를 SKIPPED 로 닫으므로 같은 승인의 재사용도 여기서 막힌다.
      const openRequests = await tx.inspection_request.findMany({
        where: requestWhere, select: { inspection_request_id: true, status_code: true },
      });
      if (openRequests.length === 0) throw stateLocked('이 입하 LOT 의 IQC 검사가 이미 끝났거나 생략돼 생략을 실행할 수 없습니다.');
      // 마감 취소가 무효로 만든 결재(`voidedAt`)는 다시 쓰지 않는다.
      const approved = await tx.approval_request.findMany({
        where: { approval_type_code: IQC_SKIP_TYPE, target_type_code: IQC_SKIP_TARGET_TYPE, target_id: target.inboundLotId, status_code: APPROVED },
        select: { approval_request_id: true, target_summary: true },
        orderBy: { approval_request_id: 'desc' },
      });
      const approval = approved.find((row) => !isVoided(row.target_summary));
      if (approval === undefined) {
        throw stateLocked(approved.length > 0
          ? '입하 마감 취소로 무효가 된 IQC 생략 승인입니다 — 다시 생략을 요청하세요.'
          : '승인된 IQC 생략 요청이 없습니다.');
      }

      const changedAt = new Date();
      const by = BigInt(appUserId);
      await tx.inspection_request.updateMany({
        where: requestWhere,
        data: { status_code: SKIPPED, skip_basis_code: 'APPROVAL', updated_by: by, version_no: { increment: 1 } },
      });
      for (const open of openRequests) {
        await recordInspectionRequestEvent(tx, {
          inspectionRequestId: open.inspection_request_id, eventTypeCode: 'SKIPPED', actor: { appUserId }, at: changedAt,
          summaryBefore: { statusCode: open.status_code },
          summaryAfter: { statusCode: SKIPPED, approvalRequestId: Number(approval.approval_request_id) },
        });
      }
      const locked = await this.holds.lockLotsWithin(tx, target.lotIds);
      for (const lotId of target.lotIds) {
        const { openAfter } = await this.holds.releaseWithin(
          tx, locked, { lotId, reasonCode: INSPECTION_HOLD_REASON }, { releaseReasonCode: SKIP_RELEASE_REASON }, { by, at: changedAt },
        );
        // 다른 보류가 남으면 성공으로 내지 않는다 — 200 인데 LOT 이 검사 대기 그대로면 실행된 줄 안다. 던져서 전부 되돌린다(#105 리뷰).
        if (openAfter > 0) throw stateLocked('다른 보류가 남아 있어 정상으로 옮기지 못했습니다. 그 보류를 먼저 해제하세요.');
      }
      await this.qualities.moveWithin(tx, target.lotIds, 'iqc-skipped', { changedBy: by, changedAt });
      return { inboundLotNo: target.inboundLotNo, lotCount: target.lotIds.length };
    });
  }
}

/**
 * 입하 마감 취소가 생략을 무효로 만들었다는 표시 — 결재 상태 값에 「무효」가 없어(PENDING·APPROVED·REJECTED) 대상 요약에 남긴다
 * (피처 005 R-5a). 대상은 입하 LOT 이다(FR-032). 실행한 승인·실행 전 승인 모두 — 이미 무효인 것은 처음 시각을 둔다.
 */
export async function markIqcSkipVoided(tx: Tx, inboundLotId: bigint, at: Date): Promise<void> {
  await tx.$executeRaw`
    UPDATE app.approval_request
       SET target_summary = COALESCE(target_summary, '{}'::jsonb)
                            || jsonb_build_object('voidedAt', ${at.toISOString()}::text, 'voidedBy', 'RECEIPT_REOPENED'),
           updated_at = clock_timestamp(), version_no = version_no + 1
     WHERE approval_type_code = ${IQC_SKIP_TYPE} AND target_type_code = ${IQC_SKIP_TARGET_TYPE}
       AND status_code = ${APPROVED} AND target_id = ${inboundLotId}
       AND (target_summary ->> 'voidedAt') IS NULL`;
}

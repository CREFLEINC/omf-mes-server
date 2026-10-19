import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { INSPECTION_HOLD_REASON, LotHoldService, LotQualityStatusService, Tx } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { assertSkippable, LotQualification } from './lot-iqc-skip.service';

const IQC_SKIP_TYPE = 'IQC_SKIP';
const IQC_SKIP_TARGET_TYPE = 'INBOUND_LOT';
const APPROVED = 'APPROVED';
const SKIP_RELEASE_REASON = 'INCOMING_INSPECTION_SKIPPED';
/** 아직 검사가 끝나지 않은 의뢰만 닫는다 — 확정·취소된 것은 그대로다. */
const OPEN_REQUEST_STATUSES = ['REQUESTED', 'IN_PROGRESS'];
const SKIPPED = 'SKIPPED';

/**
 * 승인된 긴급 IQC 생략의 «실행»(omf-all-around#105 · 장부 P-36). 요청(`requestSkip`)과 승인은
 * LOT 을 옮기지 않는다(공유계약 J-8) — 승인 뒤 이 액션이 의뢰·보류·LOT 을 한 트랜잭션에서 옮긴다.
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

  async execute(lotId: number, appUserId: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const lot = await lockLot(tx, lotId);
      assertSkippable(lot, 'execute');
      // ⛔ IQC 의뢰가 아직 열려 있어야 한다(#105 리뷰) — 보류(HELD)로 확정돼 끝난 의뢰나 이미 생략된 의뢰에 승인을 쓰면
      //    판정을 건너뛰고 정상이 된다. 생략이 의뢰를 SKIPPED 로 닫으므로 같은 승인의 재사용도 여기서 막힌다.
      const openRequests = await tx.inspection_request.count({
        where: { lot_id: BigInt(lotId), inspection_type_code: 'IQC', status_code: { in: OPEN_REQUEST_STATUSES } },
      });
      if (openRequests === 0) {
        throw new ContractException(HttpStatus.BAD_REQUEST, [
          {
            scope: 'screen',
            code: ERROR_CODE.STATE_LOCKED,
            message: '이 LOT 의 IQC 검사가 이미 끝났거나 생략돼 생략을 실행할 수 없습니다.',
          },
        ]);
      }
      const approval = await tx.approval_request.findFirst({
        where: {
          approval_type_code: IQC_SKIP_TYPE,
          target_type_code: IQC_SKIP_TARGET_TYPE,
          target_id: BigInt(lotId),
          status_code: APPROVED,
        },
        select: { approval_request_id: true },
      });
      if (approval === null) {
        throw new ContractException(HttpStatus.BAD_REQUEST, [
          { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '승인된 IQC 생략 요청이 없습니다.' },
        ]);
      }

      const changedAt = new Date();
      const by = BigInt(appUserId);
      await tx.inspection_request.updateMany({
        where: { lot_id: BigInt(lotId), inspection_type_code: 'IQC', status_code: { in: OPEN_REQUEST_STATUSES } },
        data: { status_code: SKIPPED, updated_by: by, version_no: { increment: 1 } },
      });
      const locked = await this.holds.lockLotsWithin(tx, [BigInt(lotId)]);
      const { openAfter } = await this.holds.releaseWithin(
        tx,
        locked,
        { lotId: BigInt(lotId), reasonCode: INSPECTION_HOLD_REASON },
        { releaseReasonCode: SKIP_RELEASE_REASON },
        { by, at: changedAt },
      );
      // 다른 보류가 남으면 성공으로 내지 않는다 — 200 인데 LOT 이 검사 대기 그대로면 실행된 줄 안다. 던져서 전부 되돌린다(#105 리뷰).
      if (openAfter > 0) {
        throw new ContractException(HttpStatus.BAD_REQUEST, [
          {
            scope: 'screen',
            code: ERROR_CODE.STATE_LOCKED,
            message: '다른 보류가 남아 있어 정상으로 옮기지 못했습니다. 그 보류를 먼저 해제하세요.',
          },
        ]);
      }
      await this.qualities.moveWithin(tx, [BigInt(lotId)], 'iqc-skipped', { changedBy: by, changedAt });
    });
  }
}

/** ⛔ `FOR UPDATE` — 같은 LOT 의 확정·보류와 겹치면 옛 상태로 판정한다. */
async function lockLot(tx: Tx, lotId: number): Promise<LotQualification> {
  const rows = await tx.$queryRaw<LotQualification[]>`
    SELECT source_type_code, status_code
      FROM trace.lot
     WHERE lot_id = ${BigInt(lotId)}
       FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('없는 LOT 입니다.');
  return rows[0];
}

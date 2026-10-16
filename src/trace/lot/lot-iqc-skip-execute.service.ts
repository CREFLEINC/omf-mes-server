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
      assertSkippable(lot);
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
      if (openAfter > 0) return;
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

import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { Tx } from '../../core/lot';

/**
 * 실적 정정 승인 상신 — 더 받지 않는다(장부 P-120). 마감 전 수량 정정은 승인 없이 사유만으로 저장하고, 마감 뒤에는
 * 정정 자체를 막는다. 상신이 남으면 결재함에 「승인해도 아무것도 안 바뀌는」 요청이 쌓인다.
 */
@Injectable()
export class ProductionResultApprovalService {
  requestApproval(): Promise<{ approvalRequestId: number }> {
    return Promise.reject(new ContractException(HttpStatus.BAD_REQUEST, [{
      scope: 'screen', code: ERROR_CODE.INVALID,
      message: '수량 정정은 승인 없이 사유만으로 저장합니다 — 정정 화면에서 바로 저장하세요.',
    }]));
  }
}

/** 대상 행 잠금. 밖에서 존재를 이미 봤으므로 사라진 경우만 404 로 되돌린다. */
export async function lockResult(tx: Tx, productionResultId: number): Promise<void> {
  const rows = await tx.$queryRaw<{ production_result_id: bigint }[]>`
    SELECT production_result_id
      FROM production.production_result
     WHERE production_result_id = ${BigInt(productionResultId)}
       FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('없는 생산 실적입니다.');
}

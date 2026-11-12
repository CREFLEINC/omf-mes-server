import { HttpStatus, Injectable } from '@nestjs/common';

import { ConflictException, ContractException, ErrorItem, ERROR_CODE, field } from '../../common/errors';
import {
  issueMaterialLotBatchWithin,
  type MaterialLotBatchActor,
  type MaterialLotBatchInput,
  MATERIAL_LOT_BATCH_SOURCE,
} from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { assertDay, assertInstant, isDuplicateLotNo } from '../../trace/lot/lot-rules';
import type { MaterialLotWriteActor } from '../../auth/terminal-material-lot-scope';
import { loadMaterialLotSummaries, type MaterialLotSummaryView } from './material-lot-view';

/** 계약 `MaterialLotBatchCreate`. 입하 LOT 을 받지 않는다 — 발행 단위는 공급사·품목이다. */
export interface MaterialLotBatchCreate extends MaterialLotBatchInput {
  occurredAt: string;
}

export interface MaterialLotBatchCreated {
  batchId: number;
  lots: MaterialLotSummaryView[];
}

/** 같은 (품목·수량·날짜·공급사) 일련이 동시에 부딪히면 다시 뽑는다 — 사용자가 고칠 값이 아니다. */
const NUMBER_RETRY = 3;

/** 자재 관리 LOT 발행(POP P-01-01 · 웹 W-01-14). 채널은 호출자로 정한다 — 단말이면 POP, 계정이면 WEB. */
@Injectable()
export class MaterialLotBatchService {
  constructor(private readonly prisma: PrismaService) {}

  async create(body: MaterialLotBatchCreate, actor: MaterialLotWriteActor): Promise<MaterialLotBatchCreated> {
    const errors: ErrorItem[] = [];
    assertDay('businessDate', body.businessDate, errors);
    assertInstant('occurredAt', body.occurredAt, errors);
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
    const batchActor: MaterialLotBatchActor = actor.appUserId !== undefined
      ? { channel: 'WEB', appUserId: actor.appUserId }
      : { channel: 'POP', workerId: actor.workerId, terminalAudit: actor.terminalAudit };

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const created = await issueMaterialLotBatchWithin(tx, body, batchActor);
          const lots = await loadMaterialLotSummaries(tx, {
            source_type_code: MATERIAL_LOT_BATCH_SOURCE, source_id: created.batchId,
          }, [{ lot_id: 'asc' }]);
          return { batchId: Number(created.batchId), lots };
        });
      } catch (error) {
        if (!isDuplicateLotNo(error)) throw error;
        if (attempt >= NUMBER_RETRY) {
          throw new ConflictException('user', 'LOT 번호를 매기지 못했습니다. 다시 시도해 주세요.');
        }
      }
    }
  }
}

export function invalidQuery(name: string, message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [field(name, ERROR_CODE.INVALID, message)]);
}

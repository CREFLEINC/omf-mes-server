import { Injectable } from '@nestjs/common';

import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';
import type { MaterialLotWriteActor } from '../../auth/terminal-material-lot-scope';
import { LotLifecycleService, voidMaterialLotsWithin } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';

/** 계약 `MaterialLotVoidResult` — 건별 결과. */
export interface MaterialLotVoidResult {
  items: { lotId: number; lotNo: string; voided: boolean; errorCode: string | null }[];
}

/** 대기 자재 관리 LOT 폐기(`POST /trace/lots:void` · POP P-01-01 · 웹 W-01-14). */
@Injectable()
export class LotVoidService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: LotLifecycleService,
  ) {}

  async void(lotIds: number[], actor: MaterialLotWriteActor): Promise<MaterialLotVoidResult> {
    return this.prisma.$transaction(async (tx) => {
      const outcomes = await voidMaterialLotsWithin(tx, this.lifecycle, lotIds.map(BigInt), new Date());
      if (actor.terminalAudit !== undefined) {
        for (const outcome of outcomes.filter((row) => row.voided)) {
          await recordTerminalWorkerAudit(tx, {
            actor: actor.terminalAudit, targetTypeCode: 'LOT', targetId: outcome.lotId, eventTypeCode: 'VOIDED',
          });
        }
      }
      return { items: outcomes.map((row) => ({ ...row, lotId: Number(row.lotId) })) };
    });
  }
}

import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';
import type { MaterialLotWriteActor } from '../../auth/terminal-material-lot-scope';
import { ContractException } from '../../common/errors';
import { reviseMaterialLotWithin, type MaterialPackageInput } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { isDuplicateLotNo } from '../../trace/lot/lot-rules';
import { MaterialLotTabService, type MaterialLotTabRowView } from './material-lot-tab.service';

/** 계약 `MaterialLotRevise`. `package: null` = 패키징 없음. */
export interface MaterialLotRevise {
  qty: number;
  package: MaterialPackageInput | null;
}

const NUMBER_RETRY = 3;
const AUDIT_EVENT = 'MATERIAL_LOT_REVISED';

/**
 * 출력 전 자재 관리 LOT 수정(피처 014 FR-016·017 · P-01-01 · W-01-14). 바꾼 사실(옛·새 번호·수량·패키징)을 감사에 남긴다 —
 * 계정이면 `performed_by`, 단말이면 단말·작업자(지금 수동 생성이 쓰는 단말 작업자 감사도 함께).
 */
@Injectable()
export class MaterialLotReviseService {
  constructor(private readonly prisma: PrismaService, private readonly tabs: MaterialLotTabService) {}

  async revise(lotId: number, body: MaterialLotRevise, actor: MaterialLotWriteActor): Promise<MaterialLotTabRowView> {
    const lot = await this.prisma.lot.findUnique({ where: { lot_id: lotId }, select: { plant_id: true } });
    if (lot === null) throw new NotFoundException('없는 LOT 입니다.');
    const businessDate = await this.tabs.plantToday(Number(lot.plant_id));
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const before = await tx.lot.findUniqueOrThrow({
            where: { lot_id: lotId }, select: { initial_qty: true, package_count: true, qty_per_package: true, package_uom_id: true },
          });
          const revised = await reviseMaterialLotWithin(tx, BigInt(lotId), { qty: body.qty, package: body.package, businessDate });
          await tx.audit_event.create({ data: {
            occurred_at: new Date(), target_type_code: 'LOT', target_id: BigInt(lotId), event_type_code: AUDIT_EVENT,
            performed_by: actor.appUserId === undefined ? null : BigInt(actor.appUserId),
            terminal_id: actor.terminalAudit?.terminalId ?? null, correlation_id: actor.terminalAudit?.correlationId ?? null,
            before_value: { lotNo: revised.oldLotNo, qty: Number(before.initial_qty), package: before.package_uom_id === null ? null : {
              uomId: Number(before.package_uom_id), count: before.package_count, qtyPerPackage: Number(before.qty_per_package) } },
            after_value: { lotNo: revised.lotNo, qty: body.qty, package: body.package, workerNo: actor.terminalAudit?.workerNo ?? null } as Prisma.InputJsonValue,
          } });
          if (actor.terminalAudit !== undefined) {
            await recordTerminalWorkerAudit(tx, { actor: actor.terminalAudit, targetTypeCode: 'LOT', targetId: BigInt(lotId), eventTypeCode: AUDIT_EVENT });
          }
        });
        return await this.tabs.lotRow(BigInt(lotId));
      } catch (error) {
        if (!isDuplicateLotNo(error)) throw error;
        if (attempt >= NUMBER_RETRY) {
          throw new ContractException(HttpStatus.CONFLICT, [
            { scope: 'screen', code: 'LOT_NO_CONFLICT', message: 'LOT 번호를 매기지 못했습니다. 다시 시도해 주세요.' },
          ]);
        }
      }
    }
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';
import { ConflictException, ERROR_CODE, field, one } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import type { LogisticsWriteActor } from '../logistics-write-actor';
import { ShipmentRequestQueryService } from './shipment-request-query.service';
import { ShipmentRequestLotView } from './shipment-request-view';

/** 물리 `varchar(100)` — 넘기면 500 이라 앞당긴다(FR-020). */
export const MANAGEMENT_CODE_MAX = 100;

export interface ShipmentLotManagementCode {
  managementCode: string | null;
}

/**
 * 출하 관리 코드(피처 010 US5 · FR-020·021) — 피킹 LOT 마다 선택 값 하나. 스캔·직접 입력 둘 다 이 경로다.
 * ⭐ 중복·형식 검사 없음(같은 코드를 다른 LOT 에 넣어도 된다). 빈 글자·null 은 지운다. PICKED 일 때만 고친다 — 출하 완료(SHIPPED)·교체(REPLACED)
 *    뒤는 409. 출하 완료 때 그 값이 출하 내역의 LOT 배분 줄에 그대로 보인다(S5·S6).
 */
@Injectable()
export class ShipmentLotCodeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queries: ShipmentRequestQueryService,
  ) {}

  async save(shipmentRequestLotId: number, body: ShipmentLotManagementCode, actor: LogisticsWriteActor): Promise<ShipmentRequestLotView> {
    const code = body.managementCode === null || body.managementCode.trim() === '' ? null : body.managementCode.trim();
    if (code !== null && code.length > MANAGEMENT_CODE_MAX) {
      throw one(field('managementCode', ERROR_CODE.RANGE, `${MANAGEMENT_CODE_MAX}자까지 넣을 수 있습니다.`));
    }
    const requestId = await this.prisma.$transaction(async (tx) => {
      const [lot] = await tx.$queryRaw<{ status_code: string; shipment_request_id: bigint }[]>`
        SELECT srl.status_code, l.shipment_request_id
          FROM logistics.shipment_request_lot srl
          JOIN logistics.shipment_request_line l ON l.shipment_request_line_id = srl.shipment_request_line_id
         WHERE srl.shipment_request_lot_id = ${shipmentRequestLotId}
           FOR UPDATE OF srl`;
      if (lot === undefined) throw new NotFoundException('없는 피킹 LOT 입니다.');
      if (lot.status_code !== 'PICKED') {
        throw new ConflictException('user', lot.status_code === 'SHIPPED'
          ? '출하가 완료된 LOT 의 출하 관리 코드는 고칠 수 없습니다.'
          : '교체한 LOT 의 출하 관리 코드는 고칠 수 없습니다.', { code: 'INVALID_STATE' });
      }
      await tx.shipment_request_lot.update({
        where: { shipment_request_lot_id: BigInt(shipmentRequestLotId) },
        data: {
          management_code: code,
          updated_by: actor.appUserId === undefined ? null : BigInt(actor.appUserId),
          updated_at: new Date(),
          version_no: { increment: 1 },
        } satisfies Prisma.shipment_request_lotUpdateInput,
      });
      if (actor.terminalAudit !== undefined) {
        await recordTerminalWorkerAudit(tx, {
          actor: actor.terminalAudit, targetTypeCode: 'SHIPMENT_REQUEST_LOT', targetId: BigInt(shipmentRequestLotId), eventTypeCode: 'MANAGEMENT_CODE',
        });
      }
      return lot.shipment_request_id;
    });
    const detail = await this.queries.get(Number(requestId));
    const view = (detail.lines ?? []).flatMap((line) => line.lots).find((lot) => lot.shipmentRequestLotId === shipmentRequestLotId);
    if (view === undefined) throw new Error('저장한 피킹 LOT 을 다시 읽지 못했다');
    return view;
  }
}

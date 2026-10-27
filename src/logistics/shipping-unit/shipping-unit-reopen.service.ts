import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';
import { ConflictException, ContractException, ERROR_CODE, field } from '../../common/errors';
import { assertNotBlank } from '../../common/master';
import { PrismaService } from '../../prisma/prisma.service';
import { CANCELLED, CONFIRMED, hasOpenCancel } from '../shipment/shipment-guards';
import { LogisticsWriteActor } from '../logistics-write-actor';
import { ShippingUnitQueryService } from './shipping-unit-query.service';
import { SHIPPING_UNIT_CLOSED, SHIPPING_UNIT_OPEN, ShippingUnitDetailView } from './shipping-unit-view';

export interface ShippingUnitReopen {
  reason: string;
}

export type ShippingUnitReopened = ShippingUnitDetailView & { deliveryLabelReissueNeeded: boolean };

interface LockedUnit {
  shipping_unit_id: bigint;
  shipping_unit_no: string;
  shipment_id: bigint;
  shipment_no: string;
  shipment_status_code: string;
  status_code: string;
  closed_at: Date | null;
  version_no: number;
}

/**
 * 마감한 출하 단위를 다시 연다(장부 P-124). 확정 전 출하에서만 — 확정은 ERP 로 보낸 뒤라 되돌릴 수 없다.
 * 다시 열면 상자를 빼서 포장을 고칠 수 있다. 마감 뒤 찍은 납품 라벨은 다시 마감한 뒤 재발행해야 한다.
 */
@Injectable()
export class ShippingUnitReopenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queries: ShippingUnitQueryService,
  ) {}

  async reopen(
    shippingUnitId: number,
    expectedVersion: number,
    body: ShippingUnitReopen,
    actor: LogisticsWriteActor,
    plantId: bigint | undefined,
  ): Promise<ShippingUnitReopened> {
    assertNotBlank([['reason', body.reason]]);
    const deliveryLabelReissueNeeded = await this.prisma.$transaction(async (tx) => {
      const unit = await lockUnit(tx, shippingUnitId);
      await assertReopenable(tx, unit);
      if (unit.version_no !== expectedVersion) {
        throw new ConflictException('user', '다른 사용자가 먼저 수정했습니다. 출하 단위를 다시 불러오세요.', {
          currentVersion: String(unit.version_no),
        });
      }

      await tx.shipping_unit.update({
        where: { shipping_unit_id: unit.shipping_unit_id },
        data: {
          status_code: SHIPPING_UNIT_OPEN,
          closed_at: null,
          closed_by: null,
          version_no: { increment: 1 },
          updated_by: actor.appUserId == null ? null : BigInt(actor.appUserId),
          updated_at: new Date(),
        },
      });
      const terminal = actor.terminalAudit;
      await tx.audit_event.create({ data: {
        occurred_at: new Date(),
        target_type_code: 'SHIPPING_UNIT',
        target_id: unit.shipping_unit_id,
        event_type_code: 'SHIPPING_UNIT_REOPENED',
        before_value: { statusCode: SHIPPING_UNIT_CLOSED, closedAt: unit.closed_at?.toISOString() ?? null },
        after_value: {
          statusCode: SHIPPING_UNIT_OPEN,
          ...(terminal === undefined ? {} : { workerId: terminal.workerId.toString(), workerNo: terminal.workerNo }),
        },
        reason: body.reason.trim(),
        performed_by: actor.appUserId == null ? null : BigInt(actor.appUserId),
        terminal_id: terminal?.terminalId ?? null,
        correlation_id: terminal?.correlationId ?? null,
      } });
      if (terminal !== undefined) {
        await recordTerminalWorkerAudit(tx, { actor: terminal, targetTypeCode: 'SHIPPING_UNIT', targetId: unit.shipping_unit_id });
      }
      // 출력 결과 칸이 생기기 전의 발행은 결과가 비어 있다 — 실패만 빼고 빈 것은 발행으로 센다.
      const labels = await tx.document_issue_log.count({
        where: {
          document_type_code: 'DELIVERY_LABEL',
          target_type_code: 'SHIPPING_UNIT',
          target_id: unit.shipping_unit_id,
          OR: [{ print_outcome_code: null }, { print_outcome_code: { not: 'FAILED' } }],
        },
      });
      return labels > 0;
    });
    const detail = await this.queries.get(shippingUnitId, plantId);
    return { ...detail, deliveryLabelReissueNeeded };
  }
}

async function lockUnit(tx: Prisma.TransactionClient, shippingUnitId: number): Promise<LockedUnit> {
  const rows = await tx.$queryRaw<LockedUnit[]>`
    SELECT u.shipping_unit_id, u.shipping_unit_no, u.shipment_id, s.shipment_no,
           s.status_code AS shipment_status_code, u.status_code, u.closed_at, u.version_no
      FROM logistics.shipping_unit u
      JOIN logistics.shipment s ON s.shipment_id = u.shipment_id
     WHERE u.shipping_unit_id = ${BigInt(shippingUnitId)}
       FOR UPDATE OF u`;
  if (rows[0] === undefined) throw new NotFoundException('없는 출하 단위입니다. 출하 단위 목록을 새로 고쳐 다시 고르세요.');
  return rows[0];
}

/** 상태가 «먼저»다 — 이미 열렸거나 출하가 끝난 단위에 낡은 If-Match 가 오면 화면이 띄울 말은 충돌이 아니라 그 상태다. */
async function assertReopenable(tx: Prisma.TransactionClient, unit: LockedUnit): Promise<void> {
  if (unit.status_code !== SHIPPING_UNIT_CLOSED) {
    throw locked('shippingUnitId', `출하 단위 ${unit.shipping_unit_no} 는 마감되지 않았습니다. 다시 열 필요 없이 상자를 넣고 빼면 됩니다.`);
  }
  if (unit.shipment_status_code === CONFIRMED) {
    throw locked('shipmentId', `출하 ${unit.shipment_no} 가 이미 확정돼 ERP 로 보냈습니다. 출하 단위 ${unit.shipping_unit_no} 를 다시 열 수 없습니다 — 수량이 다르면 반품으로 처리하세요.`);
  }
  if (unit.shipment_status_code === CANCELLED) {
    throw locked('shipmentId', `출하 ${unit.shipment_no} 가 취소됐습니다. 출하 단위 ${unit.shipping_unit_no} 를 다시 열 수 없습니다.`);
  }
  if (await hasOpenCancel(tx, unit.shipment_id)) {
    throw locked('shipmentId', `출하 ${unit.shipment_no} 의 취소 결재가 진행 중입니다(결재함에서 확인). 결재가 끝난 뒤 다시 시도하세요.`);
  }
}

function locked(name: string, message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [field(name, ERROR_CODE.STATE_LOCKED, message)]);
}

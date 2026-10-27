import { HttpStatus, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { CANCELLED, CONFIRMED } from '../shipment/shipment-guards';

export interface LockedUnit {
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
 * 단위를 잠그고 그 출하를 함께 잠근다(단위 → 출하 순서). 출하를 잠그지 않으면 확정·취소와 겹쳐 확정된 출하에
 * 열린 단위나 상자 변경이 남는다 — 확정·취소는 출하를 `FOR UPDATE` 로 잡으므로 여기서 `FOR SHARE` 로 막힌다.
 * 두 스캐너가 같은 단위에 동시에 넣거나 마감과 넣기가 겹치는 것은 단위 잠금이 막는다.
 */
export async function lockUnit(tx: Prisma.TransactionClient, shippingUnitId: number): Promise<LockedUnit> {
  const units = await tx.$queryRaw<Omit<LockedUnit, 'shipment_no' | 'shipment_status_code'>[]>`
    SELECT shipping_unit_id, shipping_unit_no, shipment_id, status_code, closed_at, version_no
      FROM logistics.shipping_unit
     WHERE shipping_unit_id = ${BigInt(shippingUnitId)}
       FOR UPDATE`;
  const unit = units[0];
  if (unit === undefined) throw new NotFoundException('없는 출하 단위입니다. 출하 단위 목록을 새로 고쳐 다시 고르세요.');
  const [shipment] = await tx.$queryRaw<{ shipment_no: string; status_code: string }[]>`
    SELECT shipment_no, status_code FROM logistics.shipment WHERE shipment_id = ${unit.shipment_id} FOR SHARE`;
  return { ...unit, shipment_no: shipment.shipment_no, shipment_status_code: shipment.status_code };
}

/** 확정(ERP 로 보냄)·취소된 출하의 단위는 상자를 넣고 빼거나 마감·되열기를 하지 않는다. */
export function assertShipmentOpen(unit: LockedUnit): void {
  if (unit.shipment_status_code === CONFIRMED) {
    throw shipmentLocked(`이미 확정돼 ERP 로 보낸 출하라 출하 단위를 고칠 수 없습니다(출하 ${unit.shipment_no} · 출하 단위 ${unit.shipping_unit_no}). 수량이 다르면 관리웹 반품·클레임 입고 등록(W-04-06)으로 처리하세요.`);
  }
  if (unit.shipment_status_code === CANCELLED) {
    throw shipmentLocked(`취소된 출하의 출하 단위라 쓸 수 없습니다(출하 ${unit.shipment_no} · 출하 단위 ${unit.shipping_unit_no}). 새 출하를 등록한 뒤 그 출하로 다시 포장하세요.`);
  }
}

export function shipmentLocked(message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [field('shipmentId', ERROR_CODE.STATE_LOCKED, message)]);
}

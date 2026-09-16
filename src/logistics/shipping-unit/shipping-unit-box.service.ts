import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, field } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { ShippingUnitQueryService } from './shipping-unit-query.service';
import { ShippingUnitActor } from './shipping-unit.service';
import {
  SHIPPING_UNIT_CLOSED,
  SHIPPING_UNIT_OPEN,
  ShippingUnitDetailView,
} from './shipping-unit-view';

/** 상자는 포장이 확정된 것만 들어간다. 취급 단위의 편도 끝 상태다. */
const HANDLING_UNIT_PACKED = 'PACKED';
const SHIPMENT_CANCELLED = 'CANCELLED';

export interface ShippingUnitAddBox {
  handlingUnitNo: string;
}

interface LockedUnit {
  shipping_unit_id: bigint;
  shipment_id: bigint;
  status_code: string;
  version_no: number;
}

@Injectable()
export class ShippingUnitBoxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queries: ShippingUnitQueryService,
  ) {}

  /**
   * 포장 라벨을 스캔해 상자를 넣는다.
   *
   * ⭐ **같은 단위에 같은 상자를 다시 스캔하면 200 이고 아무것도 바뀌지 않는다.** 현장에서
   * 스캐너가 한 번에 두 번 읽는 일이 흔하다 — 그걸 오류로 만들면 작업자가 멈춘다.
   * ⛔ 그 판정을 「다른 단위 소속」 검사보다 **먼저** 한다. 뒤에 두면 자기 단위에 있는
   * 상자가 「이미 구성됨」으로 걸린다.
   *
   * ⛔ 거절은 전부 **400 + code·field** 다. 409 는 저장 충돌(`:close` 의 If-Match) 전용이고
   * 그 봉투는 `ErrorResponse` 가 아니라 `ConflictResponse` 라 여기 쓰면 화면이 원인을 못 가린다.
   */
  async addBox(
    shippingUnitId: number,
    input: ShippingUnitAddBox,
    actor: ShippingUnitActor,
  ): Promise<ShippingUnitDetailView> {
    await this.prisma.$transaction(async (tx) => {
      const unit = await lockUnit(tx, shippingUnitId);
      assertOpen(unit);
      await assertShipmentLive(tx, unit.shipment_id);

      const box = await tx.handling_unit.findUnique({
        where: { handling_unit_no: input.handlingUnitNo },
        select: { handling_unit_id: true, status_code: true },
      });
      if (box === null) throw new NotFoundException('없는 상자입니다.');
      if (box.status_code !== HANDLING_UNIT_PACKED) {
        throw boxError(ERROR_CODE.STATE_LOCKED, '포장 확정되지 않은 상자입니다.');
      }

      const link = await tx.shipping_unit_handling_unit.findUnique({
        where: { handling_unit_id: box.handling_unit_id },
        select: { shipping_unit_id: true },
      });
      // ⭐ 멱등 — 이미 «이» 단위에 있으면 그대로 둔다(버전도 올리지 않는다).
      if (link !== null && link.shipping_unit_id === unit.shipping_unit_id) return;
      if (link !== null) {
        throw boxError(ERROR_CODE.UNIQUE_VIOLATION, '이미 다른 출하 단위에 구성된 상자입니다.');
      }

      // ⛔ 포장 실적이 없는 상자는 넣지 않는다 — 배분이 안 붙었다는 것은 그 상자가 아직
      //    어느 출하의 것도 아니라는 뜻이다.
      const allocations = await tx.shipment_lot_allocation.findMany({
        where: { handling_unit_id: box.handling_unit_id },
        select: { shipment_line: { select: { shipment_id: true } } },
      });
      if (allocations.length === 0) {
        throw boxError(ERROR_CODE.INVALID, '포장 실적이 없는 상자입니다.');
      }
      // ⛔ 출하 단위 하나에는 «한 출하 전표»의 상자만 담는다(사용자 결정 U4 · 서버가 막는다).
      if (allocations.some((row) => row.shipment_line.shipment_id !== unit.shipment_id)) {
        throw boxError(ERROR_CODE.PAIR, '다른 출하의 상자입니다.');
      }

      const last = await tx.shipping_unit_handling_unit.findFirst({
        where: { shipping_unit_id: unit.shipping_unit_id },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      await tx.shipping_unit_handling_unit.create({
        data: {
          shipping_unit_id: unit.shipping_unit_id,
          handling_unit_id: box.handling_unit_id,
          // 빼기 뒤 재부여하지 않는다 — 마지막 번호에서 이어 붙인다(빈 번호를 허용한다).
          seq: (last?.seq ?? 0) + 1,
          added_by: actor.appUserId == null ? null : BigInt(actor.appUserId),
        },
      });
      await bumpVersion(tx, unit, actor);
    });
    return this.queries.get(shippingUnitId, actor.plantId);
  }

  /** 마감 «전»에만 뺀다. 204 가 아니라 상세를 돌려준다 — 화면이 목록과 합계를 다시 그린다. */
  async removeBox(
    shippingUnitId: number,
    handlingUnitId: number,
    actor: ShippingUnitActor,
  ): Promise<ShippingUnitDetailView> {
    await this.prisma.$transaction(async (tx) => {
      const unit = await lockUnit(tx, shippingUnitId);
      assertOpen(unit);

      const removed = await tx.shipping_unit_handling_unit.deleteMany({
        where: {
          shipping_unit_id: unit.shipping_unit_id,
          handling_unit_id: BigInt(handlingUnitId),
        },
      });
      if (removed.count === 0) throw new NotFoundException('그 출하 단위에 없는 상자입니다.');
      await bumpVersion(tx, unit, actor);
    });
    return this.queries.get(shippingUnitId, actor.plantId);
  }

  /**
   * 마감. ⛔ **되돌릴 수 없다** — 취소·해체 경로를 두지 않는다(취급 단위와 같은 태도 · 통보 142).
   * 마감돼야 납품 라벨을 발행할 수 있다.
   */
  async close(
    shippingUnitId: number,
    expectedVersion: number,
    actor: ShippingUnitActor,
  ): Promise<ShippingUnitDetailView> {
    await this.prisma.$transaction(async (tx) => {
      const unit = await lockUnit(tx, shippingUnitId);
      assertOpen(unit);
      await assertShipmentLive(tx, unit.shipment_id);
      if (unit.version_no !== expectedVersion) {
        throw new ConflictException('user', '다른 사용자가 먼저 수정했습니다.', {
          currentVersion: String(unit.version_no),
        });
      }

      const boxes = await tx.shipping_unit_handling_unit.count({
        where: { shipping_unit_id: unit.shipping_unit_id },
      });
      if (boxes === 0) {
        throw new ContractException(HttpStatus.BAD_REQUEST, [
          field('boxes', ERROR_CODE.INVALID, '상자가 한 개도 없는 출하 단위는 마감할 수 없습니다.'),
        ]);
      }

      await tx.shipping_unit.update({
        where: { shipping_unit_id: unit.shipping_unit_id },
        data: {
          status_code: SHIPPING_UNIT_CLOSED,
          closed_at: new Date(),
          closed_by: actor.appUserId == null ? null : BigInt(actor.appUserId),
          version_no: { increment: 1 },
          updated_by: actor.appUserId == null ? null : BigInt(actor.appUserId),
          updated_at: new Date(),
        },
      });
    });
    return this.queries.get(shippingUnitId, actor.plantId);
  }
}

/**
 * ⛔ 행을 잠근다 — 두 스캐너가 같은 단위에 동시에 넣으면 `seq` 가 겹치고, 마감과 넣기가
 * 겹치면 마감된 단위에 상자가 들어간다. 검사와 쓰기 사이를 이 잠금이 잇는다.
 */
async function lockUnit(tx: Prisma.TransactionClient, shippingUnitId: number): Promise<LockedUnit> {
  const rows = await tx.$queryRaw<LockedUnit[]>(Prisma.sql`
    SELECT shipping_unit_id,shipment_id,status_code,version_no
      FROM logistics.shipping_unit
     WHERE shipping_unit_id=${BigInt(shippingUnitId)}
     FOR UPDATE
  `);
  if (rows[0] === undefined) throw new NotFoundException('없는 출하 단위입니다.');
  return rows[0];
}

function assertOpen(unit: LockedUnit): void {
  if (unit.status_code !== SHIPPING_UNIT_OPEN) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      field('shippingUnitId', ERROR_CODE.STATE_LOCKED, '이미 마감된 출하 단위입니다.'),
    ]);
  }
}

/** 단위를 연 뒤 출하가 취소될 수 있다 — 넣기와 마감에서 다시 본다. */
async function assertShipmentLive(tx: Prisma.TransactionClient, shipmentId: bigint): Promise<void> {
  const shipment = await tx.shipment.findUnique({
    where: { shipment_id: shipmentId },
    select: { status_code: true },
  });
  if (shipment?.status_code === SHIPMENT_CANCELLED) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      field('shipmentId', ERROR_CODE.STATE_LOCKED, '취소된 출하입니다.'),
    ]);
  }
}

/**
 * ⭐ 상자가 드나들면 단위의 `version_no` 를 올린다. 안 올리면 상자를 바꾼 뒤에도 **낡은
 * ETag 로 마감이 통과**해, 작업자가 보던 것과 다른 구성이 굳는다.
 */
async function bumpVersion(
  tx: Prisma.TransactionClient,
  unit: LockedUnit,
  actor: ShippingUnitActor,
): Promise<void> {
  await tx.shipping_unit.update({
    where: { shipping_unit_id: unit.shipping_unit_id },
    data: {
      version_no: { increment: 1 },
      updated_by: actor.appUserId == null ? null : BigInt(actor.appUserId),
      updated_at: new Date(),
    },
  });
}

function boxError(code: string, message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [field('handlingUnitNo', code, message)]);
}

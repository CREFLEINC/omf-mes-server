import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { issueCode, lockWarehouse } from './location-code';
import { assertNoStock, parentError } from './location-hierarchy';
import { LocationResult, LocationService } from './location.service';

export interface RackCreate {
  parentLocationId: number;
  levelCount: number;
  cellCountPerLevel: number;
}

/** 랙 하나 만들기 · 위치 지우기 — 사용자 결정 2026-10-29. */
@Injectable()
export class LocationStructureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly locations: LocationService,
  ) {}

  /** 구역 밑에 랙 1개와 층·셀을 한 번에 만든다. 랙이 새것이라 층·셀 코드는 번호를 차례로 붙인다. */
  async createRack(input: RackCreate): Promise<LocationResult['location']> {
    const zone = await this.prisma.location.findUnique({
      where: { location_id: input.parentLocationId },
      select: { warehouse_id: true, location_code: true, location_level_code: true, system_role_code: true, is_active: true },
    });
    if (zone === null || zone.location_level_code !== 'ZONE' || zone.system_role_code !== null || !zone.is_active) {
      throw parentError('랙은 사람이 만든 켜진 구역 밑에만 만듭니다.');
    }
    await assertNoStock(this.prisma, input.parentLocationId, 'parentLocationId');
    const warehouseId = Number(zone.warehouse_id);

    const rackId = await this.prisma.$transaction(async (tx) => {
      await lockWarehouse(tx, warehouseId);
      const rackCode = await issueCode(tx, warehouseId, { locationId: input.parentLocationId, locationCode: zone.location_code }, 'RACK');
      const rack = await tx.location.create({ data: place(warehouseId, input.parentLocationId, 'RACK', rackCode) });
      for (let level = 1; level <= input.levelCount; level += 1) {
        const levelCode = `${rackCode}-L${pad(level)}`;
        const row = await tx.location.create({ data: place(warehouseId, Number(rack.location_id), 'LEVEL', levelCode) });
        await tx.location.createMany({
          data: Array.from({ length: input.cellCountPerLevel }, (_, index) =>
            place(warehouseId, Number(row.location_id), 'CELL', `${levelCode}-C${pad(index + 1)}`)),
        });
      }
      return Number(rack.location_id);
    });
    return (await this.locations.get(rackId)).location;
  }

  /** 그 위치와 밑의 위치를 함께 지운다 — 하나라도 쓰였으면 막는다(사용 중지로 간다). */
  async remove(locationId: number): Promise<void> {
    const row = await this.prisma.location.findUnique({
      where: { location_id: locationId },
      select: { system_role_code: true },
    });
    if (row === null) throw new NotFoundException('없는 위치입니다.');
    if (row.system_role_code !== null) throw locked('서버가 만든 자리는 지울 수 없습니다.');

    const branch = await this.prisma.$queryRaw<{ location_id: bigint }[]>`
      WITH RECURSIVE branch AS (
        SELECT location_id FROM mdm.location WHERE location_id = ${BigInt(locationId)}
        UNION ALL
        SELECT child.location_id FROM mdm.location child JOIN branch ON child.parent_location_id = branch.location_id
      )
      SELECT location_id FROM branch`;
    try {
      // 가지를 한 문장으로 지운다 — 자기참조 FK 는 문장 끝에 보고, 위치를 가리키는 FK(`LOCATION_REFERRERS`)가 품목 제한
      // (CASCADE · 함께 지운다) 말고는 모두 NO ACTION 이라 재고·원장·전표·규칙 어디서든 쓰였으면 DB 가 통째로 막는다.
      await this.prisma.location.deleteMany({ where: { location_id: { in: branch.map((item) => item.location_id) } } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        throw locked('쓰인 위치는 지울 수 없습니다 — 사용 중지합니다.');
      }
      throw error;
    }
  }
}

function place(warehouseId: number, parentId: number, level: string, code: string): Prisma.locationUncheckedCreateInput {
  return {
    warehouse_id: warehouseId,
    parent_location_id: parentId,
    location_level_code: level,
    location_code: code,
    location_name: code,
  };
}

const pad = (value: number): string => String(value).padStart(2, '0');

const locked = (message: string): ContractException =>
  new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message }]);

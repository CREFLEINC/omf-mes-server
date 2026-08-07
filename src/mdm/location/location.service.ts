import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractBadRequest, ErrorCode, screenError } from '../../common/errors/contract-error';
import type { components } from '../../contracts/mdm';
import { PrismaService } from '../../prisma/prisma.service';
import { toEditability } from '../editability';
import { countReferences } from '../reference-count';
import { checkActivable, checkDeactivable } from './location.activation';
import { CreateLocationDto } from './location.create.dto';
import { LOCATION_REFERENCES } from './location.references';
import { toLocation } from './location.mapper';
import { LocationQueryDto } from './location.query.dto';
import { UpdateLocationDto } from './location.update.dto';
import { LocationValidator } from './location.validator';

type LocationList = {
  items: components['schemas']['Location'][];
  page: components['schemas']['PageMeta'];
};

/** `versionNo` 는 본문이 아니라 ETag 헤더로 나간다(공유계약 A-4). 그 분기를 컨트롤러가 한다. */
type LocationDetail = {
  body: components['schemas']['LocationDetailResponse'];
  versionNo: number;
};

/** 쓰기 응답. `versionNo` 는 같은 이유로 본문이 아니라 ETag 로 나간다. */
type LocationWritten = {
  body: components['schemas']['Location'];
  versionNo: number;
};

@Injectable()
export class LocationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly validator: LocationValidator,
  ) {}

  async create(dto: CreateLocationDto, actorId: bigint): Promise<components['schemas']['Location']> {
    const errors = await this.validator.validateCreate(dto);
    if (errors.length > 0) throw new ContractBadRequest(errors);

    const row = await this.prisma.location.create({
      data: {
        warehouse_id: BigInt(dto.warehouseId),
        ...this.writableFields(dto),
        // is_active 는 받지 않는다 — 신규는 항상 사용 중이다(계약 LocationCreate).
        created_by: actorId,
        updated_by: actorId,
      },
    });

    return toLocation(row);
  }

  async update(
    locationId: bigint,
    expectedVersion: number,
    dto: UpdateLocationDto,
    actorId: bigint,
  ): Promise<LocationWritten> {
    const current = await this.prisma.location.findUnique({
      where: { location_id: locationId },
      select: { warehouse_id: true },
    });
    if (!current) throw new NotFoundException(`로케이션(${locationId})을 찾을 수 없습니다.`);

    const errors = await this.validator.validateUpdate(locationId, current.warehouse_id, dto);
    if (errors.length > 0) throw new ContractBadRequest(errors);

    return this.applyVersioned(locationId, expectedVersion, actorId, this.writableFields(dto));
  }

  /**
   * 물리 삭제는 제공하지 않는다 — 과거 전표가 이 자리를 가리키고 있어, 지우면 그 전표가
   * 어디를 가리키는지 알 수 없어진다.
   */
  async deactivate(
    locationId: bigint,
    expectedVersion: number,
    actorId: bigint,
  ): Promise<LocationWritten> {
    const current = await this.prisma.location.findUnique({
      where: { location_id: locationId },
      select: { is_active: true },
    });
    if (!current) throw new NotFoundException(`로케이션(${locationId})을 찾을 수 없습니다.`);

    // STATE_LOCKED 인 이유: 새로고침해도 풀리지 않는다. 재고를 빼거나 하위 자리를
    // 중지해야 풀리므로, 재로드로 풀리는 저장 충돌(409)과 다르다(공유계약 G-1).
    const errors = current.is_active
      ? await checkDeactivable(this.prisma, locationId)
      : [screenError(ErrorCode.STATE_LOCKED, '이미 중지된 로케이션입니다.')];
    if (errors.length > 0) throw new ContractBadRequest(errors);

    return this.applyVersioned(locationId, expectedVersion, actorId, { is_active: false });
  }

  /** 계약에 없다 — 창고의 `:activate` 와 같은 이유로 서버가 먼저 만든다. */
  async activate(
    locationId: bigint,
    expectedVersion: number,
    actorId: bigint,
  ): Promise<LocationWritten> {
    const current = await this.prisma.location.findUnique({
      where: { location_id: locationId },
      select: { is_active: true, warehouse_id: true, parent_location_id: true },
    });
    if (!current) throw new NotFoundException(`로케이션(${locationId})을 찾을 수 없습니다.`);

    const errors = current.is_active
      ? [screenError(ErrorCode.STATE_LOCKED, '이미 사용 중인 로케이션입니다.')]
      : await checkActivable(this.prisma, current);
    if (errors.length > 0) throw new ContractBadRequest(errors);

    return this.applyVersioned(locationId, expectedVersion, actorId, { is_active: true });
  }

  /**
   * 등록과 수정이 같은 필드를 쓴다 — `PUT` 이 전체 교체라서다. 한쪽에만 필드를 더하면
   * 수정으로는 못 넣는 값이 생긴다.
   *
   * 선택 필드는 안 보내면 `null` 로 지운다. `?? null` 이 그 뜻이다.
   */
  private writableFields(dto: CreateLocationDto | UpdateLocationDto) {
    return {
      parent_location_id: dto.parentLocationId ? BigInt(dto.parentLocationId) : null,
      location_code: dto.locationCode,
      location_name: dto.locationName,
      location_type_code: dto.locationTypeCode,
      quality_zone_code: dto.qualityZoneCode ?? null,
      storage_condition_code: dto.storageConditionCode ?? null,
      allow_mixed_item: dto.allowMixedItem,
      allow_mixed_lot: dto.allowMixedLot,
      capacity_qty: dto.capacityQty ?? null,
      capacity_uom_id: dto.capacityUomId ? BigInt(dto.capacityUomId) : null,
    };
  }

  /**
   * 낙관적 잠금은 **조건부 갱신**으로 건다 — WHERE 에 기대 버전을 넣어 행 단위
   * 비교-교환으로 만든다(공유계약 B-1). 창고와 같은 규칙이다.
   */
  private async applyVersioned(
    locationId: bigint,
    expectedVersion: number,
    actorId: bigint,
    data: Prisma.locationUncheckedUpdateManyInput,
  ): Promise<LocationWritten> {
    const { count } = await this.prisma.location.updateMany({
      where: { location_id: locationId, version_no: expectedVersion },
      data: { ...data, updated_by: actorId, updated_at: new Date(), version_no: { increment: 1 } },
    });

    if (count === 0) {
      // erpSync·workerLease 는 판정할 근거가 스키마에 없다.
      throw new ConflictException({
        conflictCause: 'user',
        message: '다른 사용자가 먼저 수정했습니다. 새로고침 후 다시 시도하십시오.',
      });
    }

    const row = await this.prisma.location.findUniqueOrThrow({ where: { location_id: locationId } });

    return { body: toLocation(row), versionNo: row.version_no };
  }

  async findAll(query: LocationQueryDto): Promise<LocationList> {
    const where = this.buildWhere(query);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.location.findMany({
        where,
        // 계약에 정렬 기준이 없다. 불안정하면 페이지를 넘길 때 같은 행이 두 번 나오거나
        // 빠지므로 유일키(warehouse_id, location_code)로 못 박는다 — 창고와 같은 판단이다.
        orderBy: [{ warehouse_id: 'asc' }, { location_code: 'asc' }],
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.location.count({ where }),
    ]);

    return {
      items: rows.map(toLocation),
      page: { page: query.page, size: query.size, total },
    };
  }

  async findOne(locationId: bigint): Promise<LocationDetail> {
    const row = await this.prisma.location.findUnique({ where: { location_id: locationId } });
    if (!row) throw new NotFoundException(`로케이션(${locationId})을 찾을 수 없습니다.`);

    const referenceCount = await countReferences(this.prisma, LOCATION_REFERENCES, locationId);

    return {
      body: { location: toLocation(row), editability: toEditability(referenceCount) },
      versionNo: row.version_no,
    };
  }

  private buildWhere(query: LocationQueryDto): Prisma.locationWhereInput {
    const where: Prisma.locationWhereInput = { warehouse_id: BigInt(query.warehouseId) };

    if (!query.includeInactive) where.is_active = true;
    if (query.q) {
      where.OR = [
        { location_code: { contains: query.q, mode: 'insensitive' } },
        { location_name: { contains: query.q, mode: 'insensitive' } },
      ];
    }

    return where;
  }
}

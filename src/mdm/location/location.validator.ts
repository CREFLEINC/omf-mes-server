import { Injectable } from '@nestjs/common';

import { ErrorCode, ErrorItem, fieldError } from '../../common/errors/contract-error';
import { PrismaService } from '../../prisma/prisma.service';
import { checkCodeLock } from '../editability';
import { CreateLocationDto } from './location.create.dto';
import { LOCATION_REFERENCES } from './location.references';
import { UpdateLocationDto } from './location.update.dto';

/** 코드 필드가 어느 공통코드 그룹에 속해야 하는지. 값 목록은 `mdm.code_value` 가 정본이다. */
const CODE_GROUPS = {
  locationTypeCode: 'LOCATION_TYPE',
  qualityZoneCode: 'QUALITY_ZONE',
  storageConditionCode: 'STORAGE_CONDITION',
} as const;

/**
 * 부모를 따라 올라가는 최대 깊이. 실제 계층은 구역→열→단 정도라 한 자리를 넘지 않는다.
 * 이 값은 **이미 순환이 들어간 데이터를 만났을 때 질의가 멈추게 하는 안전장치**다.
 */
const MAX_DEPTH = 64;

type LocationDto = CreateLocationDto | UpdateLocationDto;

@Injectable()
export class LocationValidator {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 검사를 `Promise.all` 로 동시에 돌린다. 실패가 확실한 경우에도 전부 조회하지만,
   * **성공이 보통이고 성공은 어차피 전부 확인해야 한다** — 순차로 바꾸면 성공 경로가
   * 왕복 5회가 된다. 계약이 오류를 배열로 정의한 것도 한 번에 다 알려주기 위해서다.
   */
  async validateCreate(dto: CreateLocationDto): Promise<ErrorItem[]> {
    const warehouseId = BigInt(dto.warehouseId);

    const [warehouse, codes, capacity, parent, duplicate] = await Promise.all([
      this.checkWarehouse(warehouseId),
      this.checkCodes(dto),
      this.checkCapacity(dto),
      // 등록도 조상을 따라 올라간다. 자기 자신은 아직 없어 순환에 걸릴 수 없지만,
      // **이미 순환이 든 계층 아래**에 매달면 이 자리에서 위로 올라가는 길이 영영 끝나지
      // 않는다 — 화면의 경로 표시가 멈춘다.
      this.checkParent(warehouseId, dto.parentLocationId, null),
      this.checkDuplicate(warehouseId, dto.locationCode),
    ]);

    return [...warehouse, ...codes, ...capacity, ...parent, ...duplicate];
  }

  /**
   * 창고는 바뀌지 않는다(등록 후 변경 불가). 유일성은 **자기 자신을 뺀** 범위에서 본다.
   *
   * 등록에 없고 여기만 있는 것이 **순환 검사**다. 등록 시점에는 자식이 없어 순환이
   * 만들어지지 않지만, 수정은 계층 재배치라 자기 자손을 부모로 지목할 수 있다.
   */
  async validateUpdate(
    locationId: bigint,
    current: { warehouse_id: bigint; location_code: string },
    dto: UpdateLocationDto,
  ): Promise<ErrorItem[]> {
    const [codes, capacity, parent, duplicate, codeLock] = await Promise.all([
      this.checkCodes(dto),
      this.checkCapacity(dto),
      this.checkParent(current.warehouse_id, dto.parentLocationId, locationId),
      this.checkDuplicateExcept(locationId, current.warehouse_id, dto.locationCode),
      checkCodeLock(
        this.prisma,
        LOCATION_REFERENCES,
        locationId,
        'locationCode',
        current.location_code,
        dto.locationCode,
      ),
    ]);

    return [...codes, ...capacity, ...parent, ...duplicate, ...codeLock];
  }

  /** 창고가 실재하고 사용 중인가. 중지된 창고에 자리를 새로 만들면 갈 수 없는 자리가 된다. */
  private async checkWarehouse(warehouseId: bigint): Promise<ErrorItem[]> {
    const found = await this.prisma.warehouse.findUnique({
      where: { warehouse_id: warehouseId },
      select: { is_active: true },
    });

    if (!found) return [fieldError('warehouseId', ErrorCode.RANGE, '없는 창고입니다.')];

    return found.is_active
      ? []
      : [fieldError('warehouseId', ErrorCode.STATE_LOCKED, '중지된 창고에는 자리를 만들 수 없습니다.')];
  }

  private async checkCodes(dto: LocationDto): Promise<ErrorItem[]> {
    const pairs = Object.entries(CODE_GROUPS) as [keyof typeof CODE_GROUPS, string][];

    const results = await Promise.all(
      pairs.map(async ([field, groupCode]) => {
        const value = dto[field];
        // 선택 코드는 안 보내면 검사할 것이 없다. locationTypeCode 는 DTO 가 필수로 막는다.
        if (value === undefined || value === null) return null;

        const found = await this.prisma.code_value.findFirst({
          where: { code: value, code_group: { group_code: groupCode }, is_active: true },
          select: { code_value_id: true },
        });

        return found ? null : fieldError(field, ErrorCode.RANGE, `${groupCode} 에 없는 코드입니다.`);
      }),
    );

    return results.filter((item): item is ErrorItem => item !== null);
  }

  /**
   * ck_location_capacity — 수량과 단위는 함께 있거나 함께 비어야 한다.
   * 「500」만 있고 단위가 없으면 500 이 무엇인지 아무도 모른다.
   */
  private async checkCapacity(dto: LocationDto): Promise<ErrorItem[]> {
    const hasQty = dto.capacityQty !== undefined && dto.capacityQty !== null;
    const uomId = dto.capacityUomId ?? null;

    if (hasQty !== (uomId !== null)) {
      return [
        fieldError(
          hasQty ? 'capacityUomId' : 'capacityQty',
          ErrorCode.PAIR,
          '용량은 수량과 단위를 함께 입력해야 합니다.',
        ),
      ];
    }

    if (uomId === null) return [];

    const uom = await this.prisma.uom.findUnique({ where: { uom_id: BigInt(uomId) } });

    return uom ? [] : [fieldError('capacityUomId', ErrorCode.RANGE, '없는 단위입니다.')];
  }

  /**
   * 부모는 실재하고 **같은 창고 안**이어야 하며, 거슬러 올라가도 자기 자신이 나오지
   * 않아야 한다. 남의 창고 자리에 매달 수는 없다.
   *
   * `locationId` 가 `null` 이면 등록이다 — 아직 행이 없어 자기 자신에 걸릴 수 없지만
   * 깊이 검사는 그대로 돈다.
   */
  private async checkParent(
    warehouseId: bigint,
    parentLocationId: number | null | undefined,
    locationId: bigint | null,
  ): Promise<ErrorItem[]> {
    if (parentLocationId === undefined || parentLocationId === null) return [];

    const parent = await this.prisma.location.findUnique({
      where: { location_id: BigInt(parentLocationId) },
      select: { warehouse_id: true },
    });

    if (!parent) return [fieldError('parentLocationId', ErrorCode.RANGE, '없는 로케이션입니다.')];

    if (parent.warehouse_id !== warehouseId) {
      return [
        fieldError(
          'parentLocationId',
          ErrorCode.RANGE,
          '다른 창고의 로케이션을 상위로 지정할 수 없습니다.',
        ),
      ];
    }

    return this.checkCycle(locationId, BigInt(parentLocationId));
  }

  /**
   * 지목한 부모에서 위로 거슬러 올라가 **자기 자신이 나오는지** 본다. 나오면 순환이다.
   * 자기 자신을 부모로 지목한 경우도 같은 검사가 잡는다 — 올라가기 시작하는 지점이
   * 곧 자기 자신이기 때문이다.
   *
   * DB 가 막아주지 않는다. `mdm.location` 에는 자기참조 제약이 없다(부서의
   * `ck_department_parent` 와 달리). 순환은 어차피 제약으로 막을 수 없다 —
   * A→B→A 는 각 행만 보면 정상이다.
   *
   * 재귀 CTE 로 한 번에 묻는다. 애플리케이션에서 한 단계씩 올라가면 깊이만큼 왕복하고,
   * 이미 순환이 든 데이터를 만나면 영원히 멈추지 않는다.
   */
  private async checkCycle(
    locationId: bigint | null,
    parentLocationId: bigint,
  ): Promise<ErrorItem[]> {
    const chain = await this.prisma.$queryRaw<{ location_id: bigint; depth: number }[]>`
      WITH RECURSIVE chain AS (
        SELECT location_id, parent_location_id, 1 AS depth
        FROM mdm.location
        WHERE location_id = ${parentLocationId}
        UNION ALL
        SELECT l.location_id, l.parent_location_id, chain.depth + 1
        FROM mdm.location l
        JOIN chain ON l.location_id = chain.parent_location_id
        WHERE chain.depth < ${MAX_DEPTH}
      )
      SELECT location_id, depth FROM chain
    `;

    if (locationId !== null && chain.some((row) => row.location_id === locationId)) {
      return [
        fieldError(
          'parentLocationId',
          ErrorCode.RANGE,
          '자기 자신이나 하위 로케이션을 상위로 지정할 수 없습니다.',
        ),
      ];
    }

    // 여기까지 왔는데 깊이가 한계면 위쪽에 이미 순환이 있다는 뜻이다. 자기 자신이
    // 그 고리에 없더라도 매달면 안 된다 — 붙는 순간 이 자리도 못 빠져나온다.
    return chain.some((row) => row.depth >= MAX_DEPTH)
      ? [
          fieldError(
            'parentLocationId',
            ErrorCode.RANGE,
            '상위 계층이 너무 깊거나 순환되어 있습니다. 상위 로케이션을 먼저 정리하십시오.',
          ),
        ]
      : [];
  }

  /**
   * uq_location — `(warehouse_id, location_code)` 다. **전역 유일이 아니다** —
   * 다른 창고에 같은 코드가 있는 것은 정상이다.
   *
   * 선제 조회일 뿐이라 동시 요청은 통과할 수 있다. 최종 방어는 DB 제약이고
   * `PrismaExceptionFilter` 가 같은 봉투로 바꾼다.
   */
  private async checkDuplicate(warehouseId: bigint, locationCode: string): Promise<ErrorItem[]> {
    const existing = await this.findByCode(warehouseId, locationCode);

    return existing ? [duplicateLocationCode()] : [];
  }

  private async checkDuplicateExcept(
    locationId: bigint,
    warehouseId: bigint,
    locationCode: string,
  ): Promise<ErrorItem[]> {
    const existing = await this.findByCode(warehouseId, locationCode);

    return existing && existing.location_id !== locationId ? [duplicateLocationCode()] : [];
  }

  private findByCode(warehouseId: bigint, locationCode: string) {
    return this.prisma.location.findUnique({
      where: { warehouse_id_location_code: { warehouse_id: warehouseId, location_code: locationCode } },
      select: { location_id: true },
    });
  }
}

/** 선제 조회와 DB 제약 위반이 같은 문구를 내려야 한다 — 화면이 둘을 구분할 이유가 없다. */
export function duplicateLocationCode(): ErrorItem {
  return fieldError(
    'locationCode',
    ErrorCode.UNIQUE_VIOLATION,
    '같은 창고에 이미 있는 로케이션 코드입니다.',
    ['warehouseId', 'locationCode'],
  );
}

import { Injectable } from '@nestjs/common';

import { ErrorCode, ErrorItem, fieldError } from '../../common/errors/contract-error';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateWarehouseDto } from './warehouse.create.dto';
import { UpdateWarehouseDto } from './warehouse.update.dto';

/** 코드 필드가 어느 공통코드 그룹에 속해야 하는지. 값 목록은 `mdm.code_value` 가 정본이다. */
const CODE_GROUPS = {
  warehouseTypeCode: 'WAREHOUSE_TYPE',
  managementLevelCode: 'MANAGEMENT_LEVEL',
} as const;

/**
 * DTO 가 통과시킨 뒤에 남는 검증 — 값의 형식이 아니라 **다른 데이터와의 관계**를 본다.
 *
 * 한 번에 모아서 돌려준다. 하나씩 알려주면 필드 셋이 틀렸을 때 사용자가 세 번 저장을
 * 눌러야 한다(계약이 오류를 배열로 정의한 이유).
 */
@Injectable()
export class WarehouseValidator {
  constructor(private readonly prisma: PrismaService) {}

  async validateCreate(dto: CreateWarehouseDto): Promise<ErrorItem[]> {
    const [organization, codes, partner, duplicate] = await Promise.all([
      this.checkOrganization(dto),
      this.checkCodes(dto),
      this.checkPartner(dto),
      this.checkDuplicate(dto),
    ]);

    return [...organization, ...codes, ...partner, ...duplicate];
  }

  /**
   * 수정은 공장이 바뀌지 않는다(등록 후 변경 불가). 유일성은 **자기 자신을 뺀** 범위에서
   * 본다 — 코드를 그대로 두고 이름만 고치는 것이 가장 흔한 수정이다.
   */
  async validateUpdate(
    warehouseId: bigint,
    plantId: bigint,
    dto: UpdateWarehouseDto,
  ): Promise<ErrorItem[]> {
    const [businessUnit, codes, partner, duplicate] = await Promise.all([
      this.checkBusinessUnit(dto.businessUnitId),
      this.checkCodes(dto),
      this.checkPartner(dto),
      this.checkDuplicateExcept(warehouseId, plantId, dto.warehouseCode),
    ]);

    return [...businessUnit, ...codes, ...partner, ...duplicate];
  }

  private async checkBusinessUnit(businessUnitId: number): Promise<ErrorItem[]> {
    const found = await this.prisma.business_unit.findUnique({
      where: { business_unit_id: BigInt(businessUnitId) },
    });

    return found ? [] : [fieldError('businessUnitId', ErrorCode.RANGE, '없는 사업부입니다.')];
  }

  private async checkDuplicateExcept(
    warehouseId: bigint,
    plantId: bigint,
    warehouseCode: string,
  ): Promise<ErrorItem[]> {
    const existing = await this.prisma.warehouse.findUnique({
      where: { plant_id_warehouse_code: { plant_id: plantId, warehouse_code: warehouseCode } },
      select: { warehouse_id: true },
    });

    return existing && existing.warehouse_id !== warehouseId ? [duplicateWarehouseCode()] : [];
  }

  /** 공장·사업부가 실재하는가. FK 라 DB 도 잡지만, 그러면 어느 필드가 문제인지 못 알려준다. */
  private async checkOrganization(dto: CreateWarehouseDto): Promise<ErrorItem[]> {
    const [plant, businessUnit] = await Promise.all([
      this.prisma.plant.findUnique({ where: { plant_id: BigInt(dto.plantId) } }),
      this.prisma.business_unit.findUnique({
        where: { business_unit_id: BigInt(dto.businessUnitId) },
      }),
    ]);

    return [
      ...(plant ? [] : [fieldError('plantId', ErrorCode.RANGE, '없는 공장입니다.')]),
      ...(businessUnit
        ? []
        : [fieldError('businessUnitId', ErrorCode.RANGE, '없는 사업부입니다.')]),
    ];
  }

  /** 코드 필드가 해당 공통코드 그룹에 등재된 값인가. */
  private async checkCodes(dto: CreateWarehouseDto | UpdateWarehouseDto): Promise<ErrorItem[]> {
    const pairs = Object.entries(CODE_GROUPS) as [keyof typeof CODE_GROUPS, string][];

    const results = await Promise.all(
      pairs.map(async ([field, groupCode]) => {
        const found = await this.prisma.code_value.findFirst({
          where: { code: dto[field], code_group: { group_code: groupCode }, is_active: true },
          select: { code_value_id: true },
        });

        return found ? null : fieldError(field, ErrorCode.RANGE, `${groupCode} 에 없는 코드입니다.`);
      }),
    );

    return results.filter((item): item is ErrorItem => item !== null);
  }

  /** ck_external_warehouse_partner — 외부창고면 거래처가 있어야 한다. */
  private async checkPartner(dto: CreateWarehouseDto | UpdateWarehouseDto): Promise<ErrorItem[]> {
    if (!dto.isExternal) return [];

    if (dto.partnerId === undefined || dto.partnerId === null) {
      return [fieldError('partnerId', ErrorCode.PAIR, '외부창고는 거래처가 필요합니다.')];
    }

    const partner = await this.prisma.partner.findUnique({
      where: { partner_id: BigInt(dto.partnerId) },
    });

    return partner ? [] : [fieldError('partnerId', ErrorCode.RANGE, '없는 거래처입니다.')];
  }

  /**
   * uq_warehouse — `(plant_id, warehouse_code)` 다. **전역 유일이 아니다** — 다른 공장에
   * 같은 코드가 있는 것은 정상이다.
   *
   * 선제 조회일 뿐이라 동시 요청은 통과할 수 있다. 최종 방어는 DB 제약이고
   * `PrismaExceptionFilter` 가 같은 봉투로 바꾼다.
   */
  private async checkDuplicate(dto: CreateWarehouseDto): Promise<ErrorItem[]> {
    const existing = await this.prisma.warehouse.findUnique({
      where: {
        plant_id_warehouse_code: {
          plant_id: BigInt(dto.plantId),
          warehouse_code: dto.warehouseCode,
        },
      },
      select: { warehouse_id: true },
    });

    return existing ? [duplicateWarehouseCode()] : [];
  }
}

/** 선제 조회와 DB 제약 위반이 같은 문구를 내려야 한다 — 화면이 둘을 구분할 이유가 없다. */
export function duplicateWarehouseCode(): ErrorItem {
  return fieldError(
    'warehouseCode',
    ErrorCode.UNIQUE_VIOLATION,
    '같은 공장에 이미 있는 창고 코드입니다.',
    ['plantId', 'warehouseCode'],
  );
}

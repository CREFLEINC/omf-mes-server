import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

import { PageQueryDto, toOptionalBoolean } from '../../common/dto/page-query.dto';
import { CODE_PATTERN } from '../common-code/dto/code-group.dto';

const codeRule = { message: '코드는 영문 대문자·숫자·언더스코어만 사용합니다.' };

export class CreateWarehouseDto {
  @ApiProperty({ description: '소속 법인 코드', example: 'OMF_VN' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  legalEntityCode!: string;

  @ApiProperty({ description: '소속 공장 코드', example: 'PLANT1' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  plantCode!: string;

  @ApiProperty({ description: '소속 사업부 코드', example: 'PARTS' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  businessUnitCode!: string;

  @ApiProperty({ description: '창고 코드', example: 'WH_MAT', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, codeRule)
  warehouseCode!: string;

  @ApiProperty({ description: '창고명', example: '자재창고', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  warehouseName!: string;

  @ApiProperty({
    description: '창고유형 코드 — 공통코드 그룹 WAREHOUSE_TYPE의 코드값',
    example: 'MATERIAL',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  warehouseTypeCode!: string;

  @ApiProperty({
    description: '관리수준 코드 — 공통코드 그룹 MANAGEMENT_LEVEL의 코드값 (창고/구역/랙/셀)',
    example: 'LOCATION',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  managementLevelCode!: string;

  @ApiPropertyOptional({
    description: '외부창고 여부. true면 partnerCode가 필수다 (DDL ck_external_warehouse_partner)',
    default: false,
  })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isExternal?: boolean;

  @ApiPropertyOptional({ description: '외부창고·외주처 거래처 코드' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  partnerCode?: string;

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateWarehouseDto extends PartialType(
  OmitType(CreateWarehouseDto, ['legalEntityCode', 'plantCode', 'warehouseCode'] as const),
) {}

export class CreateLocationDto {
  @ApiProperty({ description: '로케이션 코드', example: 'A-01-01', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  locationCode!: string;

  @ApiProperty({ description: '로케이션명', example: 'A구역 1랙 1셀', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  locationName!: string;

  @ApiProperty({
    description: '로케이션 유형 — 공통코드 그룹 LOCATION_TYPE (구역/랙/셀/입하장)',
    example: 'CELL',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  locationTypeCode!: string;

  @ApiPropertyOptional({
    description: '품질구역 — 공통코드 그룹 QUALITY_ZONE (가용/검사대기/보류/격리)',
    example: 'AVAILABLE',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  qualityZoneCode?: string;

  @ApiPropertyOptional({
    description: '보관조건 — 공통코드 그룹 STORAGE_CONDITION (온도·습도·위험물)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  storageConditionCode?: string;

  @ApiPropertyOptional({ description: '상위 로케이션 코드 (같은 창고 내)' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  parentLocationCode?: string;

  @ApiPropertyOptional({ description: '복수 품목 혼재 허용', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  allowMixedItem?: boolean;

  @ApiPropertyOptional({ description: '복수 LOT 혼재 허용', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  allowMixedLot?: boolean;

  @ApiPropertyOptional({
    description: '수용량. capacityUomCode와 반드시 함께 지정한다 (DDL ck_location_capacity)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  capacityQty?: number;

  @ApiPropertyOptional({ description: '수용량 단위 코드' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  capacityUomCode?: string;

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateLocationDto extends PartialType(
  OmitType(CreateLocationDto, ['locationCode'] as const),
) {}

export class WarehouseQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '공장으로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  plantCode?: string;
}

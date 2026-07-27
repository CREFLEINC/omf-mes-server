import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import { PageQueryDto, toOptionalBoolean } from '../../common/dto/page-query.dto';
import { CODE_PATTERN } from '../common-code/dto/code-group.dto';

const codeRule = { message: '코드는 영문 대문자·숫자·언더스코어만 사용합니다.' };

/**
 * 생산라인 — mdm.production_line. 자연키 = (plant_id, line_code)
 * `line_type_code`는 DDL 주석이 값을 명시한다: LINE | WORK_AREA.
 * 작업구역은 parent로 라인 하위에 계층 구성한다.
 */
export class CreateProductionLineDto {
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

  @ApiProperty({ description: '라인 코드', example: 'LINE_A', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, codeRule)
  lineCode!: string;

  @ApiProperty({ description: '라인명', example: 'A라인', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  lineName!: string;

  @ApiPropertyOptional({
    description: '라인 유형 — 코드그룹 LINE_TYPE (LINE=라인 / WORK_AREA=작업구역)',
    default: 'LINE',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  lineTypeCode?: string;

  @ApiPropertyOptional({ description: '상위 라인 코드 (같은 공장 내) — 작업구역이 라인 하위로 붙는다' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  parentLineCode?: string;

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateProductionLineDto extends PartialType(
  OmitType(CreateProductionLineDto, ['legalEntityCode', 'plantCode', 'lineCode'] as const),
) {}

/** 설비 — mdm.equipment. 자연키 = (plant_id, equipment_code) */
export class CreateEquipmentDto {
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

  @ApiProperty({ description: '설비 코드', example: 'EQ_INJ_01', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, codeRule)
  equipmentCode!: string;

  @ApiProperty({ description: '설비명', example: '사출기 1호', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  equipmentName!: string;

  @ApiProperty({
    description: '설비 유형 — 코드그룹 EQUIPMENT_TYPE (생산설비/검사장비/유틸리티)',
    example: 'MACHINE',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  equipmentTypeCode!: string;

  @ApiProperty({
    description: '설비 상태 — 코드그룹 EQUIPMENT_STATUS (신규입고/정상/점검중/고장/폐기)',
    example: 'NORMAL',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  statusCode!: string;

  @ApiPropertyOptional({ description: '담당 공정 코드' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  processCode?: string;

  @ApiPropertyOptional({ description: '소속 생산라인 코드 (같은 공장 내)' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  productionLineCode?: string;

  @ApiPropertyOptional({
    description: '교정관리 대상 여부 — 검사장비의 교정 유효기간 관리에 쓴다',
    default: false,
  })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  calibrationRequired?: boolean;

  @ApiPropertyOptional({ description: '최종 교정일 (YYYY-MM-DD)' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  lastCalibrationDate?: Date;

  @ApiPropertyOptional({ description: '교정 만료일 (YYYY-MM-DD)' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  calibrationDueDate?: Date;

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateEquipmentDto extends PartialType(
  OmitType(CreateEquipmentDto, ['legalEntityCode', 'plantCode', 'equipmentCode'] as const),
) {}

/** 설비 목록 쿼리 — 추가 필터는 PageQueryDto를 확장해 선언해야 400을 피한다. */
export class EquipmentQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '공장으로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  plantCode?: string;

  @ApiPropertyOptional({ description: '설비 유형으로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  equipmentTypeCode?: string;

  @ApiPropertyOptional({ description: '설비 상태로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  statusCode?: string;

  @ApiPropertyOptional({ description: '교정 만료가 임박·경과한 설비만 (기준일 이전)' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  calibrationDueBefore?: Date;
}

/** 생산라인 목록 쿼리 */
export class ProductionLineQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '공장으로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  plantCode?: string;

  @ApiPropertyOptional({ description: '라인 유형으로 좁혀 조회 — LINE / WORK_AREA' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  lineTypeCode?: string;
}

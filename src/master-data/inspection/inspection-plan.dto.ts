import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

import {
  BasePageQueryDto,
  PageQueryDto,
  toOptionalBoolean,
} from '../../common/dto/page-query.dto';
import { CODE_PATTERN, CODE_RULE } from '../common-code/dto/code-group.dto';

/**
 * 검사기준은 MES 정본이다 — ERP 수신 대상이 아니다(QA #4).
 * 헤더(무엇을 검사하나)와 버전(어떻게 뽑아 어떤 주기로 보나)을 나눠 둔 구조라
 * 기준값 개정은 새 버전을 만들어 이력을 남긴다.
 */
export class CreateInspectionPlanDto {
  @ApiProperty({ description: '검사기준 코드 — 전역 유일', example: 'IP_COVER_IQC', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, CODE_RULE)
  inspectionPlanCode!: string;

  @ApiProperty({ description: '검사기준 명칭', example: '커버 수입검사 기준', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  inspectionPlanName!: string;

  @ApiProperty({ description: '검사유형 — 코드그룹 INSPECTION_TYPE (IQC/PQC/OQC)', example: 'IQC' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  inspectionTypeCode!: string;

  @ApiPropertyOptional({ description: '대상 품목코드 — 품목 무관 기준이면 생략' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  itemCode?: string;

  @ApiPropertyOptional({ description: '대상 공정코드 — PQC에서 주로 쓴다' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  processCode?: string;

  @ApiPropertyOptional({ description: '적용 라우팅 ID — 특정 라우팅 Rev에만 적용할 때' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  routingId?: number;

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateInspectionPlanDto extends PartialType(
  OmitType(CreateInspectionPlanDto, ['inspectionPlanCode'] as const),
) {}

export class InspectionPlanQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '검사유형으로 좁혀 조회 — IQC/PQC/OQC' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  inspectionTypeCode?: string;

  @ApiPropertyOptional({ description: '대상 품목코드로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  itemCode?: string;

  @ApiPropertyOptional({ description: '대상 공정코드로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  processCode?: string;
}

export class CreateInspectionPlanVersionDto {
  @ApiProperty({ description: '기준 버전 — 1부터', example: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  planVersion!: number;

  @ApiProperty({ description: '개정 상태 — 코드그룹 REVISION_STATUS', example: 'DRAFT' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  statusCode!: string;

  @ApiProperty({
    description: '샘플링 방식 — 코드그룹 SAMPLING_METHOD (FULL/FIXED/AQL)',
    example: 'AQL',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  samplingMethodCode!: string;

  @ApiPropertyOptional({ description: '샘플 수량 — FIXED 방식일 때 필요' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  samplingQty?: number;

  @ApiPropertyOptional({ description: 'AQL 값 — AQL 방식일 때 필요', example: 2.5 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  aqlValue?: number;

  @ApiPropertyOptional({ description: '합격 판정개수 (Ac)', minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  acceptanceNumber?: number;

  @ApiPropertyOptional({ description: '불합격 판정개수 (Re) — Ac보다 커야 한다', minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  rejectionNumber?: number;

  @ApiProperty({
    description: '검사 주기 — 코드그룹 INSPECTION_FREQUENCY (LOT/초중종/자주/주기)',
    example: 'EVERY_LOT',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  inspectionFrequencyCode!: string;

  @ApiPropertyOptional({ description: '주기 간격값 — PERIODIC일 때 필요', example: 2 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  frequencyIntervalValue?: number;

  @ApiPropertyOptional({
    description: '주기 간격 단위 — 코드그룹 FREQUENCY_INTERVAL_UOM. PERIODIC일 때 필요',
    example: 'HOUR',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  frequencyIntervalUomCode?: string;

  @ApiProperty({ description: '유효 시작일 (YYYY-MM-DD)', example: '2026-01-01' })
  @Type(() => Date)
  @IsDate()
  effectiveFrom!: Date;

  @ApiPropertyOptional({ description: '유효 종료일 (YYYY-MM-DD)' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  effectiveTo?: Date;
}

/** 버전 번호는 그 버전의 정체성이라 수정 대상이 아니다 — 바꾸려면 새 버전을 만든다. */
export class UpdateInspectionPlanVersionDto extends PartialType(
  OmitType(CreateInspectionPlanVersionDto, ['planVersion'] as const),
) {}

export class InspectionPlanVersionQueryDto extends BasePageQueryDto {
  @ApiPropertyOptional({ description: '개정 상태로 좁혀 조회 — 예: ACTIVE' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  statusCode?: string;
}

export class CreateInspectionItemSpecDto {
  @ApiProperty({ description: '검사항목 순서 — 버전 내 유일', example: 10, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sequenceNo!: number;

  @ApiProperty({ description: '검사항목 코드', example: 'DIM_WIDTH', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, CODE_RULE)
  inspectionItemCode!: string;

  @ApiProperty({ description: '검사항목 명칭', example: '폭 치수', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  inspectionItemName!: string;

  @ApiProperty({
    description: '데이터유형 — 코드그룹 INSPECTION_DATA_TYPE (NUMERIC/BOOLEAN/TEXT)',
    example: 'NUMERIC',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  dataTypeCode!: string;

  @ApiPropertyOptional({ description: '측정 단위코드 — 계량형일 때', example: 'MM' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  uomCode?: string;

  @ApiPropertyOptional({ description: '목표값 (Target)', example: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  targetValue?: number;

  @ApiPropertyOptional({ description: '하한 (LCL)', example: 99.5 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  lowerLimit?: number;

  @ApiPropertyOptional({ description: '상한 (UCL) — 하한보다 크거나 같아야 한다', example: 100.5 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  upperLimit?: number;

  @ApiPropertyOptional({ description: '항목별 측정횟수', default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  measurementCount?: number;

  @ApiPropertyOptional({ description: '검사방법 — 코드그룹 INSPECTION_METHOD', example: 'MEASURE' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  inspectionMethodCode?: string;

  @ApiPropertyOptional({ description: '지정 검사장비 코드 — mdm.equipment' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  defaultInspectionEquipmentCode?: string;

  @ApiPropertyOptional({ description: '필수 항목 여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  requiredFlag?: boolean;

  @ApiPropertyOptional({
    description: '자동판정 여부 — 계량형 자동판정은 상·하한 중 하나가 있어야 한다',
    default: true,
  })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  automaticJudgment?: boolean;
}

export class UpdateInspectionItemSpecDto extends PartialType(CreateInspectionItemSpecDto) {}

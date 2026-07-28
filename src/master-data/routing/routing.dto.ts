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
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { BasePageQueryDto, toOptionalBoolean } from '../../common/dto/page-query.dto';
import { CODE_PATTERN, CODE_RULE } from '../common-code/dto/code-group.dto';

/**
 * 라우팅은 `품목 × 라우팅코드 × Rev`로만 유일하다(uq_routing) — 라우팅코드 단독은 유일하지 않다.
 * 그래서 단건 경로 키는 코드가 아니라 routingId를 쓴다. 코드로 찾을 때는 목록 필터를 쓴다.
 */
export class CreateRoutingDto {
  @ApiProperty({ description: '대상 품목코드', example: 'ITEM_0001' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  itemCode!: string;

  @ApiProperty({ description: '라우팅 코드', example: 'RT_COVER', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, CODE_RULE)
  routingCode!: string;

  @ApiProperty({ description: '라우팅 Rev — 1부터', example: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  routingVersion!: number;

  @ApiProperty({ description: '개정 상태 — 코드그룹 REVISION_STATUS', example: 'DRAFT' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  statusCode!: string;

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

/** 품목·코드·Rev는 라우팅의 정체성이라 수정 대상이 아니다 — 바꾸려면 새 Rev를 만든다. */
export class UpdateRoutingDto extends PartialType(
  OmitType(CreateRoutingDto, ['itemCode', 'routingCode', 'routingVersion'] as const),
) {}

export class RoutingQueryDto extends BasePageQueryDto {
  @ApiPropertyOptional({ description: '품목코드로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  itemCode?: string;

  @ApiPropertyOptional({ description: '개정 상태로 좁혀 조회 — 예: ACTIVE' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  statusCode?: string;
}

/**
 * 공정별 세부 운영 속성은 공정 마스터가 아니라 이 라인이 갖는다 —
 * 같은 공정도 품목·라우팅에 따라 MES 관리 여부와 표준값이 다르다.
 */
export class CreateRoutingOperationDto {
  @ApiProperty({ description: '공정 순서 — 라우팅 내 유일', example: 10, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  operationSeq!: number;

  @ApiProperty({ description: '공정코드 — mdm.process', example: 'MOLDING' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  processCode!: string;

  @ApiProperty({ description: '공정 라인 명칭', example: '사출 1차', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  operationName!: string;

  @ApiPropertyOptional({ description: 'MES 관리 공정 여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  mesManaged?: boolean;

  @ApiPropertyOptional({ description: '자재투입 관리 여부', default: false })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  materialInputManaged?: boolean;

  @ApiPropertyOptional({ description: '생산실적 관리 여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  productionResultManaged?: boolean;

  @ApiPropertyOptional({
    description: 'PQC 검사 공정 명시 — 미명시면 PQC는 항상 생략된다(PQC=opt-in)',
    default: false,
  })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  inspectionManaged?: boolean;

  @ApiPropertyOptional({ description: '산출 LOT 생성 필요 여부', default: false })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  outputLotRequired?: boolean;

  @ApiPropertyOptional({ description: '설비 지정 필수 여부', default: false })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  equipmentRequired?: boolean;

  @ApiPropertyOptional({ description: '금형 지정 필수 여부', default: false })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  moldRequired?: boolean;

  @ApiPropertyOptional({ description: '표준 C/T(초) — 0보다 커야 한다', example: 42.5 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  standardCycleTimeSec?: number;

  @ApiPropertyOptional({ description: '표준 수율 — 0~1 비율', example: 0.98, minimum: 0, maximum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  standardYieldRate?: number;
}

export class UpdateRoutingOperationDto extends PartialType(CreateRoutingOperationDto) {}

export class CreateRoutingDependencyDto {
  @ApiProperty({ description: '선행 공정 순서', example: 10, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  predecessorSeq!: number;

  @ApiProperty({ description: '후행 공정 순서', example: 20, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  successorSeq!: number;

  @ApiPropertyOptional({
    description: '선후행 유형 — 코드그룹 DEPENDENCY_TYPE',
    default: 'FINISH_TO_START',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  dependencyTypeCode?: string;
}

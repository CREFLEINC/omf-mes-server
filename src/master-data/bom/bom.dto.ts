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
 * BOM 정본은 ERP(UNIERP)다 — 이 API는 수신본 조회와 MES 측 보정을 위한 통로다.
 * 라우팅과 마찬가지로 `부모품목 × BOM코드 × Rev`로만 유일해 경로 키는 bomId를 쓴다.
 */
export class CreateBomDto {
  @ApiProperty({ description: '부모(산출) 품목코드', example: 'ITEM_0001' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  parentItemCode!: string;

  @ApiProperty({ description: 'BOM 코드', example: 'BOM_COVER', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, CODE_RULE)
  bomCode!: string;

  @ApiProperty({ description: 'BOM Rev — 1부터', example: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  bomVersion!: number;

  @ApiProperty({ description: '개정 상태 — 코드그룹 REVISION_STATUS', example: 'DRAFT' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  statusCode!: string;

  @ApiProperty({ description: '기준 산출수량 — 0보다 커야 한다', example: 1 })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  baseQty!: number;

  @ApiProperty({ description: '기준수량 단위코드 — mdm.uom', example: 'EA' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  baseUomCode!: string;

  @ApiPropertyOptional({
    description: '기본 BOM 여부 — 품목당 1개. true로 바꾸면 기존 기본 BOM은 자동 해제된다',
    default: false,
  })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isDefault?: boolean;

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

/** 부모품목·코드·Rev는 BOM의 정체성이라 수정 대상이 아니다 — 바꾸려면 새 Rev를 만든다. */
export class UpdateBomDto extends PartialType(
  OmitType(CreateBomDto, ['parentItemCode', 'bomCode', 'bomVersion'] as const),
) {}

export class BomQueryDto extends BasePageQueryDto {
  @ApiPropertyOptional({ description: '부모 품목코드로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  parentItemCode?: string;

  @ApiPropertyOptional({ description: '개정 상태로 좁혀 조회 — 예: ACTIVE' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  statusCode?: string;

  @ApiPropertyOptional({ description: '기본 BOM만 조회' })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isDefault?: boolean;
}

export class CreateBomComponentDto {
  @ApiProperty({ description: 'BOM 내 라인 순서 — BOM 내 유일', example: 10, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sequenceNo!: number;

  @ApiProperty({ description: '구성(투입) 품목코드', example: 'ITEM_9001' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  componentItemCode!: string;

  @ApiProperty({ description: '소요량 — 0보다 커야 한다', example: 2 })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  requiredQty!: number;

  @ApiProperty({ description: '소요량 단위코드', example: 'EA' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  uomCode!: string;

  @ApiPropertyOptional({
    description:
      'MES 등록(관리) 공정의 라우팅 공정 ID. 공정 순서는 라우팅 Rev마다 달라 순서가 아니라 ID로 지정한다 ' +
      '— `GET /master/routings/{routingId}`가 돌려주는 routingOperationId를 쓴다',
    example: 5,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  routingOperationId?: number;

  @ApiPropertyOptional({
    description: '실제 소비 공정코드 — 관리 공정과 실물 소비 공정이 다를 때만',
    example: 'ASSEMBLY',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  actualUseProcessCode?: string;

  @ApiPropertyOptional({ description: '손실률 — 0~1 비율', default: 0, minimum: 0, maximum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  scrapRate?: number;

  @ApiPropertyOptional({ description: '필수 투입 여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isMandatory?: boolean;

  @ApiPropertyOptional({ description: '투입 LOT 추적 필요 여부', default: false })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  lotTraceRequired?: boolean;

  @ApiPropertyOptional({ description: '역산소비(백플러시) 허용 여부', default: false })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  backflushAllowed?: boolean;
}

export class UpdateBomComponentDto extends PartialType(CreateBomComponentDto) {}

export class CreateSubstitutionRuleDto {
  @ApiProperty({ description: '대체 품목코드', example: 'ITEM_9002' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  substituteItemCode!: string;

  @ApiPropertyOptional({ description: '적용 우선순위 — 작을수록 먼저', default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  priorityNo?: number;

  @ApiPropertyOptional({ description: '최대 대체 수량 — 미지정 시 제한 없음' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  maxSubstituteQty?: number;

  @ApiPropertyOptional({ description: '대체 시 승인 필요 여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  approvalRequired?: boolean;

  @ApiPropertyOptional({
    description: '대체를 금지하는 고객 거래처코드 — 해당 고객 물량에는 대체를 쓰지 않는다',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  customerRestrictionCode?: string;

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

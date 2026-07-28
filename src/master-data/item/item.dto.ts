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

import { PageQueryDto, toOptionalBoolean } from '../../common/dto/page-query.dto';
import { CODE_PATTERN, CODE_RULE } from '../common-code/dto/code-group.dto';

export class CreateItemDto {
  @ApiProperty({ description: '품목코드', example: 'ITEM_0001', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, CODE_RULE)
  itemCode!: string;

  @ApiProperty({ description: '품목명', example: '사출 커버', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  itemName!: string;

  @ApiProperty({ description: '품목구분 — 코드그룹 ITEM_TYPE', example: 'RAW' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  itemTypeCode!: string;

  @ApiProperty({ description: '기본 재고단위 코드 — mdm.uom', example: 'EA' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  baseUomCode!: string;

  @ApiProperty({ description: 'LOT 관리방식 — 코드그룹 LOT_CONTROL_TYPE', example: 'LOT' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  lotControlTypeCode!: string;

  @ApiPropertyOptional({
    description: '일련번호 관리방식 — 코드그룹 SERIAL_CONTROL_TYPE',
    default: 'NONE',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  serialControlTypeCode?: string;

  @ApiPropertyOptional({
    description: '선출 정책 — 코드그룹 FIFO_POLICY. FEFO는 유효기간(shelfLifeDays) 관리 품목만',
    default: 'FIFO',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  fifoPolicyCode?: string;

  @ApiPropertyOptional({ description: '유효기간(일). 지정하면 유효기간 관리 품목이 된다', minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  shelfLifeDays?: number;

  @ApiPropertyOptional({ description: '개봉 후 사용 가능시간(시간). 0보다 커야 한다' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  openedShelfLifeHours?: number;

  @ApiPropertyOptional({ description: '수입검사 기본 여부', default: false })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  inspectionRequired?: boolean;

  @ApiPropertyOptional({ description: '음수재고 허용 여부', default: false })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  negativeStockAllowed?: boolean;

  @ApiPropertyOptional({ description: '보관조건 — 코드그룹 STORAGE_CONDITION' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  storageConditionCode?: string;

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateItemDto extends PartialType(OmitType(CreateItemDto, ['itemCode'] as const)) {}

export class CreateUomConversionDto {
  @ApiProperty({ description: '환산 전 단위 코드', example: 'BOX' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  fromUomCode!: string;

  @ApiProperty({ description: '환산 후 단위 코드', example: 'EA' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  toUomCode!: string;

  @ApiProperty({ description: '환산율 — 0보다 커야 한다', example: 24 })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  conversionRate!: number;

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

export class CreateExternalCodeDto {
  @ApiProperty({ description: '외부 시스템 구분 코드', example: 'ERP' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  externalSystemCode!: string;

  @ApiProperty({ description: '외부 시스템의 품목코드', example: 'A-1234', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  externalItemCode!: string;

  @ApiPropertyOptional({ description: '거래처 코드 — 거래처별 품목코드인 경우' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  partnerCode?: string;
}

export class CreateBuItemMapDto {
  @ApiProperty({ description: '출발 사업부 코드', example: 'PARTS' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  fromBusinessUnitCode!: string;

  @ApiProperty({ description: '도착 사업부 코드', example: 'OA' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  toBusinessUnitCode!: string;

  @ApiProperty({ description: '도착 사업부의 품목코드', example: 'ITEM_9001' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  toItemCode!: string;

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

/**
 * 품목 목록 쿼리.
 *
 * ValidationPipe가 `forbidNonWhitelisted`라 DTO에 없는 쿼리 파라미터는 400이 된다.
 * 추가 필터는 반드시 PageQueryDto를 확장해 선언해야 한다.
 */
export class ItemQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '품목구분으로 좁혀 조회 — 코드그룹 ITEM_TYPE' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  itemTypeCode?: string;
}

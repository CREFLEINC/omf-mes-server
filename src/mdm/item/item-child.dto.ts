import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { IsDateOnly } from '../date-only.validator';

/**
 * 부속 목록은 **통째로 갈아끼운다**(공유계약 B-6). 개별 추가·삭제가 없으므로 보낸 것이
 * 최종 상태이고, 안 보낸 행은 지워진다.
 *
 * 상한을 둔다. 없으면 한 요청으로 수만 행을 밀어 넣어 트랜잭션이 테이블을 잠근다.
 */
const MAX_ROWS = 500;



export class UomConversionRowDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly fromUomId!: number;

  @ApiProperty({ description: 'ck_item_uom_distinct — fromUomId 와 같으면 불가' })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly toUomId!: number;

  @ApiProperty({ description: 'numeric(18,8) · CHECK > 0' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @IsPositive()
  readonly conversionRate!: number;

  @ApiProperty({ example: '2026-08-07' })
  @IsDateOnly()
  readonly effectiveFrom!: string;

  @ApiPropertyOptional({ description: 'ck_item_uom_dates — 있으면 effectiveFrom 이상' })
  @IsOptional()
  @IsDateOnly()
  readonly effectiveTo?: string | null;
}

export class ReplaceUomConversionsDto {
  @ApiProperty({ type: [UomConversionRowDto] })
  @IsArray()
  @ArrayMaxSize(MAX_ROWS)
  @ValidateNested({ each: true })
  @Type(() => UomConversionRowDto)
  readonly conversions!: UomConversionRowDto[];
}

export class ExternalCodeRowDto {
  @ApiProperty({ description: '공통코드' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  readonly externalSystemCode!: string;

  @ApiPropertyOptional({ description: '비우면 (전체) — 공유계약 A-7' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly partnerId?: number | null;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  readonly externalItemCode!: string;
}

export class ReplaceExternalCodesDto {
  @ApiProperty({ type: [ExternalCodeRowDto] })
  @IsArray()
  @ArrayMaxSize(MAX_ROWS)
  @ValidateNested({ each: true })
  @Type(() => ExternalCodeRowDto)
  readonly externalCodes!: ExternalCodeRowDto[];
}

export class BuItemMapRowDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly fromBusinessUnitId!: number;

  @ApiProperty({ description: 'ck_item_bu_map_distinct — fromBusinessUnitId 와 같으면 불가' })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly toBusinessUnitId!: number;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly toItemId!: number;

  @ApiProperty({ example: '2026-08-07' })
  @IsDateOnly()
  readonly effectiveFrom!: string;

  @ApiPropertyOptional({ description: 'ck_item_bu_map_dates — 있으면 effectiveFrom 이상' })
  @IsOptional()
  @IsDateOnly()
  readonly effectiveTo?: string | null;
}

export class ReplaceBuItemMapsDto {
  @ApiProperty({ type: [BuItemMapRowDto] })
  @IsArray()
  @ArrayMaxSize(MAX_ROWS)
  @ValidateNested({ each: true })
  @Type(() => BuItemMapRowDto)
  readonly maps!: BuItemMapRowDto[];
}

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
  registerDecorator,
  ValidateNested,
} from 'class-validator';

/**
 * 부속 목록은 **통째로 갈아끼운다**(공유계약 B-6). 개별 추가·삭제가 없으므로 보낸 것이
 * 최종 상태이고, 안 보낸 행은 지워진다.
 *
 * 상한을 둔다. 없으면 한 요청으로 수만 행을 밀어 넣어 트랜잭션이 테이블을 잠근다.
 */
const MAX_ROWS = 500;

/**
 * `@db.Date` 컬럼이다 — `2026-08-07` 형태만 받는다.
 *
 * `IsDateString` 을 쓰면 안 된다. `2026-01-01T00:00:00Z`(시각 포함)도, `2026-02-30`
 * (없는 날)도 통과한다 — 확인해봤다. 앞은 타임존을 태워 하루를 밀 수 있고, 뒤는
 * Prisma 를 지나 DB 에서 터져 500 이 된다.
 *
 * 형태를 정규식으로 보고, 그 문자열이 **왕복해서 그대로 나오는지**로 실재하는 날인지
 * 본다 — `2026-02-30` 은 `2026-03-02` 로 굴러가 걸린다.
 */
function IsDateOnly() {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isDateOnly',
      target: object.constructor,
      propertyName,
      validator: {
        validate: (value: unknown) => typeof value === 'string' && isDateOnly(value),
        defaultMessage: () => 'YYYY-MM-DD 형태의 실재하는 날짜여야 합니다.',
      },
    });
}

function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const parsed = new Date(`${value}T00:00:00.000Z`);

  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const DateOnly = () => IsDateOnly();

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
  @DateOnly()
  readonly effectiveFrom!: string;

  @ApiPropertyOptional({ description: 'ck_item_uom_dates — 있으면 effectiveFrom 이상' })
  @IsOptional()
  @DateOnly()
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
  @DateOnly()
  readonly effectiveFrom!: string;

  @ApiPropertyOptional({ description: 'ck_item_bu_map_dates — 있으면 effectiveFrom 이상' })
  @IsOptional()
  @DateOnly()
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

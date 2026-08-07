import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/** `IsNotEmpty` 는 '   ' 를 통과시킨다. 계약이 「공백만 불가」로 명시했으므로 먼저 다듬는다. */
const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class CreateLocationDto {
  @ApiProperty({ description: '좌측에서 고른 창고로 고정 — 등록에서만 받는다' })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly warehouseId!: number;

  @ApiPropertyOptional({ description: '「하위 추가」 시 부모. 자기 자신·순환 금지' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly parentLocationId?: number | null;

  @ApiProperty({ description: 'warehouseId 내 유일 — uq_location. 공백만 불가' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  readonly locationCode!: string;

  @ApiProperty()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  readonly locationName!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  readonly locationTypeCode!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  readonly qualityZoneCode?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  readonly storageConditionCode?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readonly allowMixedItem: boolean = true;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readonly allowMixedLot: boolean = true;

  @ApiPropertyOptional({ description: 'capacityUomId 와 함께 있거나 함께 비어야 한다' })
  @IsOptional()
  @Type(() => Number)
  // numeric(20,6) 이라 정수가 아니어도 된다 — 0.5 팔레트 같은 값이 온다.
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  readonly capacityQty?: number | null;

  @ApiPropertyOptional({ description: 'capacityQty 와 함께 있거나 함께 비어야 한다' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly capacityUomId?: number | null;
}

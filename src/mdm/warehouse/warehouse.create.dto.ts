import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

/** `IsNotEmpty` 는 '   ' 를 통과시킨다. 계약이 「공백만 불가」로 명시했으므로 먼저 다듬는다. */
const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class CreateWarehouseDto {
  @ApiProperty({ description: '등록 후 변경 불가 — 근거: W-06-07 §4-A' })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly plantId!: number;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly businessUnitId!: number;

  @ApiProperty({ description: 'plantId 내 유일 — uq_warehouse. 공백만 불가' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  readonly warehouseCode!: string;

  @ApiProperty()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  readonly warehouseName!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  readonly warehouseTypeCode!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  readonly managementLevelCode!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  readonly isExternal: boolean = false;

  @ApiPropertyOptional({ description: 'isExternal 이 참이면 필수 — ck_external_warehouse_partner' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly partnerId?: number | null;
}

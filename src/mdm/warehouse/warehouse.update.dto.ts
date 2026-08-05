import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

/** `IsNotEmpty` 는 '   ' 를 통과시킨다. 계약이 「공백만 불가」로 명시했으므로 먼저 다듬는다. */
const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/**
 * `PUT` 이라 **전체 교체**다. 안 보낸 선택 필드는 지워진다 — `PATCH` 처럼 일부만 보낼 수 없다.
 *
 * `plantId` 와 `isActive` 는 아예 받지 않는다. 공장은 등록 후 변경 불가(W-06-07 §4-A),
 * `isActive` 는 `:deactivate` 액션으로만 바꾼다(§5-1). `forbidNonWhitelisted` 가
 * 보내면 400 으로 막는다.
 */
export class UpdateWarehouseDto {
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

  @ApiProperty({ description: '수정에서는 필수다 — 전체 교체이므로 현재 값을 보내야 한다' })
  @IsBoolean()
  readonly isExternal!: boolean;

  @ApiPropertyOptional({ description: 'isExternal 이 참이면 필수 — ck_external_warehouse_partner' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly partnerId?: number | null;
}

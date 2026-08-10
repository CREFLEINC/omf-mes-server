import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * 품목은 **ERP 수신본**이다. 원본 4열(`itemCode`·`itemName`·`itemTypeCode`·`baseUomId`)을
 * **아예 받지 않는다** — 계약이 그렇게 정했고(§4-B), 보낼 방법이 없으니 읽기 전용 판정을
 * 런타임에 할 필요가 없다. 보내면 `forbidNonWhitelisted` 가 400 을 낸다.
 *
 * 이것이 `#65`(수신본 식별 플래그 부재)를 이 API 에서 우회하는 방식이다 — 공통코드처럼
 * 「판정할 컬럼이 없어 못 막는다」가 되지 않는다.
 *
 * `isActive` 는 여기서 받는다. 품목에는 `:deactivate` 액션이 없다 — ERP 가 보내오는
 * 상태이므로 별도 액션이 아니라 확장 속성과 함께 갱신된다.
 *
 * 「유효기한 관리」 토글은 별도 컬럼이 아니라 `shelfLifeDays` 의 null 여부로 표현한다(§8-2).
 */
export class UpdateItemDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  readonly lotControlTypeCode!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  readonly serialControlTypeCode!: string;

  @ApiPropertyOptional({ description: 'null 이면 유효기한 관리 안 함' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  readonly shelfLifeDays?: number | null;

  @ApiProperty()
  @IsBoolean()
  readonly inspectionRequired!: boolean;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  readonly fifoPolicyCode!: string;

  @ApiProperty()
  @IsBoolean()
  readonly negativeStockAllowed!: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  readonly storageConditionCode?: string | null;

  @ApiPropertyOptional({ description: '개봉 후 유효시간 — 있으면 0 보다 커야 한다' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly openedShelfLifeHours?: number | null;

  @ApiProperty()
  @IsBoolean()
  readonly isActive!: boolean;
}

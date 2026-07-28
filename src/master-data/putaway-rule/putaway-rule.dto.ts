import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
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

import { PageQueryDto, toOptionalBoolean } from '../../common/dto/page-query.dto';

/**
 * 적치규칙 — 입고분을 어느 창고·로케이션에 얼마나 둘지.
 * `품목 × 창고 × 로케이션`이 유니크인데 로케이션이 nullable이라(창고 단위 규칙 허용)
 * 부분 유니크 인덱스로 표현돼 있다. 경로 키는 ruleId를 쓴다.
 */
export class CreatePutawayRuleDto {
  @ApiProperty({ description: '대상 품목코드', example: 'ITEM_0001' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  itemCode!: string;

  @ApiProperty({ description: '적치 창고코드', example: 'WH_MAT' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  warehouseCode!: string;

  @ApiPropertyOptional({
    description: '적치 로케이션코드 — 미지정 시 창고 단위 규칙',
    example: 'A-01-01',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  locationCode?: string;

  @ApiProperty({ description: '수용량 — 0보다 커야 한다', example: 1000 })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  capacityQty!: number;

  @ApiProperty({ description: '수용량 단위코드', example: 'EA' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  uomCode!: string;

  @ApiPropertyOptional({
    description: '적용 우선순위 — 작을수록 먼저 채운다',
    default: 100,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  priorityNo?: number;

  @ApiPropertyOptional({ description: '비고' })
  @IsOptional()
  @IsString()
  remarks?: string;

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

/** 품목·창고·로케이션은 규칙의 정체성이라 수정 대상이 아니다 — 바꾸려면 새 규칙을 만든다. */
export class UpdatePutawayRuleDto extends PartialType(
  OmitType(CreatePutawayRuleDto, ['itemCode', 'warehouseCode', 'locationCode'] as const),
) {}

export class PutawayRuleQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '품목코드로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  itemCode?: string;

  @ApiPropertyOptional({ description: '창고코드로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  warehouseCode?: string;
}

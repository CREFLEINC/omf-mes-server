import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

import { PageQueryDto, toOptionalBoolean } from '../../common/dto/page-query.dto';
import { CODE_PATTERN } from '../common-code/dto/code-group.dto';

export class CreateMoldDto {
  @ApiProperty({ description: '소속 법인 코드', example: 'OMF_VN' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  legalEntityCode!: string;

  @ApiProperty({ description: '소속 공장 코드', example: 'PLANT1' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  plantCode!: string;

  @ApiProperty({ description: '금형 코드', example: 'MOLD_A01', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, { message: '금형 코드는 영문 대문자·숫자·언더스코어만 사용합니다.' })
  moldCode!: string;

  @ApiProperty({ description: '금형명', example: '커버 상형', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  moldName!: string;

  @ApiPropertyOptional({ description: 'Cavity 수 — 1 이상', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  cavityCount?: number;

  @ApiPropertyOptional({
    description: '보증 타발수(적정타수). 툴 PM의 타발수 축 기준값',
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  guaranteedShotCount?: number;

  @ApiPropertyOptional({
    description:
      '현재 누적 타발수. 운영 중 누적은 생산 실적이 갱신할 몫이고, 여기서는 초기값·보정용이다',
    default: 0,
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  currentShotCount?: number;

  @ApiProperty({
    description: '금형 상태 — 코드그룹 MOLD_STATUS (신규입고/정상/수리중/폐기)',
    example: 'NORMAL',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  statusCode!: string;

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateMoldDto extends PartialType(
  OmitType(CreateMoldDto, ['legalEntityCode', 'plantCode', 'moldCode'] as const),
) {}

export class MoldQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '공장으로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  plantCode?: string;

  @ApiPropertyOptional({ description: '금형 상태로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  statusCode?: string;

  @ApiPropertyOptional({ description: '누적 타발수가 이 값 이상인 금형만' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  shotCountGte?: number;
}

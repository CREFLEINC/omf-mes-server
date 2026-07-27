import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

import { toOptionalBoolean } from '../../../common/dto/page-query.dto';
import { CODE_PATTERN } from './code-group.dto';

export class CreateCodeValueDto {
  @ApiProperty({ description: '코드값', example: 'RAW', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, { message: '코드값은 영문 대문자·숫자·언더스코어만 사용합니다.' })
  code!: string;

  @ApiProperty({ description: '코드명', example: '자재', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  codeName!: string;

  @ApiPropertyOptional({ description: '정렬순서', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  displayOrder?: number;

  @ApiPropertyOptional({ description: '유효 시작일 (YYYY-MM-DD)' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  effectiveFrom?: Date;

  @ApiPropertyOptional({ description: '유효 종료일 (YYYY-MM-DD)' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  effectiveTo?: Date;

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateCodeValueDto extends PartialType(
  OmitType(CreateCodeValueDto, ['code'] as const),
) {}

import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { DataSource } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
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

  @ApiProperty({ description: '코드명 (한국어)', example: '자재', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  nameKo!: string;

  @ApiPropertyOptional({ description: '코드명 (베트남어)', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameVi?: string;

  @ApiPropertyOptional({ description: '설명', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: '부가 속성 1', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  attr1?: string;

  @ApiPropertyOptional({ description: '부가 속성 2', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  attr2?: string;

  @ApiPropertyOptional({ description: '정렬순서', default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  useYn?: boolean;

  @ApiPropertyOptional({
    description: '정본 출처 — ERP는 연계 수신본(수정·삭제 불가)',
    enum: DataSource,
    default: DataSource.MES,
  })
  @IsOptional()
  @IsEnum(DataSource)
  source?: DataSource;
}

export class UpdateCodeValueDto extends PartialType(
  OmitType(CreateCodeValueDto, ['code', 'source'] as const),
) {}

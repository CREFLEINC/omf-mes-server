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

/** 코드는 영문 대문자·숫자·언더스코어만 허용한다 (ERP 연계 키와의 표기 충돌 방지) */
export const CODE_PATTERN = /^[A-Z0-9_]+$/;

export class CreateCodeGroupDto {
  @ApiProperty({ description: '코드그룹 (자연키)', example: 'ITEM_TYPE', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, { message: '코드그룹은 영문 대문자·숫자·언더스코어만 사용합니다.' })
  code!: string;

  @ApiProperty({ description: '코드그룹명 (한국어)', example: '품목구분', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  nameKo!: string;

  @ApiPropertyOptional({ description: '코드그룹명 (베트남어)', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameVi?: string;

  @ApiPropertyOptional({ description: '설명', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

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

/** 수정 — 자연키(code)와 출처(source)는 변경 대상이 아니라 페이로드에서 제외한다 */
export class UpdateCodeGroupDto extends PartialType(
  OmitType(CreateCodeGroupDto, ['code', 'source'] as const),
) {}

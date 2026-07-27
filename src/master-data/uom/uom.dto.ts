import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { toOptionalBoolean } from '../../common/dto/page-query.dto';
import { CODE_PATTERN } from '../common-code/dto/code-group.dto';

export class CreateUomDto {
  @ApiProperty({ description: '단위 코드', example: 'EA', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, { message: '단위 코드는 영문 대문자·숫자·언더스코어만 사용합니다.' })
  uomCode!: string;

  @ApiProperty({ description: '단위명', example: '개', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  uomName!: string;

  @ApiPropertyOptional({
    description: '소수 자릿수 — 수량을 몇 자리까지 허용할지. DB 제약 0~6',
    default: 0,
    minimum: 0,
    maximum: 6,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(6)
  decimalScale?: number;

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateUomDto extends PartialType(OmitType(CreateUomDto, ['uomCode'] as const)) {}

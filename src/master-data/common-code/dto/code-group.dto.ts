import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import { toOptionalBoolean } from '../../../common/dto/page-query.dto';

/** 코드는 영문 대문자·숫자·언더스코어만 허용한다 (ERP 연계 키와의 표기 충돌 방지) */
export const CODE_PATTERN = /^[A-Z0-9_]+$/;

/** CODE_PATTERN을 어겼을 때의 공통 메시지 — `@Matches(CODE_PATTERN, CODE_RULE)`로 함께 쓴다. */
export const CODE_RULE = { message: '코드는 영문 대문자·숫자·언더스코어만 사용합니다.' };

export class CreateCodeGroupDto {
  @ApiProperty({ description: '코드그룹 코드', example: 'ITEM_TYPE', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, { message: '코드그룹은 영문 대문자·숫자·언더스코어만 사용합니다.' })
  groupCode!: string;

  @ApiProperty({ description: '코드그룹명', example: '품목구분', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  groupName!: string;

  @ApiPropertyOptional({ description: '설명' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateCodeGroupDto extends PartialType(
  OmitType(CreateCodeGroupDto, ['groupCode'] as const),
) {}

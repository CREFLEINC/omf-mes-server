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

import { toOptionalBoolean } from '../../common/dto/page-query.dto';
import { CODE_PATTERN, CODE_RULE } from '../common-code/dto/code-group.dto';

export class CreateLegalEntityDto {
  @ApiProperty({ description: '법인 코드', example: 'OMF_VN', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, CODE_RULE)
  legalEntityCode!: string;

  @ApiProperty({ description: '법인명', example: 'OMF Vietnam', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  legalEntityName!: string;

  @ApiProperty({ description: '국가 코드 (ISO 3166-1 alpha-3)', example: 'VNM', maxLength: 3 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(3)
  countryCode!: string;

  @ApiProperty({ description: 'IANA 타임존', example: 'Asia/Ho_Chi_Minh', maxLength: 64 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  timezoneCode!: string;

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateLegalEntityDto extends PartialType(
  OmitType(CreateLegalEntityDto, ['legalEntityCode'] as const),
) {}

export class CreateBusinessUnitDto {
  @ApiProperty({ description: '소속 법인 코드', example: 'OMF_VN' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  legalEntityCode!: string;

  @ApiProperty({ description: '사업부 코드', example: 'PARTS', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, CODE_RULE)
  businessUnitCode!: string;

  @ApiProperty({ description: '사업부명', example: '부품사업부', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  businessUnitName!: string;

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateBusinessUnitDto extends PartialType(
  OmitType(CreateBusinessUnitDto, ['legalEntityCode', 'businessUnitCode'] as const),
) {}

export class CreatePlantDto {
  @ApiProperty({ description: '소속 법인 코드', example: 'OMF_VN' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  legalEntityCode!: string;

  @ApiPropertyOptional({
    description: '소속 사업부 코드 — 선택. 지정 시 같은 법인 소속이어야 한다',
    example: 'PARTS',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  businessUnitCode?: string;

  @ApiProperty({ description: '공장 코드', example: 'PLANT1', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, CODE_RULE)
  plantCode!: string;

  @ApiProperty({ description: '공장명', example: '1공장', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  plantName!: string;

  @ApiProperty({ description: 'IANA 타임존', example: 'Asia/Ho_Chi_Minh', maxLength: 64 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  timezoneCode!: string;

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class UpdatePlantDto extends PartialType(
  OmitType(CreatePlantDto, ['legalEntityCode', 'plantCode'] as const),
) {}

/**
 * 중첩 경로(`/legal-entities/:legalEntityCode/...`)용 본문 DTO.
 *
 * 경로 파라미터는 본문에 없다. 위 DTO를 그대로 쓰면 ValidationPipe가 핸들러보다
 * 먼저 돌아 `legalEntityCode` 누락으로 400을 낸다 — 그래서 본문에서 제외한다.
 */
export class CreateBusinessUnitBodyDto extends OmitType(CreateBusinessUnitDto, [
  'legalEntityCode',
] as const) {}

export class CreatePlantBodyDto extends OmitType(CreatePlantDto, ['legalEntityCode'] as const) {}

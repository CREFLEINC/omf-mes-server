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

import { PageQueryDto, toOptionalBoolean } from '../../common/dto/page-query.dto';
import { CODE_PATTERN } from '../common-code/dto/code-group.dto';

/** 공급사·고객·외주처·운송업체를 하나로 관리하고 역할을 N개 부여한다. */
export class CreatePartnerDto {
  @ApiProperty({ description: '거래처 코드', example: 'SUP_0001', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, { message: '거래처 코드는 영문 대문자·숫자·언더스코어만 사용합니다.' })
  partnerCode!: string;

  @ApiProperty({ description: '거래처명', example: '한독 정밀', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  partnerName!: string;

  @ApiPropertyOptional({ description: '국가 코드 (ISO 3166-1 alpha-3)', example: 'VNM' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  countryCode?: string;

  @ApiPropertyOptional({
    description: 'ERP 거래처 코드 — ERP 연계 수신 시 대조 키',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  erpPartnerCode?: string;

  @ApiPropertyOptional({
    description: '역할 코드 목록 — 코드그룹 PARTNER_ROLE_TYPE. 등록과 함께 부여한다',
    example: ['SUPPLIER'],
    isArray: true,
  })
  @IsOptional()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  roleTypeCodes?: string[];

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

/** 역할은 하위 리소스로 관리하므로 본문에서 제외한다. */
export class UpdatePartnerDto extends PartialType(
  OmitType(CreatePartnerDto, ['partnerCode', 'roleTypeCodes'] as const),
) {}

export class AddPartnerRoleDto {
  @ApiProperty({
    description: '역할 코드 — 코드그룹 PARTNER_ROLE_TYPE (공급사/고객/외주처/운송업체)',
    example: 'CUSTOMER',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  roleTypeCode!: string;
}

export class PartnerQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '역할로 좁혀 조회 — 예: SUPPLIER' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  roleTypeCode?: string;
}

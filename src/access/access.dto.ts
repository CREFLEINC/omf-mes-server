import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import { PageQueryDto, toOptionalBoolean } from '../common/dto/page-query.dto';
import { CODE_PATTERN, CODE_RULE } from '../master-data/common-code/dto/code-group.dto';

/** 자격증명은 여기서 다루지 않는다 — app.user_credential과 /auth 소관. */
export class CreateUserDto {
  @ApiProperty({ description: '로그인 ID', example: 'hong.gildong', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  loginId!: string;

  @ApiProperty({ description: '사용자명', example: '홍길동', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  userName!: string;

  @ApiPropertyOptional({ description: '이메일', maxLength: 200 })
  @IsOptional()
  @IsEmail({}, { message: '이메일 형식이 아닙니다.' })
  @MaxLength(200)
  email?: string;

  @ApiPropertyOptional({ description: '소속 부서 코드' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  departmentCode?: string;

  @ApiPropertyOptional({
    description: '계정 상태 — 코드그룹 USER_STATUS (사용/정지/해지)',
    default: 'ACTIVE',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  statusCode?: string;

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateUserDto extends PartialType(OmitType(CreateUserDto, ['loginId'] as const)) {}

export class CreateRoleDto {
  @ApiProperty({ description: '역할 코드', example: 'PROD_MANAGER', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, CODE_RULE)
  roleCode!: string;

  @ApiProperty({ description: '역할명', example: '생산관리자', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  roleName!: string;

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

export class UpdateRoleDto extends PartialType(OmitType(CreateRoleDto, ['roleCode'] as const)) {}

export class AddPermissionDto {
  @ApiProperty({
    description: '권한 코드 — 코드그룹 PERMISSION',
    example: 'MASTER_WRITE',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  permissionCode!: string;
}

export class AssignRoleDto {
  @ApiProperty({ description: '역할 코드', example: 'PROD_MANAGER' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  roleCode!: string;
}

/** 사업부·공장 중 최소 하나 필수 — DDL ck_user_data_scope_target. */
export class AddDataScopeDto {
  @ApiPropertyOptional({ description: '소속 법인 코드 — 사업부·공장 조회에 쓴다' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  legalEntityCode?: string;

  @ApiPropertyOptional({ description: '허용할 사업부 코드' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  businessUnitCode?: string;

  @ApiPropertyOptional({ description: '허용할 공장 코드' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  plantCode?: string;
}

export class UserQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '계정 상태로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  statusCode?: string;

  @ApiPropertyOptional({ description: '역할로 좁혀 조회 — 예: PROD_MANAGER' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  roleCode?: string;
}

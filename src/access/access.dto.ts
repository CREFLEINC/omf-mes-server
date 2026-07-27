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
import { CODE_PATTERN } from '../master-data/common-code/dto/code-group.dto';

const codeRule = { message: '코드는 영문 대문자·숫자·언더스코어만 사용합니다.' };

/**
 * 사용자 계정 — app.app_user. 자연키 = login_id (전역 유니크)
 *
 * 정본 모델에는 비밀번호·토큰 컬럼이 없다. 이 리소스는 **인가(권한) 대상으로서의 계정**을
 * 관리할 뿐, 로그인 자격증명은 다루지 않는다(README '인증 미결' 참조).
 */
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

/** 역할 — app.role. 자연키 = role_code (전역 유니크) */
export class CreateRoleDto {
  @ApiProperty({ description: '역할 코드', example: 'PROD_MANAGER', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, codeRule)
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

/** 역할에 부여할 기능 권한 — app.role_permission */
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

/** 사용자에게 부여할 역할 — app.user_role */
export class AssignRoleDto {
  @ApiProperty({ description: '역할 코드', example: 'PROD_MANAGER' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  roleCode!: string;
}

/**
 * 데이터 접근범위 — app.user_data_scope.
 * 사업부·공장 중 최소 하나는 지정해야 한다(DDL ck_user_data_scope_target).
 */
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

/** 사용자 목록 쿼리 */
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

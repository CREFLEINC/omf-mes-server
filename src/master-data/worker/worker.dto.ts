import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import { PageQueryDto, toOptionalBoolean } from '../../common/dto/page-query.dto';
import { CODE_PATTERN } from '../common-code/dto/code-group.dto';

const codeRule = { message: '코드는 영문 대문자·숫자·언더스코어만 사용합니다.' };

/** 부서 — mdm.department. 자연키 = department_code (전역 유니크) */
export class CreateDepartmentDto {
  @ApiProperty({ description: '부서 코드', example: 'DEPT_PROD', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, codeRule)
  departmentCode!: string;

  @ApiProperty({ description: '부서명', example: '생산부', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  departmentName!: string;

  @ApiPropertyOptional({ description: '상위 부서 코드' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  parentDepartmentCode?: string;

  @ApiPropertyOptional({ description: '소속 사업부 코드' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  businessUnitCode?: string;

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateDepartmentDto extends PartialType(
  OmitType(CreateDepartmentDto, ['departmentCode'] as const),
) {}

/**
 * 작업자 — mdm.worker. 자연키 = worker_no (사번, 전역 유니크)
 *
 * `app_user_id`(관리 화면 계정 연결)는 인증·권한 마스터가 아직 없어 이 API에서 다루지 않는다.
 * 현장 실적 귀속은 사번 경량 인증이고 관리 화면 계정과 이원화된다(REQ-PR-0023).
 */
export class CreateWorkerDto {
  @ApiProperty({ description: '사번', example: 'W0001', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, codeRule)
  workerNo!: string;

  @ApiProperty({ description: '성명', example: '홍길동', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  workerName!: string;

  @ApiProperty({ description: '소속 법인 코드', example: 'OMF_VN' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  legalEntityCode!: string;

  @ApiProperty({ description: '소속 사업부 코드', example: 'PARTS' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  businessUnitCode!: string;

  @ApiProperty({ description: '소속 공장 코드', example: 'PLANT1' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  plantCode!: string;

  @ApiPropertyOptional({ description: '소속 부서 코드' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  departmentCode?: string;

  @ApiProperty({
    description: '재직 상태 — 코드그룹 WORKER_STATUS (재직/휴직/퇴직)',
    example: 'ACTIVE',
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

export class UpdateWorkerDto extends PartialType(
  OmitType(CreateWorkerDto, ['workerNo', 'legalEntityCode'] as const),
) {}

/**
 * 작업자 자격 — mdm.worker_qualification.
 * 공정 수행 자격·검사자 자격을 유효기간과 함께 관리한다(DDL 주석: FR-WO-009/022 · FR-QM-014).
 */
export class CreateQualificationDto {
  @ApiProperty({
    description: '자격 유형 — 코드그룹 QUALIFICATION_TYPE (공정수행/검사자)',
    example: 'PROCESS_OPERATION',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  qualificationTypeCode!: string;

  @ApiPropertyOptional({ description: '대상 공정 코드 — 공정별 자격인 경우' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  processCode?: string;

  @ApiPropertyOptional({ description: '자격증 번호', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  certificateNo?: string;

  @ApiProperty({ description: '유효 시작일 (YYYY-MM-DD)', example: '2026-01-01' })
  @Type(() => Date)
  @IsDate()
  validFrom!: Date;

  @ApiPropertyOptional({ description: '유효 종료일 (YYYY-MM-DD) — 미지정이면 무기한' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  validTo?: Date;
}

/** 작업자 목록 쿼리 */
export class WorkerQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '공장으로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  plantCode?: string;

  @ApiPropertyOptional({ description: '부서로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  departmentCode?: string;

  @ApiPropertyOptional({ description: '재직 상태로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  statusCode?: string;
}

/** 자격 목록 쿼리 */
export class QualificationQueryDto {
  @ApiPropertyOptional({
    description: '이 날짜에 유효한 자격만 (YYYY-MM-DD). 만료·미개시 자격을 제외한다',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  validOn?: Date;

  @ApiPropertyOptional({ description: '자격 유형으로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  qualificationTypeCode?: string;
}

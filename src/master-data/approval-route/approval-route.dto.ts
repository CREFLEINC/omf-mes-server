import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

import { PageQueryDto, toOptionalBoolean } from '../../common/dto/page-query.dto';

/**
 * 결재선 — 승인유형과 금액구간으로 어느 라우트를 탈지 고른다.
 * 같은 승인유형에 금액구간을 나눠 여러 라우트를 둘 수 있어(소액=팀장, 고액=임원)
 * 승인유형 단독으로는 단건을 특정할 수 없다. 경로 키는 routeId를 쓴다.
 */
export class CreateApprovalRouteDto {
  @ApiProperty({
    description: '승인유형 — 코드그룹 APPROVAL_TYPE',
    example: 'CONCESSION',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  approvalTypeCode!: string;

  @ApiPropertyOptional({ description: '적용 사업부 코드 — 미지정 시 전 사업부' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  businessUnitCode?: string;

  @ApiPropertyOptional({ description: '적용 금액구간 하한 — 미지정 시 하한 없음' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minValue?: number;

  @ApiPropertyOptional({ description: '적용 금액구간 상한 — 하한 이상이어야 한다' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxValue?: number;

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

/** 승인유형은 라우트의 정체성이라 수정 대상이 아니다 — 바꾸려면 새 라우트를 만든다. */
export class UpdateApprovalRouteDto extends PartialType(
  OmitType(CreateApprovalRouteDto, ['approvalTypeCode'] as const),
) {}

export class ApprovalRouteQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '승인유형으로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  approvalTypeCode?: string;
}

/**
 * 결재 단계. 승인자는 사용자·역할·부서 **셋 중 정확히 하나**로 지정한다
 * (DDL ck_approval_route_step_target = num_nonnulls(...) = 1).
 */
export class CreateApprovalRouteStepDto {
  @ApiProperty({ description: '결재 순서 — 라우트 내 유일', example: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  stepNo!: number;

  @ApiProperty({
    description: '승인자 지정 방식 — 코드그룹 APPROVER_TYPE (USER/ROLE/DEPARTMENT)',
    example: 'ROLE',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  approverTypeCode!: string;

  @ApiPropertyOptional({ description: '승인자 로그인 ID — approverTypeCode=USER일 때' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  approverLoginId?: string;

  @ApiPropertyOptional({ description: '승인 역할코드 — approverTypeCode=ROLE일 때' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  approverRoleCode?: string;

  @ApiPropertyOptional({ description: '승인 부서코드 — approverTypeCode=DEPARTMENT일 때' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  approverDepartmentCode?: string;
}

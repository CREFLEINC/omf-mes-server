import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { BasePageQueryDto, toOptionalBoolean } from '../../common/dto/page-query.dto';

/**
 * 운영정책 — "소스 수정 없이 설정"을 떠받치는 파라미터 저장소.
 * QA 확정기록의 「설정형 우선」 원칙(점검 통제 3단계·FIFO 강제/선택·ERP 송신 on/off 등)이
 * 여기에 값으로 들어온다.
 *
 * 같은 정책코드를 스코프(사업부·공장·품목·공정)별로 다르게 둘 수 있고, 지정하지 않은
 * 스코프는 전역 기본값이 된다. `(정책코드 × 4개 스코프 × 시작일)`이 유니크라
 * 정책코드 단독으로는 단건을 특정할 수 없어 경로 키는 policyId를 쓴다.
 */
export class CreateOperationPolicyDto {
  @ApiProperty({
    description: '정책코드 — 코드그룹 OPERATION_POLICY',
    example: 'FIFO_VIOLATION_POLICY',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  policyCode!: string;

  @ApiPropertyOptional({ description: '적용 사업부 코드 — 미지정 시 전 사업부' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  businessUnitCode?: string;

  @ApiPropertyOptional({ description: '적용 공장 코드 — 미지정 시 전 공장' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  plantCode?: string;

  @ApiPropertyOptional({ description: '적용 품목 코드 — 미지정 시 전 품목' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  itemCode?: string;

  @ApiPropertyOptional({ description: '적용 공정 코드 — 미지정 시 전 공정' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  processCode?: string;

  @ApiPropertyOptional({ description: '문자값 — 예: BLOCK / WARN / OFF', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  valueText?: string;

  @ApiPropertyOptional({ description: '수치값 — 예: 초과생산 허용율 5', example: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  valueNumeric?: number;

  @ApiPropertyOptional({ description: '불리언값' })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  valueBoolean?: boolean;

  @ApiProperty({ description: '유효 시작일 (YYYY-MM-DD)', example: '2026-01-01' })
  @Type(() => Date)
  @IsDate()
  effectiveFrom!: Date;

  @ApiPropertyOptional({ description: '유효 종료일 (YYYY-MM-DD)' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  effectiveTo?: Date;
}

/** 정책코드·스코프·시작일은 이 정책행의 정체성이라 수정 대상이 아니다 — 바꾸려면 새 행을 만든다. */
export class UpdateOperationPolicyDto extends PartialType(
  OmitType(CreateOperationPolicyDto, [
    'policyCode',
    'businessUnitCode',
    'plantCode',
    'itemCode',
    'processCode',
    'effectiveFrom',
  ] as const),
) {}

export class OperationPolicyQueryDto extends BasePageQueryDto {
  @ApiPropertyOptional({ description: '정책코드로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  policyCode?: string;

  @ApiPropertyOptional({ description: '공장 코드로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  plantCode?: string;

  @ApiPropertyOptional({
    description: '기준일에 유효한 정책만 조회 (YYYY-MM-DD) — 미지정 시 기간 무관 전체',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  effectiveOn?: Date;
}

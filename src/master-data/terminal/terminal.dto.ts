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

const codeRule = { message: '코드는 영문 대문자·숫자·언더스코어만 사용합니다.' };

/** `HH:MM` 또는 `HH:MM:SS` */
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export class CreateShiftDto {
  @ApiProperty({ description: '소속 법인 코드', example: 'OMF_VN' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  legalEntityCode!: string;

  @ApiProperty({ description: '소속 공장 코드', example: 'PLANT1' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  plantCode!: string;

  @ApiProperty({ description: '작업조 코드', example: 'SHIFT_A', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, codeRule)
  shiftCode!: string;

  @ApiProperty({ description: '작업조명', example: '주간조', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  shiftName!: string;

  @ApiProperty({ description: '시작 시각 — HH:MM 또는 HH:MM:SS', example: '08:00' })
  @IsString()
  @Matches(TIME_PATTERN, { message: '시각은 HH:MM 또는 HH:MM:SS 형식입니다.' })
  startTime!: string;

  @ApiProperty({ description: '종료 시각 — HH:MM 또는 HH:MM:SS', example: '17:00' })
  @IsString()
  @Matches(TIME_PATTERN, { message: '시각은 HH:MM 또는 HH:MM:SS 형식입니다.' })
  endTime!: string;

  @ApiPropertyOptional({
    description:
      '자정 넘김 여부. 종료 시각이 시작 시각보다 이르면 true여야 하고, 늦으면 false여야 한다',
    default: false,
  })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  crossesMidnight?: boolean;

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateShiftDto extends PartialType(
  OmitType(CreateShiftDto, ['legalEntityCode', 'plantCode', 'shiftCode'] as const),
) {}

/** 유형은 기술스택 결정 16의 폼팩터(관리 웹 / POP 패널 PC / 모바일 스캐너)를 따른다. */
export class CreateTerminalDto {
  @ApiProperty({ description: '소속 법인 코드', example: 'OMF_VN' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  legalEntityCode!: string;

  @ApiProperty({ description: '소속 공장 코드', example: 'PLANT1' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  plantCode!: string;

  @ApiProperty({ description: '단말 코드', example: 'POP_INJ_01', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, codeRule)
  terminalCode!: string;

  @ApiProperty({
    description: '단말 유형 — 코드그룹 TERMINAL_TYPE (관리웹/POP/모바일)',
    example: 'POP',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  terminalTypeCode!: string;

  @ApiProperty({
    description: '단말 상태 — 코드그룹 TERMINAL_STATUS (정상/점검중/폐기)',
    example: 'NORMAL',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  statusCode!: string;

  @ApiPropertyOptional({ description: '설치 위치 — 창고 코드' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  warehouseCode?: string;

  @ApiPropertyOptional({ description: '설치 위치 — 로케이션 코드. warehouseCode와 함께 지정한다' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  locationCode?: string;

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateTerminalDto extends PartialType(
  OmitType(CreateTerminalDto, ['legalEntityCode', 'plantCode', 'terminalCode'] as const),
) {}

export class UpsertTerminalProcessDto {
  @ApiProperty({ description: '대상 공정 코드', example: 'MOLDING' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  processCode!: string;

  @ApiPropertyOptional({ description: '자재 투입 입력', default: false })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  canInputMaterial?: boolean;

  @ApiPropertyOptional({ description: '생산 실적 입력', default: false })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  canInputResult?: boolean;

  @ApiPropertyOptional({ description: '검사 입력', default: false })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  canInputInspection?: boolean;

  @ApiPropertyOptional({ description: '라벨 출력', default: false })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  canPrintLabel?: boolean;

  @ApiPropertyOptional({ description: '작업 시작', default: false })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  canStartWork?: boolean;

  @ApiPropertyOptional({ description: '작업 완료', default: false })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  canCompleteWork?: boolean;

  @ApiPropertyOptional({ description: '투입 취소', default: false })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  canCancelInput?: boolean;

  @ApiPropertyOptional({ description: '자재 반납', default: false })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  canReturnMaterial?: boolean;
}

export class ShiftQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '공장으로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  plantCode?: string;
}

export class TerminalQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '공장으로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  plantCode?: string;

  @ApiPropertyOptional({ description: '단말 유형으로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  terminalTypeCode?: string;

  @ApiPropertyOptional({ description: '단말 상태로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  statusCode?: string;
}

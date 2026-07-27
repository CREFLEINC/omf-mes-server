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

/**
 * 표준 공정 — mdm.process. 자연키 = process_code (전역 유니크)
 *
 * 공정별 세부 속성(MES 관리 여부·설비/금형 필수·표준 C/T·수율 등)은 이 마스터가 아니라
 * 라우팅 라인(planning.routing_operation)이 갖는다. 같은 공정도 품목·라우팅에 따라
 * 운영 방식이 달라지기 때문이다.
 */
export class CreateProcessDto {
  @ApiProperty({ description: '공정 코드', example: 'MOLDING', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, { message: '공정 코드는 영문 대문자·숫자·언더스코어만 사용합니다.' })
  processCode!: string;

  @ApiProperty({ description: '공정명', example: '사출', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  processName!: string;

  @ApiProperty({
    description: '공정 유형 — 코드그룹 PROCESS_TYPE (자체공정/외주공정)',
    example: 'INTERNAL',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  processTypeCode!: string;

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateProcessDto extends PartialType(
  OmitType(CreateProcessDto, ['processCode'] as const),
) {}

/** 공정 목록 쿼리 — 추가 필터는 PageQueryDto를 확장해 선언해야 400을 피한다. */
export class ProcessQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '공정 유형으로 좁혀 조회 — 예: OUTSOURCED' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  processTypeCode?: string;
}

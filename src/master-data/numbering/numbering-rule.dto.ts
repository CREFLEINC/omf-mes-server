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

/**
 * 채번 패턴에 쓸 수 있는 토큰. 오타를 등록 시점에 잡지 못하면 발번이 시작된 뒤에야
 * 드러나고, 그때는 이미 잘못된 번호가 찍힌 뒤다.
 *
 * `{SEQ}`는 자리수를 붙여 쓴다 — `{SEQ4}` = 4자리 0채움.
 */
export const NUMBERING_TOKENS = [
  'PLANT',
  'YYYY',
  'YY',
  'MM',
  'DD',
  'YYMMDD',
  'YYYYMMDD',
  'LOT_TYPE',
  'DOC',
] as const;

/** 패턴에 등장하는 `{...}` 토큰을 뽑는다. */
export const NUMBERING_TOKEN_PATTERN = /\{([A-Z_0-9]+)\}/g;

export class CreateNumberingRuleDto {
  @ApiProperty({
    description: '채번 대상 문서유형 — 코드그룹 DOCUMENT_TYPE',
    example: 'WORK_ORDER',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  documentTypeCode!: string;

  @ApiPropertyOptional({ description: '적용 공장 코드 — 미지정 시 전 공장 공통 규칙' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  plantCode?: string;

  @ApiPropertyOptional({
    description: 'LOT 유형 — 문서유형이 LOT일 때 유형별로 규칙을 나눌 경우',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  lotTypeCode?: string;

  @ApiProperty({
    description:
      '채번 패턴. 토큰은 {PLANT} {YYYY} {YY} {MM} {DD} {YYMMDD} {YYYYMMDD} {LOT_TYPE} {DOC} 와 ' +
      '{SEQ<자리수>}(예: {SEQ4}). 일련번호 토큰은 정확히 1개 있어야 한다',
    example: 'WO-{PLANT}-{YYMMDD}-{SEQ4}',
    maxLength: 200,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Matches(/\{SEQ\d+\}/, { message: '패턴에 {SEQ<자리수>} 토큰이 필요합니다. 예: {SEQ4}' })
  pattern!: string;

  @ApiPropertyOptional({
    description: '리셋주기 — 코드그룹 RESET_CYCLE. 시퀀스를 언제 1로 되돌릴지',
    default: 'DAILY',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  resetCycleCode?: string;

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

/** 문서유형·공장·LOT유형은 규칙의 정체성이라 수정 대상이 아니다 — 바꾸려면 새 규칙을 만든다. */
export class UpdateNumberingRuleDto extends PartialType(
  OmitType(CreateNumberingRuleDto, ['documentTypeCode', 'plantCode', 'lotTypeCode'] as const),
) {}

export class NumberingRuleQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '문서유형으로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  documentTypeCode?: string;

  @ApiPropertyOptional({ description: '공장 코드로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  plantCode?: string;
}

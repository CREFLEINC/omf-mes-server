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
import { CODE_PATTERN, CODE_RULE } from '../common-code/dto/code-group.dto';

export class CreateDefectCodeDto {
  @ApiProperty({ description: '불량코드 — 전역 유일', example: 'SCRATCH', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, CODE_RULE)
  defectCode!: string;

  @ApiProperty({ description: '불량명', example: '스크래치', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  defectName!: string;

  @ApiPropertyOptional({
    description: '상위 불량코드 — 지정하면 하위(2계층)가 된다. 상위는 최상위 코드여야 한다',
    example: 'APPEARANCE',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  parentDefectCode?: string;

  @ApiPropertyOptional({ description: '귀속 공정코드 — 공정 무관 코드면 생략' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  processCode?: string;

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateDefectCodeDto extends PartialType(
  OmitType(CreateDefectCodeDto, ['defectCode'] as const),
) {}

export class CreateCauseCodeDto {
  @ApiProperty({ description: '원인코드 — 전역 유일', example: 'MOLD_WEAR', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(CODE_PATTERN, CODE_RULE)
  causeCode!: string;

  @ApiProperty({ description: '원인명', example: '금형 마모', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  causeName!: string;

  @ApiPropertyOptional({
    description: '상위 원인코드 — 지정하면 하위(2계층)가 된다. 상위는 최상위 코드여야 한다',
    example: 'EQUIPMENT',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  parentCauseCode?: string;

  @ApiPropertyOptional({ description: '귀속 공정코드 — 공정 무관 코드면 생략' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  processCode?: string;

  @ApiPropertyOptional({ description: '사용여부', default: true })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateCauseCodeDto extends PartialType(
  OmitType(CreateCauseCodeDto, ['causeCode'] as const),
) {}

export class QualityCodeQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '귀속 공정코드로 좁혀 조회' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  processCode?: string;

  @ApiPropertyOptional({ description: '최상위 코드만 조회 — 트리 1단계를 그릴 때' })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isRootOnly?: boolean;
}

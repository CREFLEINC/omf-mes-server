import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { IsDateOnly } from '../date-only.validator';

/** 한 요청으로 수만 행을 밀어 넣어 트랜잭션이 테이블을 잠그는 것을 막는다. */
const MAX_ROWS = 500;

export class WorkerQualificationRowDto {
  @ApiProperty({ description: '공통코드 — 값 목록이 아직 정해지지 않았다(§8-5)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  readonly qualificationTypeCode!: string;

  @ApiPropertyOptional({ description: '비우면 (전체 공정) — 공유계약 A-7' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly processId?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  readonly certificateNo?: string | null;

  @ApiProperty({ example: '2026-08-07' })
  @IsDateOnly()
  readonly validFrom!: string;

  @ApiPropertyOptional({ description: '비우면 무기한 — ck_worker_qualification_dates' })
  @IsOptional()
  @IsDateOnly()
  readonly validTo?: string | null;

  /**
   * FK 가 없다 — 무엇을 가리키는지 근거가 없어 검증할 수 없다(§8-2 · #64).
   * 형태만 본다. 대상이 정해지면 참조 검사를 붙인다.
   */
  @ApiPropertyOptional({ description: 'FK 없음 — 대상 미정' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly certifiedBy?: number | null;
}

export class ReplaceQualificationsDto {
  @ApiProperty({ type: [WorkerQualificationRowDto] })
  @IsArray()
  @ArrayMaxSize(MAX_ROWS)
  @ValidateNested({ each: true })
  @Type(() => WorkerQualificationRowDto)
  readonly qualifications!: WorkerQualificationRowDto[];
}

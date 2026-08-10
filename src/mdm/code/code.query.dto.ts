import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsPositive, IsString } from 'class-validator';

import { PagedQueryDto } from '../paged-query.dto';

export class CodeGroupQueryDto extends PagedQueryDto {
  @ApiPropertyOptional({ description: '그룹코드·그룹명 검색' })
  @IsOptional()
  @IsString()
  readonly q?: string;
}

export class CodeValueQueryDto extends PagedQueryDto {
  /** 로케이션의 `warehouseId` 와 같이 필수다 — 코드값은 그룹을 고른 뒤에 본다. */
  @ApiProperty({ description: '필수 — 코드값은 그룹을 고른 뒤에 본다' })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly codeGroupId!: number;

  @ApiPropertyOptional({ description: '코드·코드명 검색' })
  @IsOptional()
  @IsString()
  readonly q?: string;
}

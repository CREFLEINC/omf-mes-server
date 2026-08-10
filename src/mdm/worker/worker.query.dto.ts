import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsPositive, IsString } from 'class-validator';

import { PagedQueryDto } from '../paged-query.dto';

export class WorkerQueryDto extends PagedQueryDto {
  @ApiPropertyOptional({ description: '사번·성명 검색' })
  @IsOptional()
  @IsString()
  readonly q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly departmentId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly plantId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly businessUnitId?: number;
}

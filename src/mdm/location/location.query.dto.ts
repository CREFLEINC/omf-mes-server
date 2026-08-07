import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsPositive, IsString } from 'class-validator';

import { PagedQueryDto } from '../paged-query.dto';

export class LocationQueryDto extends PagedQueryDto {
  /** 창고와 달리 필수다. 로케이션은 창고를 고른 뒤에 보는 화면이다(W-06-07 §3). */
  @ApiProperty({ description: '필수 — 로케이션은 창고를 고른 뒤에 본다' })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly warehouseId!: number;

  @ApiPropertyOptional({ description: '코드·명칭 검색' })
  @IsOptional()
  @IsString()
  readonly q?: string;
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

import { PagedQueryDto } from '../paged-query.dto';

export class WarehouseQueryDto extends PagedQueryDto {
  @ApiPropertyOptional({ description: '코드·명칭 검색' })
  @IsOptional()
  @IsString()
  readonly q?: string;

  @ApiPropertyOptional({ description: '창고 유형 코드' })
  @IsOptional()
  @IsString()
  readonly warehouseTypeCode?: string;
}

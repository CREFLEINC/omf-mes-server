import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsPositive, IsString } from 'class-validator';

import { PagedQueryDto } from '../paged-query.dto';

export class DepartmentQueryDto extends PagedQueryDto {
  /**
   * 로케이션의 `warehouseId` 와 달리 **선택**이다. 부서는 사업부에 속하지 않을 수 있어
   * (`business_unit_id` 가 nullable) 사업부를 고르지 않은 전체 목록이 성립한다.
   */
  @ApiPropertyOptional({ description: '선택 — 부서는 사업부에 속하지 않을 수 있다' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly businessUnitId?: number;

  @ApiPropertyOptional({ description: '부서코드·부서명 검색' })
  @IsOptional()
  @IsString()
  readonly q?: string;
}

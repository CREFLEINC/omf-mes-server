import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

import { PagedQueryDto } from '../paged-query.dto';

export class ItemQueryDto extends PagedQueryDto {
  @ApiPropertyOptional({ description: '품목코드·품목명 검색' })
  @IsOptional()
  @IsString()
  readonly q?: string;

  @ApiPropertyOptional({ description: '품목구분 코드' })
  @IsOptional()
  @IsString()
  readonly itemTypeCode?: string;

  /**
   * `false` 면 Routing 이 한 건도 없는 품목만 낸다 — 보강 등록을 돕는 필터다.
   * 이것이 없으면 화면이 전 품목과 전 Routing 을 받아 스스로 대조해야 한다.
   */
  @ApiPropertyOptional({ description: 'Routing 보유 여부로 거른다' })
  @IsOptional()
  // 쿼리스트링은 문자열로 온다. Boolean('false')는 true라 암묵 변환에 맡기면 뒤집힌다.
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  readonly hasRouting?: boolean;
}

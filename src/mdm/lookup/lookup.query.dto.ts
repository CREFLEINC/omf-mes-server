import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsPositive, IsString } from 'class-validator';

import { PagedQueryDto } from '../paged-query.dto';

/** 부모 필터가 없는 조회 — 단위·거래처·법인·공정. */
export class LookupQueryDto extends PagedQueryDto {
  @ApiPropertyOptional({ description: '코드·명칭 검색' })
  @IsOptional()
  @IsString()
  readonly q?: string;
}

/**
 * 필터를 마스터마다 나누는 이유: 한 DTO 에 모아 두면 `forbidNonWhitelisted` 가
 * 통과시켜 `/mdm/uoms?plantId=1` 같은 요청이 조용히 무시된다. 화면은 걸러진 줄 안다.
 */
export class BusinessUnitQueryDto extends LookupQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly legalEntityId?: number;
}

export class PlantQueryDto extends BusinessUnitQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly businessUnitId?: number;
}

export class ProductionLineQueryDto extends LookupQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly plantId?: number;
}

export class EquipmentQueryDto extends ProductionLineQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly processId?: number;
}

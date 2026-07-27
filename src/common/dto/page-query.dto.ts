import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** 'true'/'1' 같은 쿼리스트링 값을 boolean으로 변환한다. 빈 값은 undefined로 남긴다. */
export const toOptionalBoolean = ({ value }: { value: unknown }): boolean | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).toLowerCase();
  if (['true', '1', 'y', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'n', 'no'].includes(normalized)) return false;
  return undefined;
};

/** 목록 조회 공통 쿼리 — 페이징 · 키워드 검색 · 사용여부 필터 */
export class PageQueryDto {
  @ApiPropertyOptional({ description: '페이지 번호 (1부터)', default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: '페이지 크기', default: 20, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  size: number = 20;

  @ApiPropertyOptional({ description: '검색어 — 코드·명칭(ko/vi) 부분 일치' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;

  @ApiPropertyOptional({ description: '사용여부 필터 — 미지정 시 전체' })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  useYn?: boolean;

  @ApiPropertyOptional({ description: '삭제된 항목 포함 여부', default: false })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  includeDeleted: boolean = false;

  get skip(): number {
    return (this.page - 1) * this.size;
  }
}

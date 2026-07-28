import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const toOptionalBoolean = ({ value }: { value: unknown }): boolean | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).toLowerCase();
  if (['true', '1', 'y', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'n', 'no'].includes(normalized)) return false;
  return undefined;
};

/**
 * 추가 필터는 이 클래스를 확장해 **필드로 선언**해야 한다.
 * ValidationPipe가 forbidNonWhitelisted라, `@Query('x')`로만 받으면
 * `property x should not exist` 400이 난다.
 *
 * 라우팅·BOM처럼 is_active 컬럼이 없고 상태코드로 수명주기를 관리하는 테이블은
 * 이 클래스를 쓴다 — PageQueryDto를 쓰면 동작하지 않는 필터가 문서에 노출된다.
 */
export class BasePageQueryDto {
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

  @ApiPropertyOptional({ description: '검색어 — 코드·명칭 부분 일치' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;

  get skip(): number {
    return (this.page - 1) * this.size;
  }
}

export class PageQueryDto extends BasePageQueryDto {
  @ApiPropertyOptional({ description: '사용여부 필터 — 미지정 시 전체' })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  isActive?: boolean;
}

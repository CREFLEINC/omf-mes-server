import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * 마스터 목록이 공통으로 받는 것. 마스터마다 복사본을 두면 상한이나 기본값이 갈라진다 —
 * 창고·로케이션·코드·부서 넷이 같은 화면 패턴을 쓴다.
 *
 * 검색어 `q` 는 여기 두지 않는다. 설명 문구가 마스터마다 다르고(코드·명칭 / 그룹코드·그룹명),
 * 필수 여부가 다른 필터(`warehouseId`·`codeGroupId`)와 나란히 놓여야 읽힌다.
 */
export class PagedQueryDto {
  @ApiPropertyOptional({
    description: '기본은 사용 중인 것만. 켜면 사용 중지된 것도 함께 내린다',
    default: false,
  })
  @IsOptional()
  // 쿼리스트링은 문자열로 온다. Boolean('false')는 true라 암묵 변환에 맡기면 뒤집힌다.
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  readonly includeInactive: boolean = false;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly page: number = 1;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  // 상한이 없으면 size=1000000 하나로 전 테이블을 긁어간다.
  @Max(200)
  readonly size: number = 50;

  get skip(): number {
    return (this.page - 1) * this.size;
  }
}

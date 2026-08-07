import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsPositive, IsString, Max, Min } from 'class-validator';

export class LocationQueryDto {
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

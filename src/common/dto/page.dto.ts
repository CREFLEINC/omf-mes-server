import { ApiProperty } from '@nestjs/swagger';

/** 목록 조회 공통 응답 봉투 */
export class PageDto<T> {
  @ApiProperty({ description: '조회 결과 목록', isArray: true })
  readonly items: T[];

  @ApiProperty({ description: '전체 건수' })
  readonly total: number;

  @ApiProperty({ description: '페이지 번호 (1부터)' })
  readonly page: number;

  @ApiProperty({ description: '페이지 크기' })
  readonly size: number;

  @ApiProperty({ description: '전체 페이지 수' })
  readonly totalPages: number;

  constructor(items: T[], total: number, page: number, size: number) {
    this.items = items;
    this.total = total;
    this.page = page;
    this.size = size;
    this.totalPages = size > 0 ? Math.ceil(total / size) : 0;
  }
}

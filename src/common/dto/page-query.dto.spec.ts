import { plainToInstance } from 'class-transformer';

import { PageQueryDto } from './page-query.dto';

describe('PageQueryDto', () => {
  const parse = (query: Record<string, unknown>): PageQueryDto =>
    plainToInstance(PageQueryDto, query);

  it("useYn='false' 문자열을 boolean false로 변환한다", () => {
    // 회귀 방어: ValidationPipe의 enableImplicitConversion이 켜져 있으면
    // Boolean('false')=true가 되어 사용여부 필터가 무력화됐다.
    expect(parse({ useYn: 'false' }).useYn).toBe(false);
    expect(parse({ useYn: '0' }).useYn).toBe(false);
    expect(parse({ useYn: 'N' }).useYn).toBe(false);
  });

  it("useYn='true' 계열을 boolean true로 변환한다", () => {
    expect(parse({ useYn: 'true' }).useYn).toBe(true);
    expect(parse({ useYn: '1' }).useYn).toBe(true);
    expect(parse({ useYn: 'Y' }).useYn).toBe(true);
  });

  it('useYn 미지정이면 undefined — 필터를 걸지 않는다', () => {
    expect(parse({}).useYn).toBeUndefined();
    expect(parse({ useYn: '' }).useYn).toBeUndefined();
  });

  it('page·size를 숫자로 변환하고 기본값을 채운다', () => {
    expect(parse({ page: '3', size: '50' })).toMatchObject({ page: 3, size: 50 });
    expect(parse({})).toMatchObject({ page: 1, size: 20, includeDeleted: false });
  });

  it('skip을 page·size로 계산한다', () => {
    expect(parse({ page: '3', size: '20' }).skip).toBe(40);
    expect(parse({}).skip).toBe(0);
  });
});

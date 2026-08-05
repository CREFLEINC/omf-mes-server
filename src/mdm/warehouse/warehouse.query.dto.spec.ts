import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { WarehouseQueryDto } from './warehouse.query.dto';

/** 컨트롤러 앞의 ValidationPipe 와 같은 설정으로 변환한다(app.setup.ts). */
function parse(query: Record<string, unknown>): WarehouseQueryDto {
  return plainToInstance(WarehouseQueryDto, query, { enableImplicitConversion: false });
}

describe('WarehouseQueryDto', () => {
  it('아무것도 안 주면 사용 중인 것만 · 1페이지 50건', () => {
    const dto = parse({});

    expect(dto.includeInactive).toBe(false);
    expect(dto.page).toBe(1);
    expect(dto.size).toBe(50);
    expect(validateSync(dto)).toHaveLength(0);
  });

  it("문자열 'false' 를 false 로 읽는다 — 암묵 변환이면 Boolean('false')=true 로 뒤집힌다", () => {
    expect(parse({ includeInactive: 'false' }).includeInactive).toBe(false);
    expect(parse({ includeInactive: 'true' }).includeInactive).toBe(true);
  });

  it('page·size 를 숫자로 바꾼다 — 쿼리스트링은 문자열로 온다', () => {
    const dto = parse({ page: '3', size: '20' });

    expect(dto.page).toBe(3);
    expect(dto.size).toBe(20);
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('skip 을 page·size 로 계산한다', () => {
    expect(parse({ page: '3', size: '20' }).skip).toBe(40);
    expect(parse({}).skip).toBe(0);
  });

  it('page 가 1 미만이면 거부한다', () => {
    expect(validateSync(parse({ page: '0' }))).not.toHaveLength(0);
  });

  it('size 상한을 넘으면 거부한다 — 한 번에 전 테이블을 긁어가지 못하게', () => {
    expect(validateSync(parse({ size: '201' }))).not.toHaveLength(0);
    expect(validateSync(parse({ size: '200' }))).toHaveLength(0);
  });
});

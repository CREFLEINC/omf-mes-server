/**
 * ⭐⭐ **계약 사본에 «우리가» 먼저 적은 테스트용 P/O 등록을 지킨다**(장부 P-30).
 *
 * ERP 수신기가 없어 P/O 를 만들 길이 시드 SQL 뿐이었다. 테스트용 등록 경로를 사본에 먼저 적었다.
 * 다음 `contracts:update` 가 정본에 없는 이 편집을 조용히 덮으면 `@Contract('POST
 * /planning/production-orders')` 가 팬텀이 되고, 그전에 **요청 검증이 사라져** 아무도 안 막는
 * API 가 된다(`contract-validator.ts`). 하나라도 사라지면 당기는 그 순간 여기가 빨개진다.
 *
 * ⭐ 지우는 조건 — 설계팀이 정본에 같은 규격을 실어 오거나, ERP 수신기가 서서 이 경로를 없앨 때.
 *   ⛔ 빨갛다고 지우지 마라.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONTRACT = join(__dirname, '../../../contracts/production-02생산실행.json');

describe('계약 사본 — 선반영한 P/O 등록 (P-30)', () => {
  const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as {
    paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
    components: { schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }> };
  };

  it('⛔ POST /planning/production-orders 가 있고 403 을 선언한다 — 없으면 권한 가드가 안 본다', () => {
    const post = contract.paths['/planning/production-orders']?.post;
    expect(Object.keys(post?.responses ?? {}).sort()).toEqual(['201', '400', '403', '409']);
  });

  it('⛔ 요청 스키마 ProductionOrderCreate 의 칸과 필수가 그대로다', () => {
    const schema = contract.components.schemas.ProductionOrderCreate;
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(
      ['dueDate', 'erpOrderNo', 'itemId', 'orderQty', 'plantId', 'productionOrderNo', 'remarks', 'uomId'],
    );
    expect([...(schema?.required ?? [])].sort()).toEqual(['itemId', 'orderQty', 'plantId', 'productionOrderNo']);
  });
});

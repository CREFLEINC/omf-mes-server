/**
 * ⭐⭐ **계약 사본에 «우리가» 먼저 적은 재작업 W/O 발행을 지킨다**(장부 P-33 · 선례 P-30).
 *
 * 처분 판정이 재작업이어도 재작업 작업지시를 만들 길이 없어 P-04-03 을 검증할 수 없었다
 * (omf-all-around#47). 발행 경로를 사본에 먼저 적었다. 다음 `contracts:update` 가 정본에 없는
 * 이 편집을 조용히 덮으면 `@Contract('POST /quality/nonconformances/{nonconformanceId}:issue-rework-work-order')`
 * 가 팬텀이 되고, 그전에 **요청 검증과 403 게이트가 함께 사라져** 아무도 안 막는 API 가 된다.
 * 하나라도 사라지면 당기는 그 순간 여기가 빨개진다.
 *
 * ⭐ 지우는 조건 — 설계팀이 정본에 같은 규격을 실어 올 때. ⛔ 빨갛다고 지우지 마라.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONTRACT = join(__dirname, '../../../contracts/quality-03품질.json');
const ROUTE = '/quality/nonconformances/{nonconformanceId}:issue-rework-work-order';

describe('계약 사본 — 선반영한 재작업 W/O 발행 (P-33)', () => {
  const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as {
    paths: Record<string, Record<string, { responses?: Record<string, unknown>; parameters?: unknown[] }>>;
    components: { schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }> };
  };

  it('⛔ 발행 경로가 있고 403 을 선언한다 — 없으면 권한 가드가 안 본다', () => {
    const post = contract.paths[ROUTE]?.post;
    expect(Object.keys(post?.responses ?? {}).sort()).toEqual(['201', '400', '403', '404', '409']);
  });

  /* ⛔ If-Match 가 빠지면 잠금 없이 발행된다 — 두 사람이 같은 잔량을 보고 함께 발행한다. */
  it('⛔ 멱등 키와 If-Match 를 함께 요구한다', () => {
    const refs = (contract.paths[ROUTE]?.post?.parameters ?? [])
      .map((parameter) => (parameter as { $ref?: string }).$ref)
      .filter((value): value is string => value !== undefined);

    expect(refs).toEqual([
      '#/components/parameters/IdempotencyKey',
      '#/components/parameters/IfMatchVersion',
    ]);
  });

  it('⛔ 요청 스키마 ReworkWorkOrderIssue 의 칸과 필수가 그대로다', () => {
    const schema = contract.components.schemas.ReworkWorkOrderIssue;

    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(
      ['orderQty', 'plannedEndAt', 'plannedStartAt', 'remarks', 'routingOperationId', 'uomId'],
    );
    expect([...(schema?.required ?? [])].sort()).toEqual(['orderQty', 'routingOperationId']);
  });

  /*
   * ⭐ `reworkSourceNonconformanceId` 는 P-04-03 이 대상을 찾는 축이고, `remainingQty` 는 화면이
   *    중복 발행을 막는 값이다. 응답에서 사라지면 두 화면이 조용히 못 쓴다.
   */
  it('⛔ 응답 스키마 ReworkWorkOrder 가 근거 부적합과 잔량을 필수로 낸다', () => {
    const schema = contract.components.schemas.ReworkWorkOrder;

    expect(schema?.required).toContain('reworkSourceNonconformanceId');
    expect(schema?.required).toContain('remainingQty');
    expect(schema?.required).toContain('workOrderTypeCode');
  });
});

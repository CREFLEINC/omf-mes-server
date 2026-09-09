/**
 * ⭐⭐ **계약 사본에 «공지 전 선반영»한 값 하나를 지킨다.**
 *
 * 2026-09-10 설계팀 합의로 `sourceDocumentTypeCode` enum 에 **`RECYCLE_ENTRY`** 를 더했다
 * (질의 **213** — 재생재는 「새 자재 LOT 을 만들고 그 수량만큼 재고를 늘린다」라 원장을 쓰는데
 * 붙일 판별자가 없었고, 남의 값을 빌리는 후보 넷이 전부 막혔다).
 *
 * ⛔ **그런데 그 값은 아직 «설계 변동 공지»에 안 실렸다.** 루틴 끝에 `contracts:update` 로 사본을
 * 당기는 순간, 공지에 없으면 **우리 편집이 조용히 덮인다.** 그때 무슨 일이 나는가:
 *
 *   - `InventoryTransaction.sourceDocumentTypeCode` 는 **required + enum** 이다.
 *   - 재생재가 만든 원장 행이 `GET /inventory/transactions` 응답에 뜨는 순간 **ajv 가 깨진다.**
 *   - 즉 **I-17 이 «나중에» 조용히 부서진다** — 사본을 당긴 사람은 그 인과를 모른다.
 *
 * ⇒ 이 spec 이 그 사이를 잇는다. 값이 사라지면 **당기는 그 순간** 여기가 빨개진다.
 *   README §6-4 「공용 레지스트리를 늘리면 그것을 지키는 불변식 표도 같이 늘려라」와 같은 모양이다.
 *
 * ⭐ **이 spec 을 지우는 조건은 하나다** — 설계 변동 공지에 `RECYCLE_ENTRY` 가 실려 사본이
 *   정식으로 그 값을 갖게 되면, 그때는 이 값이 «우리 것»이 아니므로 지워도 된다.
 *   ⛔ 빨갛다고 지우지 마라 — 빨간 것은 **공지에 안 실렸다는 뜻**이다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONTRACT = join(__dirname, '../../../contracts/logistics-01자재창고.json');
const RECYCLE_ENTRY = 'RECYCLE_ENTRY';

describe('계약 사본 — 선반영한 RECYCLE_ENTRY (질의 213)', () => {
  const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as {
    paths: Record<string, Record<string, { parameters?: { name: string; schema?: { enum?: string[] } }[] }>>;
    components: {
      schemas: Record<string, { properties?: Record<string, { enum?: string[] }> }>;
    };
  };

  /** 응답 축 — 이게 없으면 재생재 원장 행이 ajv 를 깬다. */
  const responseEnum = (): string[] | undefined =>
    contract.components.schemas.InventoryTransaction?.properties?.sourceDocumentTypeCode?.enum;

  /** 질의 축 — 이게 없으면 화면이 `?sourceDocumentTypeCode=RECYCLE_ENTRY` 로 400 을 받는다. */
  const queryEnum = (): string[] | undefined =>
    contract.paths['/inventory/transactions']?.get?.parameters?.find(
      (parameter) => parameter.name === 'sourceDocumentTypeCode',
    )?.schema?.enum;

  it('⛔ 응답 스키마 enum 에 RECYCLE_ENTRY 가 있다 — 없으면 재생재 원장이 ajv 를 깬다', () => {
    expect(responseEnum()).toContain(RECYCLE_ENTRY);
  });

  it('⛔ 질의 파라미터 enum 에도 있다 — 응답에만 있으면 화면이 그 값으로 못 거른다', () => {
    expect(queryEnum()).toContain(RECYCLE_ENTRY);
  });

  it('⭐ 두 축이 «같은 값 집합»이다 — 한쪽만 고치면 응답과 필터가 갈린다', () => {
    expect([...(queryEnum() ?? [])].sort()).toEqual([...(responseEnum() ?? [])].sort());
  });
});

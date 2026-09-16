/**
 * ⭐⭐ **계약 사본에 «설계팀보다 먼저» 적은 출하 단위 규격을 지킨다**(장부 P-24·P-25).
 *
 * 2026-09-16 사용자 결정으로 납품 라벨의 주인이 출하 LOT 배분에서 **출하 단위**로 옮겨갔다.
 * 그런데 그 규격을 설계팀이 아직 정본에 싣지 않아, **우리가 사본에 먼저 적었다** — 경로 6개 ·
 * 스키마 8개 · `targetTypeCode` enum 값 하나.
 *
 * ⛔ **사본은 원래 읽기 전용이다.** 루틴 끝에 `contracts:update` 로 정본을 당기는 순간,
 * 정본에 없는 우리 편집은 **조용히 덮인다.** 그때 무슨 일이 나는가:
 *
 *   - `@Contract('POST /logistics/shipping-units')` 가 팬텀이 되어 `contract-coverage.spec` 이 깨진다.
 *   - 그전에 이미 **요청 검증이 조용히 사라진다** — 계약에 없는 키는 검증기가 빈 오류 배열을
 *     돌려주고 그대로 통과시킨다(`contract-validator.ts`). 즉 **아무도 안 막는 API** 가 된다.
 *   - `DELIVERY_LABEL` 발행이 `targetTypeCode: SHIPPING_UNIT` 을 400 으로 거절하기 시작한다 —
 *     **P-04-05 가 마감은 되는데 라벨이 안 나오는** 모양으로 부서진다.
 *
 * ⇒ 이 spec 이 그 사이를 잇는다. 하나라도 사라지면 **당기는 그 순간** 여기가 빨개진다.
 *
 * ⭐ **지우는 조건은 하나다** — 설계팀이 정본에 이 규격을 실어 오면, 그때는 이것이 «우리 것»이
 *   아니므로 지워도 된다. ⛔ 빨갛다고 지우지 마라 — 빨간 것은 **정본에 안 실렸다는 뜻**이다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SHIPMENT = join(__dirname, '../../../contracts/shipment-04제품출하.json');
const APP = join(__dirname, '../../../contracts/app-공통.json');

/** 경로 5개 · 오퍼레이션 6개. `/logistics/shipping-units` 하나가 GET·POST 둘을 문다. */
const OPERATIONS: [string, string][] = [
  ['/logistics/shipping-units', 'get'],
  ['/logistics/shipping-units', 'post'],
  ['/logistics/shipping-units/{shippingUnitId}', 'get'],
  ['/logistics/shipping-units/{shippingUnitId}:add-box', 'post'],
  ['/logistics/shipping-units/{shippingUnitId}/boxes/{handlingUnitId}', 'delete'],
  ['/logistics/shipping-units/{shippingUnitId}:close', 'post'],
];

const SCHEMAS = [
  'ShippingUnitCreate',
  'ShippingUnit',
  'ShippingUnitDetail',
  'ShippingUnitBox',
  'ShippingUnitBoxContent',
  'ShippingUnitItemTotal',
  'ShippingUnitAddBox',
  'ShippingUnitList',
];

interface Contract {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown> };
}

describe('계약 사본 — 선반영한 출하 단위 규격 (P-24·P-25)', () => {
  const shipment = JSON.parse(readFileSync(SHIPMENT, 'utf8')) as Contract;
  const app = readFileSync(APP, 'utf8');

  it.each(OPERATIONS)(
    '⛔ %s %s 가 사본에 있다 — 없으면 검증 없이 통과하는 API 가 된다',
    (path, method) => {
      expect(shipment.paths[path]).toBeDefined();
      expect(shipment.paths[path][method]).toBeDefined();
    },
  );

  it.each(SCHEMAS)('⛔ 스키마 %s 가 사본에 있다', (name) => {
    expect(shipment.components.schemas[name]).toBeDefined();
  });

  /**
   * ⛔ 이 값이 사라지면 P-04-05 가 마감은 되는데 납품 라벨이 400 으로 안 나온다.
   * ⚠ 다섯 자리에 «모두» 있어야 한다 — 질의 축 둘·본문 축 하나·응답 축 둘이고,
   *   한 자리만 빠져도 그 경로에서만 조용히 막힌다.
   */
  it('⛔ app-공통 의 targetTypeCode enum 다섯 자리 전부에 SHIPPING_UNIT 이 있다', () => {
    const targetEnums = app.split('"SHIPMENT_LOT_ALLOCATION"').length - 1;
    expect(targetEnums).toBe(5);
    expect(app.split('"SHIPPING_UNIT"').length - 1).toBe(5);
  });

  /** ⭐ 납품 라벨 대상이 옮겨갔다는 사실 자체가 설명문에 남아 있어야 한다(P-26). */
  it('⛔ 배분 q 설명이 상자 번호를 겨눈다 — 납품라벨 번호로 되돌아가면 겨냥할 열이 없다', () => {
    const allocations = shipment.paths['/logistics/shipment-lot-allocations'] as {
      get: { parameters: { name: string; description?: string }[] };
    };
    const q = allocations.get.parameters.find((parameter) => parameter.name === 'q');

    expect(q?.description).toContain('handlingUnitNo');
    expect(q?.description).not.toContain('스캔한 납품라벨 값으로');
  });
});

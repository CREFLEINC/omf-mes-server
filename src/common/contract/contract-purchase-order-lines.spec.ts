/**
 * ⭐⭐ **계약 사본에 «우리가» 먼저 적은 입하 예정 P/O 라인 목록을 지킨다**(장부 P-77 · #741).
 *
 * 다음 `contracts:update` 가 정본에 없는 이 편집을 조용히 덮으면 `@Contract('GET
 * /logistics/purchase-order-lines')` 가 팬텀이 되고, 질의 검증(날짜 형식·정수·불리언 변환)이 빠진다.
 * 하나라도 사라지면 당기는 그 순간 여기가 빨개진다.
 *
 * ⭐ 지우는 조건 — 설계팀이 정본에 같은 규격을 실어 오면. ⛔ 빨갛다고 지우지 마라.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONTRACT = join(__dirname, '../../../contracts/logistics-01자재창고.json');

describe('계약 사본 — 선반영한 입하 예정 P/O 라인 목록 (P-77)', () => {
  const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as {
    paths: Record<
      string,
      Record<string, { responses?: Record<string, unknown>; parameters?: { name?: string }[] }>
    >;
    components: {
      schemas: Record<string, { required?: string[]; properties?: Record<string, { enum?: string[] }> }>;
    };
  };

  it('⛔ GET /logistics/purchase-order-lines 가 있고 질의 열 칸을 받는다', () => {
    const get = contract.paths['/logistics/purchase-order-lines']?.get;
    expect((get?.parameters ?? []).map((parameter) => parameter.name)).toEqual([
      'expectedReceiptDateFrom',
      'expectedReceiptDateTo',
      'supplierId',
      'plantId',
      'itemId',
      'q',
      'openOnly',
      'overdueOnly',
      'page',
      'size',
    ]);
  });

  it('⛔ 403 을 선언하지 않는다 — 형제 조회(GET /logistics/asns·/logistics/purchase-orders)와 같다', () => {
    const get = contract.paths['/logistics/purchase-order-lines']?.get;
    expect(Object.keys(get?.responses ?? {})).toEqual(['200']);
  });

  it('⛔ 행 스키마 InboundScheduleLine 의 칸과 입하 진행 값이 그대로다', () => {
    const schema = contract.components.schemas.InboundScheduleLine;
    expect([...(schema?.required ?? [])].sort()).toEqual(
      [
        'purchaseOrderId',
        'purchaseOrderNo',
        'erpPurchaseOrderNo',
        'supplierId',
        'plantId',
        'orderDate',
        'expectedReceiptDate',
        'statusCode',
        'purchaseOrderLineId',
        'lineNo',
        'itemId',
        'uomId',
        'orderedQty',
        'receivedQty',
        'remainingQty',
        'toleranceOverQty',
        'toleranceUnderQty',
        'erpStorageLocationCode',
        'cancelledAt',
        'receiptStatusCode',
      ].sort(),
    );
    expect(schema?.properties?.receiptStatusCode?.enum).toEqual(['NOT_STARTED', 'PARTIAL', 'COMPLETED']);
  });
});

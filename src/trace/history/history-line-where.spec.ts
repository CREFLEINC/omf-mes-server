import { ContractException } from '../../common/errors';
import { materialInputLineWhere } from './material-input-line-list.service';
import { packingLineWhere } from './packing-line-list.service';

const TODAY = '2026-10-28';

function messageOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as ContractException).errors[0].message;
  }
  return undefined;
}

describe('기간별 이력 목록의 조건', () => {
  it('투입: 정정된 원 투입은 빼고, 공장·품목·LOT 번호·검색어(LOT·W/O 번호)를 AND 로 건다', () => {
    const { sql, params } = materialInputLineWhere({
      inputDateFrom: '2026-10-01', inputDateTo: '2026-10-28', plantId: 1, itemId: 2, lotNo: 'L-1', q: ' WO-7 ',
    }, TODAY);

    expect(sql).toContain('mc.occurred_at >= (($1::date)::timestamp AT TIME ZONE p.timezone_code)');
    expect(sql).toContain('cx.corrects_consumption_id = mc.material_consumption_id');
    expect(sql).toContain('lt.plant_id = $3::bigint');
    expect(sql).toContain('mc.item_id = $4::bigint');
    expect(sql).toContain('lt.lot_no = $5');
    expect(sql).toContain('(lt.lot_no ILIKE $6 OR wo.work_order_no ILIKE $6)');
    expect(params).toEqual(['2026-10-01', '2026-10-28', 1, 2, 'L-1', '%WO-7%']);
  });

  it('포장: 구성 줄 생성 시각으로 기간을 걸고, 검색어는 LOT 번호·취급 단위 번호다', () => {
    const { sql, params } = packingLineWhere({ packedDateFrom: '2026-10-01', itemId: 3, q: 'HU' }, TODAY);

    expect(sql).toContain('hc.created_at >= (($1::date)::timestamp AT TIME ZONE p.timezone_code)');
    expect(sql).toContain('hc.item_id = $2::bigint');
    expect(sql).toContain('(lt.lot_no ILIKE $3 OR hu.handling_unit_no ILIKE $3)');
    expect(params).toEqual(['2026-10-01', 3, '%HU%']);
  });

  it('기간 시작이 없으면 SQL 을 만들기 전에 그 칸을 짚는 400 이다', () => {
    for (const [build, name] of [[() => materialInputLineWhere({}, TODAY), 'inputDateFrom'], [() => packingLineWhere({}, TODAY), 'packedDateFrom']] as const) {
      try {
        build();
        throw new Error('던지지 않았다');
      } catch (error) {
        expect((error as ContractException).errors[0]).toMatchObject({ field: name, code: 'REQUIRED' });
      }
    }
  });

  it('집는 번호가 있으면 기간이 선택이다 — 투입은 LOT·W/O·입하 번호, 포장은 LOT·W/O·출하 번호', () => {
    const input = materialInputLineWhere({ workOrderNo: 'WO-1', inboundReceiptNo: 'IR-1', supplierId: 5 }, TODAY);
    expect(input.sql).not.toContain('AT TIME ZONE');
    expect(input.sql).toContain('wo.work_order_no = $1');
    expect(input.sql).toContain('ir.inbound_receipt_no = $2 AND ir.supplier_id = $3::bigint');

    const packing = packingLineWhere({ shipmentNo: 'SH-1', customerId: 6, workOrderNo: 'WO-1' }, TODAY);
    expect(packing.sql).not.toContain('AT TIME ZONE');
    expect(packing.sql).toContain('wo.work_order_no = $1');
    expect(packing.sql).toContain('xs.shipment_no = $2 AND xr.customer_id = $3::bigint');
  });

  it('기간도 집는 번호도 없으면 넣을 칸을 알리는 400 이다 — 공급사·고객·품목만으로는 부족하다', () => {
    expect(messageOf(() => materialInputLineWhere({ supplierId: 5 }, TODAY)))
      .toBe('조회 기간이 없습니다. 투입일 시작(inputDateFrom)을 넣거나 LOT 번호(lotNo), W/O 번호(workOrderNo), 입하 번호(inboundReceiptNo) 중 하나를 넣어 다시 조회하세요. 기간은 최대 366일입니다.');
    expect(messageOf(() => packingLineWhere({ customerId: 6, itemId: 1 }, TODAY)))
      .toBe('조회 기간이 없습니다. 포장일 시작(packedDateFrom)을 넣거나 LOT 번호(lotNo), W/O 번호(workOrderNo), 출하 번호(shipmentNo) 중 하나를 넣어 다시 조회하세요. 기간은 최대 366일입니다.');
  });
});

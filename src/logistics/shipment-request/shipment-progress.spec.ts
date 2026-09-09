import { Prisma } from '@prisma/client';

import {
  SHIPMENT_PROGRESS_CASE_SQL,
  SHIPMENT_PROGRESS_TOTALS_SQL,
  ShipmentProgressCode,
  ShipmentProgressLine,
  ShipmentProgressTotals,
  pickedQtyOf,
  shipmentProgressCode,
  shipmentProgressTotals,
} from './shipment-progress';

/**
 * `shipment-progress.ts` 의 갈래 단위 시험(계획 §8-6 · 14건). 이 PR 은 HTTP 오퍼레이션이 0건이라
 * **이 파일이 곧 반증**이다.
 *
 * ⭐⭐ 마지막 describe 가 **SQL 반쪽을 잠그는 유일한 그물**이다 — `SHIPMENT_PROGRESS_CASE_SQL` 을
 *    파싱해 «실제로 평가»하고 TS 판정과 6값 전부에서 맞춰 본다. 어느 한쪽의 경계 하나만 바꿔도
 *    빨개진다. ⛔ 「문자열이 비어 있지 않다」류 단언은 아무것도 안 죽여서 쓰지 않았다.
 * ⭐ 픽스처는 `R`·`A`·`P`·`S` 가 «서로 다른 값»이다(README §6-3 ⑵) — 넷이 같으면 어느 식을
 *   바꿔도 초록이다.
 */
const dec = (value: string | number): Prisma.Decimal => new Prisma.Decimal(String(value));

/** 예약 없이 라인 하나 — `P` 를 직접 주고 싶을 때는 `reserved` 한 줄로 준다. */
const line = (requested: number, allocated: number, picked: number, shipped: number): ShipmentProgressLine => ({
  requestedQty: dec(requested),
  allocatedQty: dec(allocated),
  shippedQty: dec(shipped),
  reservations: [{ reservedQty: dec(picked), releasedQty: dec(0) }],
});

const codeOf = (requested: number, allocated: number, picked: number, shipped: number): ShipmentProgressCode =>
  shipmentProgressCode(shipmentProgressTotals([line(requested, allocated, picked, shipped)]));

describe('shipmentProgressCode — 6값 각각(계약 ShipmentRequest.shipmentProgressCode)', () => {
  it('⭐ NOT_ALLOCATED — A = 0. 「뒤가 이긴다」의 유일한 예외라 맨 앞에서 잘라 낸다', () => {
    // ⛔⛔ A = 0 이면 PICKED(P=A ∧ S=0)와 SHIPPED(S=A)가 «공허참»이다 — 역순 사슬이면 답이
    //    SHIPPED 가 되고 NOT_ALLOCATED 가 도달 불가다(R-7 ⓐ · R-11).
    expect(codeOf(100, 0, 0, 0)).toBe('NOT_ALLOCATED');
    // 경계 «바로 위» — 0.000001 만 배정돼도 더는 NOT_ALLOCATED 가 아니다(numeric(20,6) 스케일).
    expect(codeOf(100, 0.000001, 0, 0)).not.toBe('NOT_ALLOCATED');
  });

  it('PARTIALLY_ALLOCATED — 0 < A < R 이고 피킹이 덜 끝났다', () => {
    expect(codeOf(100, 60, 20, 0)).toBe('PARTIALLY_ALLOCATED');
    expect(codeOf(100, 60, 0, 0)).toBe('PARTIALLY_ALLOCATED');
    // 경계 =: A 가 R 과 «같아지면» PICKING 으로 넘어간다.
    expect(codeOf(100, 100, 20, 0)).toBe('PICKING');
  });

  it('PICKING — A = R 이고 P < A', () => {
    expect(codeOf(100, 100, 40, 0)).toBe('PICKING');
    expect(codeOf(100, 100, 0, 0)).toBe('PICKING');
    // 경계 =: P 가 A 와 같아지면 PICKED. 경계 <: A 가 R 보다 작으면 PARTIALLY_ALLOCATED.
    expect(codeOf(100, 100, 100, 0)).toBe('PICKED');
    expect(codeOf(100, 99.999999, 40, 0)).toBe('PARTIALLY_ALLOCATED');
  });

  it('PICKED — P = A 이고 S = 0', () => {
    expect(codeOf(100, 100, 100, 0)).toBe('PICKED');
    // 경계 <: P 가 스케일 한 자리만 모자라도 PICKING 이다.
    expect(codeOf(100, 100, 99.999999, 0)).toBe('PICKING');
    // 경계 >: S 가 0 을 넘으면 출하 축이 이긴다.
    expect(codeOf(100, 100, 100, 0.000001)).toBe('PARTIALLY_SHIPPED');
  });

  it('PARTIALLY_SHIPPED — 0 < S < A', () => {
    expect(codeOf(100, 80, 80, 30)).toBe('PARTIALLY_SHIPPED');
    expect(codeOf(100, 80, 80, 79.999999)).toBe('PARTIALLY_SHIPPED');
    // 경계 =: S 가 A 와 같아지면 SHIPPED.
    expect(codeOf(100, 80, 80, 80)).toBe('SHIPPED');
  });

  it('SHIPPED — S = A 이고 A > 0', () => {
    expect(codeOf(100, 80, 80, 80)).toBe('SHIPPED');
    expect(codeOf(100, 100, 100, 100)).toBe('SHIPPED');
    // ⛔ `A > 0` 을 빼면 A = 0 인 건이 여기로 떨어진다 — 위 NOT_ALLOCATED 건과 짝이다.
    expect(codeOf(100, 0, 0, 0)).toBe('NOT_ALLOCATED');
  });
});

describe('shipmentProgressCode — 계획안이 이름을 대며 지목한 자리', () => {
  it('⭐ A = 0 이면 NOT_ALLOCATED 다 — 공허참으로 SHIPPED 가 되지 않는다', () => {
    // R-11: 이 값이 안 나오면 `W-04-02` 「상태」 드롭다운의 NOT_ALLOCATED 가 영영 빈 목록이다.
    expect(codeOf(100, 0, 0, 0)).toBe('NOT_ALLOCATED');
    // 라인이 여럿이어도(첫 라인만 보지 않는다) 배정 합이 0 이면 마찬가지다.
    expect(shipmentProgressCode(shipmentProgressTotals([line(40, 0, 0, 0), line(60, 0, 0, 0)]))).toBe('NOT_ALLOCATED');
  });

  it('⭐ 부분 배정이어도 P = A 면 PICKED 다 — PICKED 는 A = R 을 요구하지 않는다(R-7 ⓑ)', () => {
    expect(codeOf(100, 60, 60, 0)).toBe('PICKED');
  });

  it('부분 배정 + 0 < P < A 면 PARTIALLY_ALLOCATED 다 — 여기가 유일하게 갇히는 구간이다', () => {
    expect(codeOf(100, 60, 20, 0)).toBe('PARTIALLY_ALLOCATED');
    // ⭐ 라인 «전건»을 센다 — 첫 라인만 보면 그 라인이 PICKED 라 헤더가 잘못 오른다(§6-3 ⑵·⑶).
    expect(shipmentProgressCode(shipmentProgressTotals([line(40, 40, 40, 0), line(60, 20, 0, 0)]))).toBe(
      'PARTIALLY_ALLOCATED',
    );
    expect(shipmentProgressCode(shipmentProgressTotals([line(40, 40, 40, 0)]))).toBe('PICKED');
  });

  it('⭐ P 는 Σ(reserved − released) 다 — released 를 안 빼면 PICKED 로 잘못 오른다(R-14)', () => {
    expect(pickedQtyOf([{ reservedQty: dec(100), releasedQty: dec(40) }]).toString()).toBe('60');
    const released: ShipmentProgressLine = {
      requestedQty: dec(100),
      allocatedQty: dec(100),
      shippedQty: dec(0),
      // 두 줄이다 — 「첫 개만 센다」로 바꿔도 안 걸리는 픽스처를 피한다(README §6-3 ⑵).
      reservations: [
        { reservedQty: dec(70), releasedQty: dec(30) },
        { reservedQty: dec(30), releasedQty: dec(10) },
      ],
    };
    const totals = shipmentProgressTotals([released]);
    expect(totals.pickedQty.toString()).toBe('60');
    // ⛔ released 를 안 빼면 P = 100 = A 라 PICKED 가 된다 — I-23 이 푼 예약이 그대로 남는다.
    expect(shipmentProgressCode(totals)).toBe('PICKING');
  });

  it('Decimal 로 센다 — 0.1 + 0.2 가 0.3 이다(부동소수면 PICKED 가 PICKING 으로 샌다)', () => {
    expect(pickedQtyOf([{ reservedQty: dec('0.1'), releasedQty: dec(0) }, { reservedQty: dec('0.2'), releasedQty: dec(0) }]).toString()).toBe('0.3');
    // ⭐ A 는 «한 줄»로 0.3 이고 P 는 «두 줄»의 합이다 — 양쪽을 같은 방식으로 접으면 부동소수라도
    //   우연히 같아져 함정을 안 건드린다(README §6-3 ⑸).
    const totals = shipmentProgressTotals([
      {
        requestedQty: dec('0.3'),
        allocatedQty: dec('0.3'),
        shippedQty: dec(0),
        reservations: [
          { reservedQty: dec('0.1'), releasedQty: dec(0) },
          { reservedQty: dec('0.2'), releasedQty: dec(0) },
        ],
      },
    ]);
    expect(shipmentProgressCode(totals)).toBe('PICKED');
  });

  it('라인이 0건이면 NOT_ALLOCATED 다 — 편성 직후가 그 상태다', () => {
    expect(shipmentProgressCode(shipmentProgressTotals([]))).toBe('NOT_ALLOCATED');
  });
});

/**
 * ⭐⭐ **이 PR 의 심장** — SQL 반쪽에는 호출자가 없다. 그래서 여기가 그것을 잠그는 유일한 그물이다.
 * `SHIPMENT_PROGRESS_CASE_SQL` 을 파싱해 «평가»하고 TS 판정과 대조한다.
 * ⛔ 읽을 수 없는 술어가 나오면 «던진다» — 조용히 통과하면 그물이 없는 것과 같다.
 */
type Row = { r: number; a: number; p: number; s: number };

const COLUMN: Record<string, keyof Row> = {
  't.requested_qty': 'r',
  't.allocated_qty': 'a',
  't.picked_qty': 'p',
  't.shipped_qty': 's',
};

function operand(token: string, row: Row): number {
  const column = COLUMN[token];
  if (column !== undefined) return row[column];
  const value = Number(token);
  if (!Number.isFinite(value)) throw new Error(`모르는 피연산자: ${token}`);
  return value;
}

function evalPredicate(sql: string, row: Row): boolean {
  return sql.split(' AND ').every((term) => {
    const match = /^(\S+) (=|<>|<=|>=|<|>) (\S+)$/.exec(term.trim());
    if (match === null) throw new Error(`평가할 수 없는 술어: ${term}`);
    const left = operand(match[1], row);
    const right = operand(match[3], row);
    switch (match[2]) {
      case '=':
        return left === right;
      case '<>':
        return left !== right;
      case '<':
        return left < right;
      case '<=':
        return left <= right;
      case '>':
        return left > right;
      default:
        return left >= right;
    }
  });
}

function parsedCase(): { branches: [string, string][]; fallback: string } {
  const branches: [string, string][] = [];
  let fallback: string | undefined;
  for (const text of SHIPMENT_PROGRESS_CASE_SQL.split('\n')) {
    const when = /^\s*WHEN (.+) THEN '([A-Z_]+)'$/.exec(text);
    if (when !== null) branches.push([when[1], when[2]]);
    const otherwise = /^\s*ELSE '([A-Z_]+)'$/.exec(text);
    if (otherwise !== null) fallback = otherwise[1];
  }
  if (branches.length !== 5 || fallback === undefined) throw new Error(`CASE 를 못 읽었다:\n${SHIPMENT_PROGRESS_CASE_SQL}`);
  return { branches, fallback };
}

function sqlProgressCode(row: Row): string {
  const { branches, fallback } = parsedCase();
  return branches.find(([predicate]) => evalPredicate(predicate, row))?.[1] ?? fallback;
}

const tsProgressCode = (row: Row): ShipmentProgressCode => {
  const totals: ShipmentProgressTotals = {
    requestedQty: dec(row.r),
    allocatedQty: dec(row.a),
    pickedQty: dec(row.p),
    shippedQty: dec(row.s),
  };
  return shipmentProgressCode(totals);
};

/** ⭐ 6값을 «전부» 내는 격자 + 경계(=, 스케일 한 자리 아래·위) + 음수 한 줄(연산자 모양 고정). */
const GRID: Row[] = [
  { r: 100, a: 0, p: 0, s: 0 },
  { r: 100, a: 60, p: 0, s: 0 },
  { r: 100, a: 60, p: 20, s: 0 },
  { r: 100, a: 60, p: 60, s: 0 },
  { r: 100, a: 100, p: 0, s: 0 },
  { r: 100, a: 100, p: 40, s: 0 },
  { r: 100, a: 100, p: 99.999999, s: 0 },
  { r: 100, a: 100, p: 100, s: 0 },
  { r: 100, a: 80, p: 80, s: 0.000001 },
  { r: 100, a: 80, p: 80, s: 30 },
  { r: 100, a: 80, p: 80, s: 79.999999 },
  { r: 100, a: 80, p: 80, s: 80 },
  { r: 100, a: 100, p: 100, s: 100 },
  { r: 100, a: 0.000001, p: 0, s: 0 },
  // ⭐ P > A — 예약 롤업과 `allocated_qty` 는 «다른 표»라 이것을 막는 제약이 없다(과피킹).
  //   `A == R && P < A` 의 뒤 절이 이 줄에서만 드러난다.
  { r: 100, a: 100, p: 120, s: 0 },
  // ⛔⛔ 아래 셋은 물리가 못 내는 값이다(`app.qty_t CHECK (VALUE >= 0)` · `ck_shipment_request_qty`
  //    `S <= A <= R`). 그래도 «격자에 둔다» — 이 파일의 주장은 「TS 판정과 SQL CASE 가 같은 전역
  //    함수다」이고, 그러려면 닿지 않는 입력에서도 답이 갈리면 안 된다. 실제로 이 셋이 각각
  //    `A = 0`→`A <= 0` · `S = A && A > 0` 의 뒤 절 · `P = A && S = 0` 의 뒤 절 · `P < A` 를 잡는다.
  // ⛔⛔ 그 절들은 앞 분기에 가려 «중복»이다 — 「`&& A > 0` 은 `A = 0` 분기가 앞에 있으니 군더더기」
  //    라며 지우고 싶어진다. §5-1 의 사슬을 «글자 그대로» 유지하려고 남긴 것이고, TS 와 SQL 양쪽에
  //    똑같이 있다. 이 세 줄이 그 중복을 잠근다 — 셋을 지우면 한쪽만 지우는 변경이 조용히 통과한다.
  { r: 100, a: -1, p: -1, s: -1 },
  { r: 100, a: 80, p: 80, s: 90 },
  { r: 100, a: 100, p: 100, s: 110 },
];

describe('⭐ TS 판정과 SQL 술어가 같은 6값 경계를 쓴다 (문자열 대조)', () => {
  it('CASE 를 평가한 값이 격자 전건에서 TS 판정과 같다 — 한쪽 경계만 바꾸면 빨개진다', () => {
    for (const row of GRID) {
      expect([JSON.stringify(row), sqlProgressCode(row)]).toEqual([JSON.stringify(row), tsProgressCode(row)]);
    }
  });

  it('격자가 6값을 «전부» 낸다 — 한 값이라도 안 나오면 그 값의 경계는 대조되지 않은 것이다', () => {
    // README §6-3 ⑵ — 축에 값이 한 종류뿐이면 그 단언은 없는 것이다.
    expect([...new Set(GRID.map(tsProgressCode))].sort()).toEqual([
      'NOT_ALLOCATED',
      'PARTIALLY_ALLOCATED',
      'PARTIALLY_SHIPPED',
      'PICKED',
      'PICKING',
      'SHIPPED',
    ]);
  });

  it('SQL 총계가 released 를 빼고, 예약 원천을 좁히고, sum 을 전부 coalesce 로 싼다', () => {
    const sql = SHIPMENT_PROGRESS_TOTALS_SQL;
    // ⭐ `P` 의 정의가 `pickedQtyOf` 와 한 글자도 달라선 안 된다(R-14).
    expect(sql).toContain('sum(res.reserved_qty - res.released_qty)');
    // ⛔ 좁히지 않으면 자재 피킹(I-8)의 예약이 제품 진행에 섞인다(이슈 #409 형).
    expect(sql).toContain("res.source_document_type_code = 'SHIPMENT_REQUEST_LINE'");
    expect(sql).toContain('res.source_document_id = srl.shipment_request_line_id');
    expect(sql).toContain('srl.shipment_request_id = sr.shipment_request_id');
    // ⭐ 별칭이 «어느» 원천 칸에서 나는지 고정한다 — 별칭만 맞고 원천이 뒤바뀌면 목록의 6값과
    //   ③b 의 응답 칸이 갈린다(I-20 R-2 형). 별칭 이름 자체는 CASE 가 읽는 이름이다.
    expect(sql).toContain('FROM logistics.shipment_request_line srl');
    for (const [source, alias] of [
      ['requested_qty', 'requested_qty'],
      ['allocated_qty', 'allocated_qty'],
      ['shipped_qty', 'shipped_qty'],
    ]) {
      expect(sql).toMatch(new RegExp(`coalesce\\(sum\\(srl\\.${source}\\), 0\\)\\s+AS ${alias}\\b`));
    }
    // ⛔ CASE 가 읽는 네 이름이 곧 이 총계의 별칭 «전부»다 — 하나라도 어긋나면 런타임 42703 이다.
    expect((sql.match(/AS (\w+)/g) ?? []).map((text) => text.slice(3)).sort()).toEqual(
      Object.keys(COLUMN)
        .map((column) => column.replace('t.', ''))
        .sort(),
    );
    // ⛔ 집계 NULL — 라인 0건이면 sum 이 NULL 이라 비교가 UNKNOWN 이 되고 행이 사라진다(§6-3 ⑷).
    expect(sql.match(/coalesce\(sum\(/g) ?? []).toHaveLength((sql.match(/sum\(/g) ?? []).length);
  });
});

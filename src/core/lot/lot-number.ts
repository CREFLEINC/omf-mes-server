import { randomBytes } from 'node:crypto';

/**
 * LOT 번호 — 출처가 둘이고 실패의 «성격»이 다르다(계약 `POST /trace/lots`).
 *
 * | 출처 | 번호 | 충돌하면 |
 * |---|---|---|
 * | `SUPPLIER` | 스캔한 값이 그대로 | **400** — 사람이 스캔값을 고쳐야 풀린다 |
 * | `MES` | 서버가 매긴다 | **409** — 서버가 먼저 다시 뽑고, 그래도 안 되면. 다시 부르면 풀린다 |
 *
 * ⛔ MES 충돌에 400 을 내지 않는다 — 「사용자가 고칠 수 있는 값이 아니기 때문」(계약).
 *
 * ⚠ **자재** LOT(아래 `materialMesLotNo`)의 형식은 계약이 34자리 고정폭만 확정했었으나
 * (MLOT #16), **통보 277(2026-09-14)로 구분자 5칸 가변폭으로 바뀌었다**(되돌림 §Z-1).
 * **생산** LOT(`mesLotNo`)은 이 개정과 무관하게 그대로 34자리다.
 */

export const LOT_NO_LENGTH = 34;

/** 사람이 라벨에서 읽고 받아 적는 값이라 헷갈리는 글자(0·O·1·I)를 뺀다. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * `M` + 공장 6 + `YYYYMMDD` 8 + 그날 순번 6 + 난수 13 = **34자**.
 *
 * 순번은 「몇 번째로 발번했나」를 사람이 읽게 하고, 난수는 같은 순간에 두 건이 들어와도
 * 부딪히지 않게 한다. 부딪히면 호출자가 다시 부른다.
 */
export function mesLotNo(plantId: number, businessDate: string, todaySeq: number): string {
  const no =
    'M' +
    String(plantId).padStart(6, '0').slice(-6) +
    businessDate.replace(/-/g, '') +
    String(todaySeq).padStart(6, '0').slice(-6) +
    randomChars(13);
  return no;
}

function randomChars(length: number): string {
  // ⛔ `%` 로 자르지 않고 버리고 다시 뽑는다 — 256 이 알파벳 길이의 배수가 아니면
  // 나머지 연산이 앞쪽 글자를 더 자주 뽑는다(모듈로 편향).
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * 자재 LOT 번호 — 구분자 5칸 형식 (통보 277 · 2026-09-14).
 *
 * ```
 * 040101-00022S|12.5|260731|100019|0001
 * 제품코드      |수량 |날짜  |공급사|번호
 * ```
 *
 * 칸 값은 `|`·비ASCII·제어문자·빈 문자열을 금지한다(printable ASCII 만). 전체 64자 이하
 * (`lot.lot_no` 는 `varchar(100)` 이지만, 실 데이터로 잰 자재 품목코드 최대 13자·공급사
 * 코드 최대 10자 기준으로 여유 있게 잡은 상한이다).
 */

export const MATERIAL_LOT_SEPARATOR = '|';
export const MATERIAL_LOT_MAX_LENGTH = 64;

export interface MaterialLotSegments {
  itemCode: string;
  /** 파싱 시엔 정규형이 아니어도(`12.50`) 통과한다 — `parseMaterialLotNo` 머리말 참조. */
  qty: string;
  /** `YYMMDD`. */
  date: string;
  supplierCode: string;
  /** 1~9999. */
  serial: number;
}

/** `kind` — `SEGMENT` 는 칸 값(문자·날짜·번호) 위반, `LENGTH` 는 조립 길이 초과. */
export class MaterialLotFormatError extends Error {
  constructor(
    message: string,
    readonly kind: 'SEGMENT' | 'LENGTH',
  ) {
    super(message);
    this.name = 'MaterialLotFormatError';
  }
}

/** printable ASCII 만 허용한다 — 스캐너가 키보드 입력처럼 흘려보내므로 재현 안 되는 문자를 막는다. */
function assertMaterialLotSegment(value: string, name: string): string {
  if (value === '' || value.includes(MATERIAL_LOT_SEPARATOR) || !/^[\x20-\x7E]*$/.test(value)) {
    throw new MaterialLotFormatError(`${name}에는 구분자·빈 값·비ASCII·제어문자를 쓸 수 없습니다.`, 'SEGMENT');
  }
  return value;
}

/**
 * DB 스케일(`Decimal(20,6)`)과 일치하는 정규형 문자열로 만든다 — 그래야 라벨에 찍힌 수량과
 * 실제 저장값이 항상 같다. 후행 0 을 떼고, 정수면 소수점을 남기지 않는다.
 */
export function normalizeLotQty(qty: number): string {
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new MaterialLotFormatError('수량은 0보다 큰 유한한 값이어야 합니다.', 'SEGMENT');
  }
  const fixed = qty.toFixed(6);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/** 2000년대로 고정해 윤년까지 실재 여부를 본다 — 이 번호의 날짜는 업무 판단에 쓰지 않으므로 세기 규약은 뜻이 없다. */
function isRealCalendarDate(yy: number, mm: number, dd: number): boolean {
  const d = new Date(Date.UTC(2000 + yy, mm - 1, dd));
  return d.getUTCFullYear() === 2000 + yy && d.getUTCMonth() === mm - 1 && d.getUTCDate() === dd;
}

/**
 * `businessDate`(`YYYY-MM-DD`)를 `YYMMDD` 로 줄인다. ⛔ 자르기만 하면 `260230` 같은 없는
 * 날짜가 샌다 — 실재하는 달력 날짜만 통과시킨다.
 */
function materialLotDateSegment(businessDate: string): string {
  const match = /^\d{2}(\d{2})-(\d{2})-(\d{2})$/.exec(businessDate);
  if (!match || !isRealCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    throw new MaterialLotFormatError('업무일자가 YYYY-MM-DD 형식의 실재하는 날짜가 아닙니다.', 'SEGMENT');
  }
  return `${match[1]}${match[2]}${match[3]}`;
}

/** 1~9999 의 4자리 0채움 — 방어용 검사다. 소진(다음 번호가 9999 를 넘음) 판정은 registry 가 미리 한다. */
function materialLotSerialSegment(serial: number): string {
  if (!Number.isInteger(serial) || serial < 1 || serial > 9999) {
    throw new MaterialLotFormatError('번호는 1~9999 사이의 정수여야 합니다.', 'SEGMENT');
  }
  return String(serial).padStart(4, '0');
}

/**
 * 앞 4칸(제품코드·수량·날짜·공급사) + 구분자 — 접두 조회용. 번호(마지막 4칸)는 아직 없다.
 * `nextInboundMaterialLotNo` 가 이 접두로 기존 LOT 을 세어 다음 번호를 정한다.
 */
export function materialLotPrefix(input: {
  itemCode: string;
  qty: number;
  businessDate: string;
  supplierCode: string;
}): string {
  const segments = [
    assertMaterialLotSegment(input.itemCode, '제품코드'),
    normalizeLotQty(input.qty),
    materialLotDateSegment(input.businessDate),
    assertMaterialLotSegment(input.supplierCode, '공급사 코드'),
  ];
  const prefix = segments.join(MATERIAL_LOT_SEPARATOR) + MATERIAL_LOT_SEPARATOR;
  // 번호 칸은 항상 4자다 — 여기서 미리 셈해 둔다.
  if (prefix.length + 4 > MATERIAL_LOT_MAX_LENGTH) {
    throw new MaterialLotFormatError(`자재 LOT 번호가 ${String(MATERIAL_LOT_MAX_LENGTH)}자를 넘습니다.`, 'LENGTH');
  }
  return prefix;
}

/**
 * 스캔값·기존 행을 칸으로 되읽는다.
 *
 * ⭐ **수량 칸은 관대하게 본다.** 공급사가 라벨에 `12.50`을 찍어도(우리 정규형은 `12.5`)
 * 파싱은 통과시킨다 — 이 칸은 비교 대상이 아니고(수량 스냅샷은 분할·부분 입고로 실제와
 * 달라질 수 있다), 현장 작업자는 공급사 라벨을 다시 찍을 수 없다. 형태(`\d+(\.\d+)?`)만 본다.
 */
export function parseMaterialLotNo(lotNo: string): MaterialLotSegments {
  const parts = lotNo.split(MATERIAL_LOT_SEPARATOR);
  if (parts.length !== 5) {
    throw new MaterialLotFormatError('자재 LOT 번호는 5칸이어야 합니다.', 'SEGMENT');
  }
  const [itemCode, qty, date, supplierCode, serialText] = parts;
  assertMaterialLotSegment(itemCode, '제품코드');
  assertMaterialLotSegment(supplierCode, '공급사 코드');
  if (!/^\d+(\.\d+)?$/.test(qty)) {
    throw new MaterialLotFormatError('수량 칸 형식이 올바르지 않습니다.', 'SEGMENT');
  }
  const dateMatch = /^(\d{2})(\d{2})(\d{2})$/.exec(date);
  if (!dateMatch || !isRealCalendarDate(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3]))) {
    throw new MaterialLotFormatError('날짜 칸이 실재하는 날짜가 아닙니다.', 'SEGMENT');
  }
  const serialMatch = /^(\d{4})$/.exec(serialText);
  const serial = serialMatch ? Number(serialMatch[1]) : NaN;
  if (!serialMatch || serial < 1) {
    throw new MaterialLotFormatError('번호 칸은 0001~9999 의 4자리 숫자여야 합니다.', 'SEGMENT');
  }
  return { itemCode, qty, date, supplierCode, serial };
}

/**
 * 입하 자재의 MES 내부 LOT. 앞 4칸 + 번호(마지막 4칸)를 조립한다 — 각 칸의 규칙은
 * `materialLotPrefix`/`materialLotSerialSegment` 를 본다. 생산 LOT은 이 함수가 아니라
 * `mesLotNo` 체계를 계속 쓴다.
 */
export function materialMesLotNo(input: {
  itemCode: string;
  qty: number;
  businessDate: string;
  supplierCode: string;
  serial: number;
}): string {
  return materialLotPrefix(input) + materialLotSerialSegment(input.serial);
}

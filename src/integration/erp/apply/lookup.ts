import { localDate } from '../../../planning/production-plan/plan-window';
import { Tx } from '../inbound-cycle';

/**
 * ERP 코드 → MES id. 못 찾으면 그 행을 실패로 남긴다 — 참조가 아직 안 들어온 것일 수 있어
 * 다음 회차에 다시 시도한다(실행기가 참조되는 표를 먼저 돈다).
 */

export interface Plant {
  plant_id: bigint;
  business_unit_id: bigint | null;
  timezone_code: string;
}

/** ⛔ 같은 코드의 공장이 둘이면(법인이 둘) 어느 쪽인지 정할 수 없다 — 고르지 않는다. */
export async function plantByCode(tx: Tx, plantCode: string): Promise<Plant> {
  const plants = await tx.plant.findMany({
    where: { plant_code: plantCode },
    select: { plant_id: true, business_unit_id: true, timezone_code: true },
    take: 2,
  });
  if (plants.length !== 1) {
    throw new Error(`공장 ${plantCode} 이 ${plants.length === 0 ? '없다' : '둘 이상이다'}`);
  }
  return plants[0];
}

/** 공장의 사업부 — 전표·작업자의 필수 칸이다. */
export function businessUnitOf(plantCode: string, plant: Plant): bigint {
  if (plant.business_unit_id === null) throw new Error(`공장 ${plantCode} 에 사업부가 없다`);
  return plant.business_unit_id;
}

/** 그 공장의 오늘(YYYY-MM-DD) — `plant.timezone_code` 로 푼다. */
export function plantToday(plant: Plant): string {
  return localDate(new Date(), plant.timezone_code);
}

/**
 * 품목코드 → id. 같은 품목을 반각·전각으로 달리 적는 곳이 있어(`FS-536（SD）`) 그대로 못 찾으면
 * NFKC 로 맞춘다 — 운영 초기 데이터와 같은 방법이다. 둘 이상 맞으면 고르지 않는다.
 */
export async function itemIdsByCode(tx: Tx, codes: string[]): Promise<Map<string, bigint>> {
  const wanted = [...new Set(codes)];
  const exact = await tx.item.findMany({
    where: { item_code: { in: wanted } },
    select: { item_id: true, item_code: true },
  });
  const found = new Map(exact.map((item) => [item.item_code, item.item_id]));
  const missing = wanted.filter((code) => !found.has(code));
  if (missing.length > 0) {
    const normalized = missing.map((code) => code.normalize('NFKC'));
    const loose = await tx.$queryRaw<{ item_id: bigint; item_code: string }[]>`
      SELECT item_id, item_code FROM mdm.item WHERE normalize(item_code, NFKC) = ANY(${normalized}::text[])`;
    for (const code of missing) {
      const matches = loose.filter(
        (item) => item.item_code.normalize('NFKC') === code.normalize('NFKC'),
      );
      if (matches.length !== 1) {
        throw new Error(`품목 ${code} 이 ${matches.length === 0 ? '없다' : '둘 이상이다'}`);
      }
      found.set(code, matches[0].item_id);
    }
  }
  return found;
}

/** ERP 단위 코드를 글자 그대로 찾는다 — GR 을 G 로 바꾸지 않는다. */
export async function uomIdsByCode(tx: Tx, codes: string[]): Promise<Map<string, bigint>> {
  const wanted = [...new Set(codes)].filter((code) => code !== '');
  const uoms = await tx.uom.findMany({
    where: { uom_code: { in: wanted } },
    select: { uom_id: true, uom_code: true },
  });
  const found = new Map(uoms.map((uom) => [uom.uom_code, uom.uom_id]));
  const missing = wanted.find((code) => !found.has(code));
  if (missing !== undefined) throw new Error(`단위 ${missing} 이 없다`);
  return found;
}

/** ERP 거래처 코드 → id. MES 거래처 코드가 ERP 코드 그대로다. */
export async function partnerIdByCode(tx: Tx, partnerCode: string): Promise<bigint> {
  const partner = await tx.partner.findUnique({
    where: { partner_code: partnerCode },
    select: { partner_id: true },
  });
  if (partner === null) throw new Error(`거래처 ${partnerCode} 이 없다`);
  return partner.partner_id;
}

/** ERP 의 날짜 문자열(YYYY-MM-DD) → `@db.Date`. 타임존 캐스팅 없이 그 날짜 그대로. */
export function dateOf(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`날짜 ${value} 를 읽을 수 없다`);
  return new Date(`${value}T00:00:00.000Z`);
}

import { Prisma } from '@prisma/client';

/** 단계마다 코드 조각 — 구역 Z01 · 랙 R001(100개를 넘는다) · 층 L01 · 셀 C01. 사용자 결정 2026-10-29. */
const SEGMENTS: Readonly<Record<string, { prefix: string; width: number }>> = {
  ZONE: { prefix: 'Z', width: 2 },
  RACK: { prefix: 'R', width: 3 },
  LEVEL: { prefix: 'L', width: 2 },
  CELL: { prefix: 'C', width: 2 },
};

/** 같은 창고의 위치 코드 발행을 한 줄로 세운다 — 같은 상위 밑에 동시에 만들면 같은 번호를 집는다. */
export async function lockWarehouse(tx: Prisma.TransactionClient, warehouseId: number): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM mdm.warehouse WHERE warehouse_id = ${BigInt(warehouseId)} FOR UPDATE`;
}

/**
 * 다음 코드 — 상위 코드 뒤에 단계 조각과 같은 상위 밑 가장 큰 번호 + 1 을 붙인다. 꺼진 위치의 번호도 센다.
 * 자리 수를 넘으면 늘어난다(Z100). ⚠ `lockWarehouse` 뒤에 부른다.
 */
export async function issueCode(
  tx: Prisma.TransactionClient,
  warehouseId: number,
  parent: { locationId: number; locationCode: string } | null,
  level: string,
): Promise<string> {
  const { prefix, width } = SEGMENTS[level];
  const head = parent === null ? prefix : `${parent.locationCode}-${prefix}`;
  const siblings = await tx.location.findMany({
    where: {
      warehouse_id: warehouseId,
      parent_location_id: parent === null ? null : parent.locationId,
      location_code: { startsWith: head },
    },
    select: { location_code: true },
  });
  const numbers = siblings
    .map((row) => row.location_code.slice(head.length))
    .filter((rest) => /^\d+$/.test(rest))
    .map(Number);
  let next = Math.max(0, ...numbers) + 1;
  // 사람이 짓던 옛 코드와 겹치면 건너뛴다 — 코드는 창고 안에서 유일하다(uq_location).
  for (;;) {
    const code = `${head}${String(next).padStart(width, '0')}`;
    const taken = await tx.location.count({ where: { warehouse_id: warehouseId, location_code: code } });
    if (taken === 0) return code;
    next += 1;
  }
}

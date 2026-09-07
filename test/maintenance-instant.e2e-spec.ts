import { PrismaClient } from '@prisma/client';

import {
  maintenanceInstantFromEpoch,
  parseMaintenanceInstant,
} from '../src/maintenance/maintenance-instant';

interface EpochRow {
  epoch_microseconds: string;
}

describe('I-32 P0t maintenance instant PostgreSQL round trip (e2e)', () => {
  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it.each([
    ['2026-09-06T03:00:00.123456Z', '1788663600123456'],
    ['2026-09-06T10:00:00.123456+07:00', '1788663600123456'],
    ['1969-12-31T23:59:59.999999Z', '-1'],
    ['0000-01-01T00:00:00Z', '-62167219200000000'],
    ['0000-02-29T12:34:56.654321Z', '-62162076303345679'],
    ['2026-09-07T00:00:00+23:59', '1788652860000000'],
    ['0000-01-01T00:00:00.000000Z', '-62167219200000000'],
    ['9999-12-31T23:59:59.999999Z', '253402300799999999'],
  ])('%s를 상수 바인딩 SELECT로 exact µs 왕복한다', async (value, expectedEpoch) => {
    const instant = parseMaintenanceInstant(value, 'startedAt');
    const [row] = await prisma.$queryRaw<EpochRow[]>`
      SELECT ((extract(epoch FROM ${instant.sqlTimestamp}::timestamptz) * 1000000)::bigint)::text
             AS epoch_microseconds`;

    expect(instant.epochMicroseconds).toBe(BigInt(expectedEpoch));
    expect(row.epoch_microseconds).toBe(expectedEpoch);
    expect(maintenanceInstantFromEpoch(row.epoch_microseconds)).toEqual(instant);
  });
});

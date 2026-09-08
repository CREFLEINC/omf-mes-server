import { serial_number } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';

export interface SerialNumberView {
  serialNumberId: number;
  serialNo: string;
  itemId: number;
  lotId: number;
  statusCode: string;
  producedAt?: string;
  versionNo: number;
}

export function serialNumberView(row: serial_number): SerialNumberView {
  return omitEmpty({
    serialNumberId: Number(row.serial_number_id),
    serialNo: row.serial_no,
    itemId: Number(row.item_id),
    lotId: Number(row.lot_id),
    statusCode: row.status_code,
    producedAt: row.produced_at?.toISOString(),
    versionNo: row.version_no,
  });
}

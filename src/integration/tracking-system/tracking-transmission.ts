import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';

type Tx = Prisma.TransactionClient;

export interface Transmission {
  transmissionId: string;
  kindCode: string;
  plantId: bigint;
  workOrderId: bigint | null;
  payload: unknown;
}

/** 이미 처리한 전송 번호면 `null` 이다. 같은 번호를 다른 요청이 처리하는 중이면 그쪽이 끝날 때까지 기다린다. */
export async function claimTransmission(tx: Tx, transmission: Transmission): Promise<bigint | null> {
  const rows = await tx.$queryRaw<{ tracking_transmission_id: bigint }[]>`
    INSERT INTO integration.tracking_transmission (transmission_id, kind_code, plant_id, work_order_id, payload)
    VALUES (${transmission.transmissionId}::uuid, ${transmission.kindCode}, ${transmission.plantId}, ${transmission.workOrderId},
            ${JSON.stringify(transmission.payload)}::jsonb)
    ON CONFLICT (transmission_id) DO NOTHING
    RETURNING tracking_transmission_id`;
  return rows[0]?.tracking_transmission_id ?? null;
}

export function screen(code: string, message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'screen', code, message }]);
}

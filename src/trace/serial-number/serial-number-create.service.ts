import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  ConflictException,
  ContractException,
  ERROR_CODE,
  field,
  one,
} from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency';
import { assertWorkerNoExists } from '../../common/master';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { SerialNumberView, serialNumberView } from './serial-number-view';
import { SerialNumberWriteContext } from './serial-number-write-context';

const INITIAL_STATUS = 'REGISTERED';
const PRODUCTION_LOT_SOURCE = 'WORK_ORDER';
const MAX_NUMBER_ATTEMPTS = 3;

export interface SerialNumberBatchCreate {
  lotId: number;
  quantity: number;
  producedAt?: string;
}

export interface SerialNumberBatchResult {
  items: SerialNumberView[];
  issuedCount: number;
}

interface LockedLot {
  item_id: bigint;
  source_type_code: string;
  source_id: bigint;
  completed_at: Date | null;
}

@Injectable()
export class SerialNumberCreateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async create(
    input: SerialNumberBatchCreate,
    context: SerialNumberWriteContext,
  ): Promise<SerialNumberBatchResult> {
    const replay =
      await this.idempotency.replayExisting<SerialNumberBatchResult>(context);
    if (replay !== undefined) return replay.body;

    await this.assertRequest(input, context);
    const periodDate = new Date(input.producedAt ?? Date.now())
      .toISOString()
      .slice(0, 10);
    for (let attempt = 1; attempt <= MAX_NUMBER_ATTEMPTS; attempt += 1) {
      const serialNos = await this.numbering.nextMany(
        'SERIAL_NUMBER',
        null,
        periodDate,
        input.quantity,
      );
      try {
        const outcome = await this.idempotency.run(context, (tx) =>
          this.createWithin(tx, input, context, serialNos),
        );
        return outcome.body;
      } catch (error) {
        if (!isSerialNumberDuplicate(error)) throw error;
        if (attempt === MAX_NUMBER_ATTEMPTS) {
          throw new ConflictException(
            'workerLease',
            '일련번호 충돌로 발번을 완료하지 못했습니다. 다시 시도하세요.',
            { code: 'DUPLICATE_KEY' },
          );
        }
      }
    }
    throw new Error('제품 개체 발번 재시도 경계를 벗어났습니다.');
  }

  private async assertRequest(
    input: SerialNumberBatchCreate,
    context: SerialNumberWriteContext,
  ): Promise<void> {
    assertInput(input);
    const [, lot] = await Promise.all([
      assertWorkerNoExists(this.prisma, context.workerNo),
      this.prisma.lot.findUnique({
        where: { lot_id: BigInt(input.lotId) },
        select: {
          item_id: true,
          source_type_code: true,
          source_id: true,
          completed_at: true,
        },
      }),
    ]);
    assertLot(lot, input.lotId);
    await assertTerminalGate(this.prisma, lot.source_id, context.terminalId);
  }

  private async createWithin(
    tx: Prisma.TransactionClient,
    input: SerialNumberBatchCreate,
    context: SerialNumberWriteContext,
    serialNos: string[],
  ): Promise<SerialNumberBatchResult> {
    const lot = await lockLot(tx, input.lotId);
    assertLot(lot, input.lotId);
    await assertWorkerNoExists(tx, context.workerNo);
    await assertTerminalGate(tx, lot.source_id, context.terminalId);
    const producedAt = input.producedAt ?? null;
    const values = serialNos.map(
      (serialNo) =>
        Prisma.sql`(${serialNo},${lot.item_id},${BigInt(input.lotId)},${INITIAL_STATUS},${producedAt}::timestamptz,${context.appUserId === undefined ? null : BigInt(context.appUserId)})`,
    );
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO trace.serial_number (serial_no,item_id,lot_id,status_code,produced_at,created_by)
      VALUES ${Prisma.join(values)}`);
    const rows = await tx.serial_number.findMany({
      where: { serial_no: { in: serialNos } },
    });
    const byNo = new Map(
      rows.map((row) => [row.serial_no, serialNumberView(row)]),
    );
    const items = serialNos.map((serialNo) => {
      const view = byNo.get(serialNo);
      if (view === undefined)
        throw new Error('생성한 제품 개체를 모두 다시 읽지 못했습니다.');
      return view;
    });
    return { items, issuedCount: items.length };
  }
}

function assertInput(input: SerialNumberBatchCreate): void {
  if (!Number.isSafeInteger(input.lotId) || input.lotId < 1) {
    throw one(
      field(
        'lotId',
        ERROR_CODE.RANGE,
        'LOT ID는 1 이상의 안전한 정수여야 합니다.',
      ),
    );
  }
  if (
    !Number.isSafeInteger(input.quantity) ||
    input.quantity < 1 ||
    input.quantity > 1000
  ) {
    throw one(
      field(
        'quantity',
        ERROR_CODE.RANGE,
        '발번 수량은 1~1000의 정수여야 합니다.',
      ),
    );
  }
  if (
    input.producedAt !== undefined &&
    Number.isNaN(Date.parse(input.producedAt))
  ) {
    throw one(
      field(
        'producedAt',
        ERROR_CODE.INVALID,
        '생산 시각 형식이 올바르지 않습니다.',
      ),
    );
  }
}

function assertLot(
  lot: LockedLot | null,
  lotId: number,
): asserts lot is LockedLot {
  if (lot === null || lot.source_type_code !== PRODUCTION_LOT_SOURCE) {
    throw one(
      field(
        'lotId',
        ERROR_CODE.INVALID,
        `생산 LOT을 찾을 수 없습니다: ${lotId}`,
      ),
    );
  }
  if (lot.completed_at !== null)
    throw one(
      field(
        'lotId',
        ERROR_CODE.STATE_LOCKED,
        '완료된 LOT에는 발번할 수 없습니다.',
      ),
    );
}

async function lockLot(
  tx: Prisma.TransactionClient,
  lotId: number,
): Promise<LockedLot | null> {
  const rows = await tx.$queryRaw<LockedLot[]>`
    SELECT item_id,source_type_code,source_id,completed_at
      FROM trace.lot WHERE lot_id=${BigInt(lotId)} FOR UPDATE`;
  return rows[0] ?? null;
}

async function assertTerminalGate(
  db: Pick<Prisma.TransactionClient, 'work_order' | 'terminal_process'>,
  workOrderId: bigint,
  terminalId: bigint | null,
): Promise<void> {
  if (terminalId === null) throw denied();
  const workOrder = await db.work_order.findUnique({
    where: { work_order_id: workOrderId },
    select: { routing_operation: { select: { process_id: true } } },
  });
  if (workOrder === null)
    throw one(
      field(
        'lotId',
        ERROR_CODE.INVALID,
        '생산 LOT의 작업지시를 찾을 수 없습니다.',
      ),
    );
  const gate = await db.terminal_process.findUnique({
    where: {
      terminal_id_process_id: {
        terminal_id: terminalId,
        process_id: workOrder.routing_operation.process_id,
      },
    },
    select: { can_print_label: true },
  });
  if (gate?.can_print_label !== true) throw denied();
}

function denied(): ContractException {
  return new ContractException(HttpStatus.FORBIDDEN, [
    {
      scope: 'screen',
      code: ERROR_CODE.PERMISSION_DENIED,
      message: '이 단말은 해당 생산 공정의 라벨을 출력할 수 없습니다.',
    },
  ]);
}

function isSerialNumberDuplicate(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2002') {
    return String(error.meta?.target ?? '').includes('serial_no');
  }
  return (
    error.code === 'P2010' &&
    String(error.meta?.code ?? '') === '23505' &&
    String(error.meta?.message ?? '').includes('serial_no')
  );
}

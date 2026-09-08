import { HttpStatus, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { IdempotencyContext, IdempotencyService } from "../common/idempotency";
import {
  ConflictException,
  ContractException,
  ERROR_CODE,
  field,
} from "../common/errors";
import { NumberingService } from "../core/numbering";
import { PrismaService } from "../prisma/prisma.service";

const NUMBER_RETRY = 3;

class NumberPreparationRequired extends Error {}

interface NumberedWrite<T> {
  context: IdempotencyContext;
  documentTypeCode: string;
  equipmentId: number;
  periodDate: () => string;
  numberField: string;
  numberColumn: string;
  work: (tx: Prisma.TransactionClient, documentNo: string) => Promise<T>;
}

/** 결정 — 통보 096·098: 번호는 업무 tx 전에 준비하고 업무와 멱등 기록만 원자화한다. */
@Injectable()
export class NumberedMaintenanceWrite {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly numbering: NumberingService,
  ) {}

  async run<T>(input: NumberedWrite<T>): Promise<T> {
    let prepared = (await this.hasRecord(input.context.key))
      ? undefined
      : await this.prepare(input);
    let retries = 0;

    for (;;) {
      try {
        const outcome = await this.idempotency.run(
          input.context,
          async (tx) => {
            if (prepared === undefined) throw new NumberPreparationRequired();
            const equipment = await tx.equipment.findUnique({
              where: { equipment_id: BigInt(input.equipmentId) },
              select: { plant_id: true },
            });
            if (equipment === null) throw invalidEquipment();
            if (equipment.plant_id !== prepared.plantId) {
              throw new ConflictException(
                "user",
                "번호 준비 뒤 설비의 공장이 바뀌었습니다. 다시 시도해 주세요.",
              );
            }
            return input.work(tx, prepared.documentNo);
          },
        );
        return outcome.body;
      } catch (error) {
        if (error instanceof NumberPreparationRequired) {
          prepared = await this.prepare(input);
          continue;
        }
        if (!isNumberDuplicate(error, input.numberColumn)) throw error;
        if (retries >= NUMBER_RETRY) {
          throw new ContractException(HttpStatus.BAD_REQUEST, [
            field(
              input.numberField,
              ERROR_CODE.UNIQUE_VIOLATION,
              "문서 번호를 매기지 못했습니다. 다시 시도해 주세요.",
            ),
          ]);
        }
        retries += 1;
        prepared = await this.prepare(input);
      }
    }
  }

  private async hasRecord(key: string): Promise<boolean> {
    return (
      (await this.prisma.idempotency_record.count({
        where: { idempotency_key: key },
      })) > 0
    );
  }

  private async prepare<T>(input: NumberedWrite<T>) {
    const equipment = await this.prisma.equipment.findUnique({
      where: { equipment_id: BigInt(input.equipmentId) },
      select: { plant_id: true },
    });
    if (equipment === null) throw invalidEquipment();
    return {
      plantId: equipment.plant_id,
      documentNo: await this.numbering.next(
        input.documentTypeCode,
        equipment.plant_id,
        input.periodDate(),
      ),
    };
  }
}

function invalidEquipment(): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [
    field("equipmentId", ERROR_CODE.INVALID, "없는 설비입니다."),
  ]);
}

function isNumberDuplicate(error: unknown, column: string): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }
  const target = (error.meta ?? {}).target;
  return (
    Array.isArray(target) && target.some((value) => String(value) === column)
  );
}

import { HttpStatus, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import {
  ConflictException,
  ContractException,
  ERROR_CODE,
  ErrorItem,
  field,
} from "../../common/errors";
import { readCollectionChannelWithin } from "./collection-channel-query.service";
import { CollectionChannelView, collectionChannelView } from "./collection-channel-view";
import { CollectionChannelWriteContext } from "./collection-channel-write-context";
import {
  CheckedCollectionChannelCreate,
  CollectionChannelCreate,
  checkCollectionChannelCreate,
} from "./collection-channel-write-input";

@Injectable()
export class CollectionChannelCreateService {
  async createWithin(
    tx: Prisma.TransactionClient,
    input: CollectionChannelCreate,
    context: CollectionChannelWriteContext,
  ): Promise<CollectionChannelView> {
    const checked = checkCollectionChannelCreate(input);
    const uomId = await assertReferences(tx, checked);
    await assertNotDuplicate(tx, checked);

    let created: { collection_channel_id: bigint };
    try {
      created = await tx.collection_channel.create({
        data: {
          equipment_id: checked.equipmentId,
          channel_key: checked.channelKey,
          signal_name: checked.signalName,
          uom_id: uomId,
          inspection_item_id: checked.inspectionItemId,
          item_id: checked.itemId,
          process_id: checked.processId,
          created_by: BigInt(context.appUserId),
          updated_by: BigInt(context.appUserId),
        },
        select: { collection_channel_id: true },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateConflict(checked.channelKey);
      throw error;
    }

    const row = await readCollectionChannelWithin(tx, created.collection_channel_id);
    if (row === null) throw new Error("Created collection channel is missing");
    return collectionChannelView(row);
  }
}

async function assertReferences(
  tx: Prisma.TransactionClient,
  input: CheckedCollectionChannelCreate,
): Promise<bigint | null> {
  const [equipment, uom, inspectionItem, item, process] = await Promise.all([
    tx.equipment.findUnique({
      where: { equipment_id: input.equipmentId },
      select: { equipment_id: true },
    }),
    input.unitCode === null
      ? null
      : tx.uom.findUnique({ where: { uom_code: input.unitCode }, select: { uom_id: true } }),
    input.inspectionItemId === null
      ? null
      : tx.inspection_item_spec.findUnique({
          where: { inspection_item_spec_id: input.inspectionItemId },
          select: { inspection_item_spec_id: true },
        }),
    input.itemId === null
      ? null
      : tx.item.findUnique({ where: { item_id: input.itemId }, select: { item_id: true } }),
    input.processId === null
      ? null
      : tx.process.findUnique({ where: { process_id: input.processId }, select: { process_id: true } }),
  ]);
  const errors: ErrorItem[] = [];
  if (!equipment) errors.push(invalid("equipmentId", "없는 설비입니다."));
  if (input.unitCode !== null && !uom) errors.push(invalid("unitCode", "없는 단위입니다."));
  if (input.inspectionItemId !== null && !inspectionItem) {
    errors.push(invalid("inspectionItemId", "없는 품질 검사 항목입니다."));
  }
  if (input.itemId !== null && !item) errors.push(invalid("itemId", "없는 품목입니다."));
  if (input.processId !== null && !process) errors.push(invalid("processId", "없는 공정입니다."));
  if (errors.length) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  return uom?.uom_id ?? null;
}

async function assertNotDuplicate(
  tx: Prisma.TransactionClient,
  input: CheckedCollectionChannelCreate,
): Promise<void> {
  const duplicate = await tx.collection_channel.findFirst({
    where: {
      equipment_id: input.equipmentId,
      channel_key: input.channelKey,
      item_id: input.itemId,
      process_id: input.processId,
    },
    select: { collection_channel_id: true },
  });
  if (duplicate) throw duplicateConflict(input.channelKey);
}

function invalid(name: string, message: string): ErrorItem {
  return field(name, ERROR_CODE.INVALID, message);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function duplicateConflict(channelKey: string): ConflictException {
  return new ConflictException(
    "user",
    `이 설비의 ${channelKey} 채널에 품목·공정 조건이 같은 매핑이 이미 있습니다.`,
  );
}

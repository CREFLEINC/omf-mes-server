import { HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import {
  ConflictException,
  ContractException,
  ERROR_CODE,
  ErrorItem,
  field,
  one,
} from "../../common/errors";
import { assertUpdated } from "../../common/optimistic-lock";
import { readCollectionChannelWithin } from "./collection-channel-query.service";
import { CollectionChannelView, collectionChannelView } from "./collection-channel-view";
import { CollectionChannelWriteContext } from "./collection-channel-write-context";
import {
  CheckedCollectionChannelUpdate,
  CollectionChannelUpdate,
  checkCollectionChannelUpdate,
} from "./collection-channel-write-input";

interface LockedChannel {
  collection_channel_id: bigint;
  equipment_id: bigint;
  channel_key: string | null;
  uom_id: bigint | null;
  inspection_item_id: bigint | null;
  item_id: bigint | null;
  process_id: bigint | null;
  version_no: number;
}

@Injectable()
export class CollectionChannelUpdateService {
  async updateWithin(
    tx: Prisma.TransactionClient,
    collectionChannelId: number,
    version: number,
    input: CollectionChannelUpdate,
    context: CollectionChannelWriteContext,
  ): Promise<CollectionChannelView> {
    if (!Number.isSafeInteger(collectionChannelId)) {
      throw one(field("collectionChannelId", ERROR_CODE.RANGE, "식별자 범위가 너무 큽니다."));
    }
    const checked = checkCollectionChannelUpdate(input);
    const locked = await lockChannel(tx, BigInt(collectionChannelId));
    if (locked.channel_key === null) throw new Error("Missing required collection channel key");
    assertUpdated(locked.version_no === version ? 1 : 0, "user");
    const references = await resolveReferences(tx, checked);
    const itemId = checked.itemId === undefined ? locked.item_id : checked.itemId;
    const processId = checked.processId === undefined ? locked.process_id : checked.processId;
    await assertNotDuplicate(tx, locked, itemId, processId);

    const data: Prisma.collection_channelUncheckedUpdateManyInput = {
      updated_by: BigInt(context.appUserId),
      version_no: { increment: 1 },
    };
    if (checked.signalName !== undefined) data.signal_name = checked.signalName;
    if (references.uomId !== undefined) data.uom_id = references.uomId;
    if (checked.inspectionItemId !== undefined) {
      data.inspection_item_id = checked.inspectionItemId;
    }
    if (checked.itemId !== undefined) data.item_id = checked.itemId;
    if (checked.processId !== undefined) data.process_id = checked.processId;
    if (checked.isActive !== undefined) data.is_active = checked.isActive;

    let affected: number;
    try {
      const result = await tx.collection_channel.updateMany({
        where: {
          collection_channel_id: locked.collection_channel_id,
          version_no: version,
        },
        data,
      });
      affected = result.count;
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateConflict(locked.channel_key);
      throw error;
    }
    assertUpdated(affected, "user");
    const row = await readCollectionChannelWithin(tx, locked.collection_channel_id);
    if (row === null) throw new Error("Updated collection channel is missing");
    return collectionChannelView(row);
  }
}

async function lockChannel(
  tx: Prisma.TransactionClient,
  collectionChannelId: bigint,
): Promise<LockedChannel> {
  const rows = await tx.$queryRaw<LockedChannel[]>(Prisma.sql`
    SELECT collection_channel_id,equipment_id,channel_key,uom_id,inspection_item_id,
           item_id,process_id,version_no
    FROM maintenance.collection_channel
    WHERE collection_channel_id=${collectionChannelId} FOR UPDATE`);
  if (!rows[0]) throw new NotFoundException("없는 수집 채널입니다.");
  return rows[0];
}

async function resolveReferences(
  tx: Prisma.TransactionClient,
  input: CheckedCollectionChannelUpdate,
): Promise<{ uomId?: bigint }> {
  const [uom, inspectionItem, item, process] = await Promise.all([
    input.unitCode === undefined
      ? undefined
      : tx.uom.findUnique({ where: { uom_code: input.unitCode }, select: { uom_id: true } }),
    input.inspectionItemId == null
      ? undefined
      : tx.inspection_item_spec.findUnique({
          where: { inspection_item_spec_id: input.inspectionItemId },
          select: { inspection_item_spec_id: true },
        }),
    input.itemId == null
      ? undefined
      : tx.item.findUnique({ where: { item_id: input.itemId }, select: { item_id: true } }),
    input.processId == null
      ? undefined
      : tx.process.findUnique({ where: { process_id: input.processId }, select: { process_id: true } }),
  ]);
  const errors: ErrorItem[] = [];
  if (input.unitCode !== undefined && !uom) errors.push(invalid("unitCode", "없는 단위입니다."));
  if (input.inspectionItemId !== undefined && input.inspectionItemId !== null && !inspectionItem) {
    errors.push(invalid("inspectionItemId", "없는 품질 검사 항목입니다."));
  }
  if (input.itemId !== undefined && input.itemId !== null && !item) {
    errors.push(invalid("itemId", "없는 품목입니다."));
  }
  if (input.processId !== undefined && input.processId !== null && !process) {
    errors.push(invalid("processId", "없는 공정입니다."));
  }
  if (errors.length) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  return input.unitCode === undefined ? {} : { uomId: uom?.uom_id };
}

async function assertNotDuplicate(
  tx: Prisma.TransactionClient,
  locked: LockedChannel,
  itemId: bigint | null,
  processId: bigint | null,
): Promise<void> {
  const duplicate = await tx.collection_channel.findFirst({
    where: {
      equipment_id: locked.equipment_id,
      channel_key: locked.channel_key,
      item_id: itemId,
      process_id: processId,
      collection_channel_id: { not: locked.collection_channel_id },
    },
    select: { collection_channel_id: true },
  });
  if (duplicate) throw duplicateConflict(locked.channel_key as string);
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

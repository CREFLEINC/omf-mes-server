import { HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { ContractException, ERROR_CODE, field } from "../../common/errors";
import { PagedResponse, pageRequest, pagedResponse } from "../../common/pagination";
import { PrismaService } from "../../prisma/prisma.service";
import {
  CollectionChannelProjection,
  CollectionChannelView,
  collectionChannelView,
} from "./collection-channel-view";

export interface CollectionChannelQuery {
  equipmentId?: number;
  isActive?: boolean;
  page?: number;
  size?: number;
}

export type CollectionChannelList = PagedResponse<CollectionChannelView> & { totalCount: number };
type CollectionChannelId = { collection_channel_id: bigint };
type MissingKey = { has_missing_key: boolean | null };

const COLLECTION_CHANNEL_FROM = Prisma.sql`
  FROM maintenance.collection_channel c
  JOIN mdm.equipment e ON e.equipment_id = c.equipment_id`;

@Injectable()
export class CollectionChannelQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: CollectionChannelQuery): Promise<CollectionChannelList> {
    const page = pageRequest(query);
    if (!Number.isSafeInteger(page.skip)) throw rangeError("page", "페이지 범위가 너무 큽니다.");
    if (query.equipmentId !== undefined && !Number.isSafeInteger(query.equipmentId)) {
      throw rangeError("equipmentId", "설비 식별자 범위가 너무 큽니다.");
    }

    return this.prisma.$transaction(
      async (tx) => {
        const conditions = [Prisma.sql`TRUE`];
        if (query.equipmentId !== undefined) {
          conditions.push(Prisma.sql`c.equipment_id = ${query.equipmentId}`);
        }
        const missing = await tx.$queryRaw<MissingKey[]>(Prisma.sql`
          SELECT bool_or(c.channel_key IS NULL) AS has_missing_key
          ${COLLECTION_CHANNEL_FROM}
          WHERE ${Prisma.join(conditions, " AND ")}`);
        if (missing[0]?.has_missing_key) {
          throw new Error("Missing required collection channel key");
        }
        if (query.isActive !== undefined) {
          conditions.push(Prisma.sql`c.is_active = ${query.isActive}`);
        }
        const where = Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`;
        const [ids, counts] = await Promise.all([
          tx.$queryRaw<CollectionChannelId[]>(Prisma.sql`
            SELECT c.collection_channel_id ${COLLECTION_CHANNEL_FROM} ${where}
            ORDER BY c.equipment_id ASC, c.channel_key ASC NULLS LAST,
                     c.collection_channel_id ASC
            LIMIT ${page.take} OFFSET ${page.skip}`),
          tx.$queryRaw<{ total: bigint }[]>(Prisma.sql`
            SELECT count(*) AS total ${COLLECTION_CHANNEL_FROM} ${where}`),
        ]);
        const orderedIds = ids.map((row) => row.collection_channel_id);
        const rows =
          orderedIds.length === 0
            ? []
            : await project(
                tx,
                Prisma.sql`c.collection_channel_id IN (${Prisma.join(orderedIds)})`,
              );
        const byId = new Map(rows.map((row) => [row.collection_channel_id, row]));
        const items = orderedIds.map((id) => {
          const row = byId.get(id);
          if (!row) throw new Error("Collection channel disappeared from read snapshot");
          return collectionChannelView(row);
        });
        const total = Number(counts[0].total);
        if (!Number.isSafeInteger(total)) {
          throw new Error("Collection channel count exceeds safe range");
        }
        return { ...pagedResponse(items, total, page), totalCount: total };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async get(
    collectionChannelId: number,
  ): Promise<{ view: CollectionChannelView; versionNo: number }> {
    if (!Number.isSafeInteger(collectionChannelId)) {
      throw rangeError("collectionChannelId", "수집 채널 식별자 범위가 너무 큽니다.");
    }
    const rows = await project(
      this.prisma,
      Prisma.sql`c.collection_channel_id = ${BigInt(collectionChannelId)}`,
    );
    if (rows.length === 0) throw new NotFoundException("없는 수집 채널입니다.");
    return { view: collectionChannelView(rows[0]), versionNo: rows[0].version_no };
  }
}

type ProjectionClient = Pick<PrismaService, "$queryRaw"> | Prisma.TransactionClient;

function project(
  client: ProjectionClient,
  condition: Prisma.Sql,
): Promise<CollectionChannelProjection[]> {
  return client.$queryRaw<CollectionChannelProjection[]>(Prisma.sql`
    SELECT c.collection_channel_id, c.equipment_id, e.equipment_code,
           c.channel_key, c.signal_name, c.uom_id, received_uom.uom_code AS unit_code,
           c.inspection_item_id, c.item_id, i.item_code, c.process_id, p.process_code,
           spec.inspection_item_name, spec.inspection_item_code,
           stored_uom.uom_code AS inspection_item_unit_code,
           version.inspection_plan_version_id,
           version.plan_version AS inspection_plan_version,
           CASE WHEN c.inspection_item_id IS NULL THEN NULL
             ELSE version.plan_version = latest.latest_version END
             AS inspection_item_is_current_revision,
           c.is_active, c.version_no
    FROM maintenance.collection_channel c
    JOIN mdm.equipment e ON e.equipment_id = c.equipment_id
    LEFT JOIN mdm.uom received_uom ON received_uom.uom_id = c.uom_id
    LEFT JOIN mdm.item i ON i.item_id = c.item_id
    LEFT JOIN mdm.process p ON p.process_id = c.process_id
    LEFT JOIN quality.inspection_item_spec spec
      ON spec.inspection_item_spec_id = c.inspection_item_id
    LEFT JOIN mdm.uom stored_uom ON stored_uom.uom_id = spec.uom_id
    LEFT JOIN quality.inspection_plan_version version
      ON version.inspection_plan_version_id = spec.inspection_plan_version_id
    LEFT JOIN (
      SELECT inspection_plan_id, max(plan_version) AS latest_version
      FROM quality.inspection_plan_version
      GROUP BY inspection_plan_id
    ) latest ON latest.inspection_plan_id = version.inspection_plan_id
    WHERE ${condition}`);
}

function rangeError(name: string, message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [field(name, ERROR_CODE.RANGE, message)]);
}

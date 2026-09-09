import { HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { ContractException, ERROR_CODE, field } from "../../common/errors";
import { PrismaService } from "../../prisma/prisma.service";
import {
  CollectionChannelProjection,
  CollectionChannelView,
  collectionChannelView,
} from "./collection-channel-view";

@Injectable()
export class CollectionChannelQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async get(
    collectionChannelId: number,
  ): Promise<{ view: CollectionChannelView; versionNo: number }> {
    if (!Number.isSafeInteger(collectionChannelId)) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field("collectionChannelId", ERROR_CODE.RANGE, "수집 채널 식별자 범위가 너무 큽니다."),
      ]);
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

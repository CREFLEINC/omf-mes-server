import { Prisma } from "@prisma/client";

import { ERROR_CODE, field, one } from "../../common/errors";
import { assertUpdated } from "../../common/optimistic-lock";
import { CheckedMaintenanceResultCreate } from "./result-write-input";

type Tx = Prisma.TransactionClient;

interface TargetRow {
  target_id: bigint;
  plant_id: bigint;
  version_no: number;
}

interface OrderRow {
  maintenance_order_id: bigint;
  target_type_code: string;
  equipment_id: bigint | null;
  mold_id: bigint | null;
  breakdown_id: bigint | null;
  order_type_code: string;
  status_code: string;
}

/** 대상 → 지시 → 종류별 ID 오름차순 참조 잠금 뒤 현재 유효성을 확정한다. */
export async function resolveMaintenanceResultCreateReferences(
  tx: Tx,
  input: CheckedMaintenanceResultCreate,
  ifMatch: number | undefined,
): Promise<void> {
  const target = await lockTarget(tx, input);
  if (ifMatch !== undefined) {
    if (input.targetTypeCode === "EQUIPMENT")
      fail(
        "If-Match",
        ERROR_CODE.INVALID,
        "설비 실적에는 대상 ETag를 사용할 수 없습니다.",
      );
    assertUpdated(target.version_no === ifMatch ? 1 : 0, "user");
  }
  const order = await lockOrder(tx, input);
  await assertBreakdown(tx, input, order);
  await assertPerformer(tx, input);
  await assertLines(tx, input, order);
  await assertParts(tx, input, target);
}

async function lockTarget(
  tx: Tx,
  input: CheckedMaintenanceResultCreate,
): Promise<TargetRow> {
  const rows =
    input.targetTypeCode === "EQUIPMENT"
      ? await tx.$queryRaw<TargetRow[]>(Prisma.sql`
          SELECT equipment_id AS target_id,plant_id,version_no
          FROM mdm.equipment WHERE equipment_id=${input.targetId}
          FOR NO KEY UPDATE`)
      : await tx.$queryRaw<TargetRow[]>(Prisma.sql`
          SELECT mold_id AS target_id,plant_id,version_no
          FROM mdm.mold WHERE mold_id=${input.targetId}
          FOR NO KEY UPDATE`);
  if (!rows[0]) fail("targetId", ERROR_CODE.INVALID, "없는 보전 대상입니다.");
  return rows[0];
}

async function lockOrder(
  tx: Tx,
  input: CheckedMaintenanceResultCreate,
): Promise<OrderRow | null> {
  if (input.maintenanceOrderId === null) {
    if (input.targetTypeCode === "MOLD")
      fail(
        "maintenanceOrderId",
        ERROR_CODE.REQUIRED,
        "금형 실적에는 예방보전 지시가 필요합니다.",
      );
    if (input.breakdownId === null)
      fail(
        "breakdownId",
        ERROR_CODE.REQUIRED,
        "지시 없는 설비 실적에는 고장 기록이 필요합니다.",
      );
    return null;
  }
  const rows = await tx.$queryRaw<OrderRow[]>(Prisma.sql`
    SELECT maintenance_order_id,target_type_code,equipment_id,mold_id,
           breakdown_id,order_type_code,status_code
    FROM maintenance.maintenance_order
    WHERE maintenance_order_id=${input.maintenanceOrderId} FOR UPDATE`);
  const row = rows[0];
  if (!row)
    fail("maintenanceOrderId", ERROR_CODE.INVALID, "없는 보전 지시입니다.");
  const targetId =
    input.targetTypeCode === "EQUIPMENT" ? row.equipment_id : row.mold_id;
  if (
    row.target_type_code !== input.targetTypeCode ||
    targetId !== input.targetId
  )
    fail(
      "maintenanceOrderId",
      ERROR_CODE.INVALID,
      "선택 대상의 보전 지시가 아닙니다.",
    );
  if (row.status_code !== "ISSUED")
    fail(
      "maintenanceOrderId",
      ERROR_CODE.STATE_LOCKED,
      "발행 상태의 보전 지시에만 실적을 등록할 수 있습니다.",
    );
  if (input.targetTypeCode === "MOLD" && row.order_type_code !== "PREVENTIVE")
    fail(
      "maintenanceOrderId",
      ERROR_CODE.INVALID,
      "금형 실적에는 예방보전 지시가 필요합니다.",
    );
  return row;
}

async function assertBreakdown(
  tx: Tx,
  input: CheckedMaintenanceResultCreate,
  order: OrderRow | null,
): Promise<void> {
  if (input.targetTypeCode === "MOLD" && input.breakdownId !== null)
    fail(
      "breakdownId",
      ERROR_CODE.INVALID,
      "금형 실적에는 설비 고장을 연결할 수 없습니다.",
    );
  if (input.breakdownId === null) return;
  const rows = await tx.$queryRaw<
    { breakdown_id: bigint; equipment_id: bigint }[]
  >(Prisma.sql`
    SELECT breakdown_id,equipment_id FROM maintenance.breakdown
    WHERE breakdown_id=${input.breakdownId} FOR SHARE`);
  if (!rows[0] || rows[0].equipment_id !== input.targetId)
    fail(
      "breakdownId",
      ERROR_CODE.INVALID,
      "선택 설비의 고장 기록이 아닙니다.",
    );
  if (order && order.breakdown_id !== input.breakdownId) {
    const linked = await tx.maintenance_order_trigger.count({
      where: {
        maintenance_order_id: order.maintenance_order_id,
        trigger_type_code: "BREAKDOWN",
        source_id: input.breakdownId,
      },
    });
    if (!linked)
      fail(
        "breakdownId",
        ERROR_CODE.INVALID,
        "보전 지시의 촉발 고장이 아닙니다.",
      );
  }
}

async function assertPerformer(
  tx: Tx,
  input: CheckedMaintenanceResultCreate,
): Promise<void> {
  if (input.performedByUserId === null) return;
  const rows = await tx.$queryRaw<{ app_user_id: bigint }[]>(Prisma.sql`
    SELECT app_user_id FROM app.app_user
    WHERE app_user_id=${input.performedByUserId} AND is_active FOR SHARE`);
  if (!rows[0])
    fail("performedByUserId", ERROR_CODE.INVALID, "없는 사용 중 계정입니다.");
}

async function assertLines(
  tx: Tx,
  input: CheckedMaintenanceResultCreate,
  order: OrderRow | null,
): Promise<void> {
  if (input.targetTypeCode === "MOLD") {
    input.lines.forEach((line, index) => {
      if (line.orderItemId !== null)
        fail(
          `lines[${index}].orderItemId`,
          ERROR_CODE.INVALID,
          "금형 실적은 지시 항목 ID를 사용하지 않습니다.",
        );
      if (!line.partName?.trim())
        fail(
          `lines[${index}].partName`,
          ERROR_CODE.REQUIRED,
          "금형 보전 부위가 필요합니다.",
        );
    });
  } else if (!order) {
    input.lines.forEach((line, index) => {
      if (line.orderItemId !== null)
        fail(
          `lines[${index}].orderItemId`,
          ERROR_CODE.INVALID,
          "지시 없는 실적은 지시 항목을 연결할 수 없습니다.",
        );
    });
  } else {
    input.lines.forEach((line, index) => {
      if (line.orderItemId === null)
        fail(
          `lines[${index}].orderItemId`,
          ERROR_CODE.REQUIRED,
          "설비 지시 항목 ID가 필요합니다.",
        );
    });
    const ids = input.lines
      .map((line) => line.orderItemId as bigint)
      .sort(bigintOrder);
    if (ids.length) {
      const rows = await tx.$queryRaw<
        { maintenance_order_item_id: bigint }[]
      >(Prisma.sql`
        SELECT maintenance_order_item_id
        FROM maintenance.maintenance_order_item
        WHERE maintenance_order_item_id IN (${Prisma.join(ids)})
          AND maintenance_order_id=${order.maintenance_order_id}
        ORDER BY maintenance_order_item_id FOR SHARE`);
      if (rows.length !== ids.length)
        fail(
          "lines",
          ERROR_CODE.INVALID,
          "보전 지시에 속하지 않은 항목이 있습니다.",
        );
    }
  }
  const codes = [...new Set(input.lines.map((line) => line.resultCode))].sort();
  if (!codes.length) return;
  const found = await tx.$queryRaw<{ code: string }[]>(Prisma.sql`
    SELECT cv.code FROM mdm.code_value cv JOIN mdm.code_group cg
      ON cg.code_group_id=cv.code_group_id
    WHERE cg.group_code='MAINTENANCE_RESULT_LINE_RESULT'
      AND cv.is_active AND cv.code IN (${Prisma.join(codes)})
    ORDER BY cv.code FOR SHARE OF cv`);
  if (found.length !== codes.length)
    fail(
      "lines",
      ERROR_CODE.INVALID,
      "사용할 수 없는 보전 결과코드가 있습니다.",
    );
}

async function assertParts(
  tx: Tx,
  input: CheckedMaintenanceResultCreate,
  target: TargetRow,
): Promise<void> {
  const ids = [...new Set(input.parts.map((part) => part.sparePartId))].sort(
    bigintOrder,
  );
  if (ids.length) {
    const rows = await tx.$queryRaw<
      { spare_part_id: bigint; plant_id: bigint; is_active: boolean }[]
    >(Prisma.sql`
      SELECT spare_part_id,plant_id,is_active FROM mdm.spare_part
      WHERE spare_part_id IN (${Prisma.join(ids)})
      ORDER BY spare_part_id FOR SHARE`);
    if (
      rows.length !== ids.length ||
      rows.some((row) => !row.is_active || row.plant_id !== target.plant_id)
    )
      fail(
        "parts",
        ERROR_CODE.INVALID,
        "같은 공장의 사용 가능한 예비품만 연결할 수 있습니다.",
      );
    if (input.targetTypeCode === "EQUIPMENT") {
      const mappings = await tx.spare_part_equipment.findMany({
        where: {
          equipment_id: input.targetId,
          spare_part_id: { in: ids },
        },
        select: { spare_part_id: true },
      });
      if (new Set(mappings.map((row) => row.spare_part_id)).size !== ids.length)
        fail(
          "parts",
          ERROR_CODE.INVALID,
          "설비에 매핑된 예비품만 연결할 수 있습니다.",
        );
    }
  }

  const issueIds = [
    ...new Set(
      input.parts.flatMap((part) =>
        part.goodsIssueId === null ? [] : [part.goodsIssueId],
      ),
    ),
  ].sort(bigintOrder);
  if (!issueIds.length) return;
  const issues = await tx.$queryRaw<
    { goods_issue_id: bigint; plant_id: bigint; status_code: string }[]
  >(Prisma.sql`
    SELECT gi.goods_issue_id,w.plant_id,gi.status_code
    FROM logistics.goods_issue gi
    JOIN mdm.warehouse w ON w.warehouse_id=gi.source_warehouse_id
    WHERE gi.goods_issue_id IN (${Prisma.join(issueIds)})
    ORDER BY gi.goods_issue_id FOR SHARE OF gi,w`);
  if (
    issues.length !== issueIds.length ||
    issues.some(
      (row) => row.plant_id !== target.plant_id || row.status_code !== "POSTED",
    )
  )
    fail(
      "parts",
      ERROR_CODE.INVALID,
      "같은 공장에서 출고 완료된 예비품 출고만 연결할 수 있습니다.",
    );
  const pairs = input.parts.flatMap((part) =>
    part.goodsIssueId === null
      ? []
      : [
          {
            goods_issue_id: part.goodsIssueId,
            spare_part_id: part.sparePartId,
          },
        ],
  );
  const links = await tx.goods_issue_spare_line.findMany({
    where: { OR: pairs },
    select: { goods_issue_id: true, spare_part_id: true },
  });
  const keys = new Set(
    links.map((row) => `${row.goods_issue_id}:${row.spare_part_id}`),
  );
  if (
    pairs.some(
      (pair) => !keys.has(`${pair.goods_issue_id}:${pair.spare_part_id}`),
    )
  )
    fail(
      "parts",
      ERROR_CODE.INVALID,
      "선택 출고에 포함되지 않은 예비품이 있습니다.",
    );
}

function fail(name: string, code: string, message: string): never {
  throw one(field(name, code, message));
}

function bigintOrder(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

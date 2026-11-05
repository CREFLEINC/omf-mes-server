/**
 * 생산 창고 보충(피처 004) e2e 공용 — 003 준비(`MaterialIssueFixture`) 위에 W-02-12 만 가진 사용자, 직접 요청·피킹·출고
 * 도우미, 정리를 더한다.
 */
import { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { SESSION_COOKIE } from "../../src/auth/session-cookie";
import { PrismaService } from "../../src/prisma/prisma.service";
import { ItemKey, MaterialIssueFixture } from "./material-issue-fixture";

export type Place = { warehouseId: bigint; locationId: bigint };

export class ReplenishmentFixture extends MaterialIssueFixture {
  /** W-02-12 만 가진 역할(FR-037). 상속한 `cookie` 의 역할에는 W-02-12 가 없다. */
  replenishmentCookie = "";

  constructor(
    private readonly nest: INestApplication,
    private readonly db: PrismaService,
    prefix: string,
  ) {
    super(nest, db, prefix);
  }

  async setup(): Promise<void> {
    await super.setup();
    const user = await this.db.app_user.create({
      data: {
        login_id: `${this.prefix}-U12`,
        user_name: "보충",
        status_code: "EMPLOYED",
      },
    });
    const role = await this.db.role.create({
      data: { role_code: `${this.prefix}-R12`, role_name: "보충" },
    });
    await this.db.role_permission.create({
      data: { role_id: role.role_id, permission_code: "W-02-12" },
    });
    await this.db.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    this.ids.replenishmentUser = user.app_user_id;
    // 출고 확정은 모바일 피킹·출고(M-01-08) 몫이다 — 상속한 사용자의 역할에 더한다.
    const base = await this.db.role.findUniqueOrThrow({ where: { role_code: `${this.prefix}-R` } });
    await this.db.role_permission.create({ data: { role_id: base.role_id, permission_code: 'M-01-08' } });
    this.replenishmentCookie = `${SESSION_COOKIE}=${this.nest.get(JwtService).sign({ sub: Number(user.app_user_id), typ: "session" })}`;
  }

  /** 사람이 만든 위치가 없는 창고(나뉘지 않음) — 트리거가 시스템 위치 둘만 만든다. */
  async undividedWarehouse(plantId: bigint, code: string): Promise<bigint> {
    const wh = await this.db.warehouse.create({
      data: {
        plant_id: plantId,
        business_unit_id: this.ids.unit,
        warehouse_code: `${this.prefix}-${code}`,
        warehouse_name: code,
        warehouse_type_code: "GENERAL",
        management_level_code: "WAREHOUSE",
      },
    });
    return wh.warehouse_id;
  }

  async systemLocation(
    warehouseId: bigint,
    role: "PUTAWAY_STAGING" | "WAREHOUSE_WHOLE",
  ): Promise<bigint> {
    return (
      await this.db.location.findFirstOrThrow({
        where: { warehouse_id: warehouseId, system_role_code: role },
      })
    ).location_id;
  }

  create(
    body: {
      productionWarehouseId: bigint;
      lines: { item: ItemKey; qty: number; source?: bigint }[];
      remarks?: string;
    },
    cookie = this.replenishmentCookie,
  ) {
    return request(this.nest.getHttpServer())
      .post("/api/logistics/replenishment-requests")
      .set("Cookie", cookie)
      .set("Idempotency-Key", randomUUID())
      .send({
        productionWarehouseId: Number(body.productionWarehouseId),
        businessDate: "2026-11-05",
        ...(body.remarks === undefined ? {} : { remarks: body.remarks }),
        lines: body.lines.map((l) => ({
          itemId: Number(this.items[l.item]),
          requestedQty: l.qty,
          ...(l.source === undefined
            ? {}
            : { sourceWarehouseId: Number(l.source) }),
        })),
      });
  }

  /** 출고 요청 목록(W-02-12 진행 보기와 같은 경로)의 행. */
  async list(
    query: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    const res = await request(this.nest.getHttpServer())
      .get("/api/logistics/material-issue-requests")
      .query({ size: 100, ...query })
      .set("Cookie", this.replenishmentCookie)
      .expect(200);
    return res.body.items;
  }

  /** `:pick` 이 하는 일을 표에 옮긴다 — 피킹 줄의 집은 양과 잔액의 picked 는 한 짝이다. */
  async pick(requestId: bigint, qty: number): Promise<void> {
    const [order] = (await this.pickings(requestId)).filter(
      (o) => o.status_code === "REGISTERED",
    );
    const line = order.picking_line[0];
    await this.db.picking_line.update({
      where: { picking_line_id: line.picking_line_id },
      data: { picked_qty: { increment: qty } },
    });
    await this.db.inventory_balance.updateMany({
      where: { lot_id: line.lot_id, location_id: line.location_id },
      data: { picked_qty: { increment: qty } },
    });
  }

  /** 집은 줄을 실제 출고 경로로 전기한다(모바일 M-01-08 과 같은 본문 — 도착지는 서버가 요청에서 푼다). */
  async issue(requestId: bigint, qty: number, status = 201): Promise<{ body: { goodsIssue: Record<string, unknown> } }> {
    const [order] = (await this.pickings(requestId)).filter(
      (o) => o.status_code === "REGISTERED",
    );
    const line = order.picking_line[0];
    return request(this.nest.getHttpServer())
      .post("/api/logistics/goods-issues")
      .set("Cookie", this.cookie)
      .set("Idempotency-Key", randomUUID())
      .send({
        issueTypeCode: "PRODUCTION",
        sourceDocumentTypeCode: "PICKING_ORDER",
        sourceDocumentId: Number(order.picking_order_id),
        sourceWarehouseId: Number(order.warehouse_id),
        issuedAt: new Date().toISOString(),
        postImmediately: true,
        businessDate: "2026-11-05",
        occurredAt: new Date().toISOString(),
        lines: [
          {
            pickingLineId: Number(line.picking_line_id),
            itemId: Number(line.item_id),
            lotId: Number(line.lot_id),
            issueQty: qty,
            uomId: Number(line.uom_id),
            sourceLocationId: Number(line.location_id),
          },
        ],
      })
      .expect(status);
  }

  async cleanup(): Promise<void> {
    const db = this.db;
    const warehouse = {
      warehouse: { warehouse_code: { startsWith: this.prefix } },
    };
    // ⛔ 원장은 트리거가 UPDATE·DELETE 를 막아 TRUNCATE 뿐이다 — 일꾼 DB 는 스위트마다 따로라 이 스위트의 행뿐이다
    //    (`logistics-picking-issue.e2e-spec.ts` 선례).
    await db.$executeRawUnsafe(
      "TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE",
    );
    await db.shopfloor_receipt_line.deleteMany({
      where: { shopfloor_receipt: { goods_issue: warehouse } },
    });
    await db.shopfloor_receipt.deleteMany({
      where: { goods_issue: warehouse },
    });
    await db.goods_issue_line.deleteMany({ where: { goods_issue: warehouse } });
    await db.goods_issue.deleteMany({ where: warehouse });
    const requests = await db.material_issue_request.findMany({
      where: {
        source_warehouse: { warehouse_code: { startsWith: this.prefix } },
      },
      select: { material_issue_request_id: true },
    });
    const ids = requests.map((r) => r.material_issue_request_id);
    const pickings = await db.picking_order.findMany({
      where: warehouse,
      select: { picking_order_id: true },
    });
    const events = await db.notification_event.findMany({
      where: {
        aggregate_type_code: "PICKING_ORDER",
        aggregate_id: { in: pickings.map((p) => p.picking_order_id) },
      },
      select: { notification_event_id: true },
    });
    const eventIds = events.map((e) => e.notification_event_id);
    await db.zalo_delivery.deleteMany({
      where: { notification_event_id: { in: eventIds } },
    });
    await db.notification.deleteMany({
      where: { notification_event_id: { in: eventIds } },
    });
    await db.notification_event.deleteMany({
      where: { notification_event_id: { in: eventIds } },
    });
    await db.audit_event.deleteMany({
      where: {
        target_type_code: "MATERIAL_ISSUE_REQUEST",
        target_id: { in: ids },
      },
    });
    await db.picking_line.deleteMany({ where: { picking_order: warehouse } });
    await db.picking_order.deleteMany({ where: warehouse });
    await db.material_issue_request_line.deleteMany({
      where: { material_issue_request_id: { in: ids } },
    });
    await db.material_issue_request.deleteMany({
      where: { material_issue_request_id: { in: ids } },
    });
    await db.replenishment_item.deleteMany({ where: warehouse });
    await super.cleanup();
  }
}

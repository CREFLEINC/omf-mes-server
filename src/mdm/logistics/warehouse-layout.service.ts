import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PrismaService } from '../../prisma/prisma.service';

/** 계약 `WarehouseLayoutMarker` — 좌표는 도면 «비율»이다(0~1). */
interface Marker {
  locationId: number;
  x: number;
  y: number;
}

/** 계약 `WarehouseLayout`. `versionNo` 는 ETag 로도 나가므로 본문에도 싣는다. */
export interface LayoutView {
  warehouseId: number;
  drawingAttachmentId?: number;
  markers: Marker[];
  versionNo: number;
}

export interface LayoutReplace {
  drawingAttachmentId?: number;
  markers: Marker[];
}

/**
 * `layout_data` jsonb 에 넣는 모양. 계약의 마커에 `x-source-column` 이 하나도 없다 —
 * 물리 컬럼이 없다는 뜻이고, 모델이 이 표에 jsonb 를 둔 이유가 그것이다.
 */
interface LayoutData {
  drawingAttachmentId?: number;
  markers: Marker[];
}

/**
 * ⛔ 배치도는 «창고»의 `version_no` 를 잠금 축으로 쓴다.
 *
 * `mdm.warehouse_layout` 에 자기 `version_no` 가 있는데도 그러는 이유 — 계약이
 * `PUT` 에 `If-Match` 를 «필수»로 걸었는데, **첫 저장 전에는 배치도 행이 없어** 화면이
 * 담을 값을 얻을 자리가 없다. 행이 없을 때 `1` 같은 값을 지어내면 첫 저장 뒤에도 ETag 가
 * 그대로라 「저장하면 새 ETag」가 깨지고, 같은 값으로 두 번 저장해 앞의 것을 덮는다.
 *
 * 창고 축이면 행이 있든 없든 값이 있고, 저장할 때마다 반드시 바뀐다. 작업자 자격
 * 컬렉션과 같은 판단이다(#115).
 *
 * 대가 — 배치도를 저장하면 창고 편집 폼의 ETag 도 낡는다. 같은 창고를 만지는 두 저장이
 * 서로를 막는 것이라 과하지 않다.
 */
const LAYOUT_VERSION = 1;

@Injectable()
export class WarehouseLayoutService {
  constructor(private readonly prisma: PrismaService) {}

  async get(warehouseId: number): Promise<LayoutView> {
    const versionNo = await this.warehouseVersion(warehouseId);
    const row = await this.prisma.warehouse_layout.findUnique({
      where: {
        warehouse_id_layout_version: {
          warehouse_id: warehouseId,
          layout_version: LAYOUT_VERSION,
        },
      },
    });

    // 「도면이 없으면 점만 온다」(계약). 행 자체가 없으면 빈 배치도다 — 404 가 아니다.
    // 이 자리의 404 는 «창고»가 없다는 뜻이다.
    const data = row === null ? { markers: [] } : (row.layout_data as unknown as LayoutData);
    return {
      warehouseId,
      ...(data.drawingAttachmentId === undefined
        ? {}
        : { drawingAttachmentId: data.drawingAttachmentId }),
      markers: data.markers ?? [],
      versionNo,
    };
  }

  async replace(
    warehouseId: number,
    version: number,
    input: LayoutReplace,
    appUserId?: number,
  ): Promise<LayoutView> {
    const errors = [
      ...(await this.drawingErrors(warehouseId, input.drawingAttachmentId)),
      ...(await this.markerErrors(warehouseId, input.markers)),
    ];
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    await this.prisma.$transaction(async (tx) => {
      const bumped = await tx.warehouse.updateMany({
        where: { warehouse_id: warehouseId, version_no: version },
        data: { version_no: { increment: 1 } },
      });
      if (bumped.count === 0) {
        const exists = await tx.warehouse.findUnique({
          where: { warehouse_id: warehouseId },
          select: { warehouse_id: true },
        });
        if (!exists) throw new NotFoundException('없는 창고입니다.');
        assertUpdated(0);
      }

      const layoutData: LayoutData = {
        ...(input.drawingAttachmentId === undefined
          ? {}
          : { drawingAttachmentId: input.drawingAttachmentId }),
        markers: input.markers,
      };
      await tx.warehouse_layout.upsert({
        where: {
          warehouse_id_layout_version: {
            warehouse_id: warehouseId,
            layout_version: LAYOUT_VERSION,
          },
        },
        create: {
          warehouse_id: warehouseId,
          layout_version: LAYOUT_VERSION,
          layout_data: layoutData as unknown as Prisma.InputJsonValue,
          ...(appUserId === undefined ? {} : { created_by: appUserId, updated_by: appUserId }),
        },
        update: {
          layout_data: layoutData as unknown as Prisma.InputJsonValue,
          version_no: { increment: 1 },
          ...(appUserId === undefined ? {} : { updated_by: appUserId }),
        },
      });
    });

    return this.get(warehouseId);
  }

  /**
   * 도면 id 도 jsonb 라 FK 가 없다(#652). 없는 첨부·다른 창고의 도면·공지 첨부를 찍으면 화면이
   * `GET /app/attachments/{id}/content` 로 엉뚱한 파일을 그리거나 못 그린다. 빼고 보내면 도면이 지워진다(통째 교체).
   */
  private async drawingErrors(warehouseId: number, drawingAttachmentId: number | undefined): Promise<ErrorItem[]> {
    if (drawingAttachmentId === undefined) return [];
    const drawing = Number.isSafeInteger(drawingAttachmentId) && drawingAttachmentId > 0
      ? await this.prisma.attachment.findUnique({
        where: { attachment_id: drawingAttachmentId },
        select: { target_type_code: true, target_id: true },
      })
      : null;
    if (!drawing) return [field('drawingAttachmentId', ERROR_CODE.INVALID, '없는 도면입니다.')];
    if (drawing.target_type_code !== 'WAREHOUSE' || drawing.target_id !== BigInt(warehouseId)) {
      return [field('drawingAttachmentId', ERROR_CODE.INVALID, '이 창고에 올린 도면이 아닙니다.')];
    }
    return [];
  }

  /**
   * 점이 가리키는 위치가 «이 창고»의 것인지 본다. jsonb 라 FK 가 없어 DB 는 아무것도
   * 막지 않는다 — 다른 창고의 위치를 찍으면 화면이 이름을 못 찾고 점만 떠 있게 된다.
   */
  private async markerErrors(warehouseId: number, markers: Marker[]): Promise<ErrorItem[]> {
    const errors: ErrorItem[] = [];
    const seen = new Map<number, number>();
    markers.forEach((marker, index) => {
      const first = seen.get(marker.locationId);
      if (first === undefined) {
        seen.set(marker.locationId, index);
        return;
      }
      errors.push({
        scope: 'field',
        field: `markers[${index}].locationId`,
        code: ERROR_CODE.UNIQUE_VIOLATION,
        uniqueScope: ['locationId'],
        message: `${first + 1}번째 점과 같은 위치입니다.`,
      });
    });

    if (seen.size > 0) {
      const owned = await this.prisma.location.findMany({
        where: { warehouse_id: warehouseId, location_id: { in: [...seen.keys()] } },
        select: { location_id: true },
      });
      const ownedIds = new Set(owned.map((row) => Number(row.location_id)));
      for (const [locationId, index] of seen) {
        if (ownedIds.has(locationId)) continue;
        errors.push({
          scope: 'field',
          field: `markers[${index}].locationId`,
          code: ERROR_CODE.INVALID,
          message: '이 창고의 위치가 아닙니다.',
        });
      }
    }

    return errors;
  }

  private async warehouseVersion(warehouseId: number): Promise<number> {
    const row = await this.prisma.warehouse.findUnique({
      where: { warehouse_id: warehouseId },
      select: { version_no: true },
    });
    if (!row) throw new NotFoundException('없는 창고입니다.');
    return row.version_no;
  }
}

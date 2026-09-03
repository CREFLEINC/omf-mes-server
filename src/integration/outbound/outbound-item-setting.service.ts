import { HttpStatus, Injectable } from '@nestjs/common';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { OUTBOUND_ITEMS, OUTBOUND_ITEM_CODES } from './outbound-item';

/** 계약 `OutboundItemSetting` 과 동형. */
interface SettingView {
  outboundItemCode: string;
  outboundItemName: string;
  enabled: boolean;
  locked: boolean;
  lockReason?: string;
  sendTimingNote?: string;
  interfaceDefinitionId?: number;
  pendingMessageCount: number;
}

export interface SettingUpdate {
  outboundItemCode: string;
  enabled: boolean;
  interfaceDefinitionId?: number | null;
}

/**
 * 송신 항목 설정. 화면은 `W-06-12`(MES→ERP 송신 I/F 정의 — 항목 on/off)가 소유한다.
 *
 * ⛔ 다섯 중 저장하는 것은 **둘뿐**이다(`enabled`·`interfaceDefinitionId`). 이름·잠금·
 *   사유·시점은 앱 상수라 표에 두지 않는다 — 표에 두면 고객이 잠금을 풀 수 있다.
 */
@Injectable()
export class OutboundItemSettingService {
  constructor(private readonly prisma: PrismaService) {}

  /** 「송신 항목 다섯의 켜짐·꺼짐과 잠금 여부」(계약). 저장된 줄이 없어도 다섯을 낸다. */
  async list(): Promise<SettingView[]> {
    const rows = await this.prisma.outbound_item_setting.findMany({
      where: { outbound_item_code: { in: [...OUTBOUND_ITEM_CODES] } },
    });
    const stored = new Map(rows.map((row) => [row.outbound_item_code as string, row]));

    const pending = await this.pendingByInterface(
      rows
        .map((row) => row.interface_definition_id)
        .filter((id): id is bigint => id !== null),
    );

    return OUTBOUND_ITEMS.map((item) => {
      const row = stored.get(item.code);
      const definitionId = row?.interface_definition_id ?? null;
      return {
        outboundItemCode: item.code,
        outboundItemName: item.name,
        // ⛔ 저장된 줄이 없으면 「켜짐」이다 — 송신은 «한다»가 기본이고 끄는 것이 예외다
        //   (계약: 「끄는 순간 외부로 나가는 전표가 끊긴다」). 되돌림 §X-5.
        enabled: row?.is_enabled ?? true,
        locked: item.locked,
        ...(item.lockReason === undefined ? {} : { lockReason: item.lockReason }),
        ...(item.sendTimingNote === undefined ? {} : { sendTimingNote: item.sendTimingNote }),
        ...(definitionId === null ? {} : { interfaceDefinitionId: Number(definitionId) }),
        pendingMessageCount: definitionId === null ? 0 : (pending.get(Number(definitionId)) ?? 0),
      };
    });
  }

  /**
   * 「**묶음으로 저장한다** — 토글이 곧바로 반영되지 않는다. 끄는 순간 외부로 나가는
   * 전표가 끊기고 되돌려도 그 사이는 복구되지 않기 때문이다」(계약).
   *
   * 0 「`locked` 인 항목을 끄려 하면 400 으로 거부한다 — **화면이 조작을 막는 것과 별개로
 *   계약도 막는다**」. 화면만 막으면 API 를 직접 부르는 쪽이 끌 수 있다.
   *
   * 1 계약이 저장 충돌 보호를 두지 않았다 — 「항목이 다섯인 고정 목록이고 행을 오가며
 *   편집하는 형태가 아니다」. 그래서 `If-Match` 가 없다.
   */
  async replace(items: SettingUpdate[], actorId?: number): Promise<SettingView[]> {
    assertShape(items);
    await this.assertDefinitions(items);

    await this.prisma.$transaction(async (tx) => {
      for (const item of items) {
        const definitionId = item.interfaceDefinitionId ?? null;
        const existing = await tx.outbound_item_setting.findFirst({
          where: { outbound_item_code: item.outboundItemCode },
          select: { outbound_item_setting_id: true },
        });
        if (existing === null) {
          await tx.outbound_item_setting.create({
            data: {
              outbound_item_code: item.outboundItemCode,
              is_enabled: item.enabled,
              interface_definition_id: definitionId,
              ...(actorId === undefined ? {} : { created_by: actorId }),
            },
          });
          continue;
        }
        await tx.outbound_item_setting.update({
          where: { outbound_item_setting_id: existing.outbound_item_setting_id },
          data: {
            is_enabled: item.enabled,
            interface_definition_id: definitionId,
            version_no: { increment: 1 },
            ...(actorId === undefined ? {} : { updated_by: actorId }),
          },
        });
      }
    });

    return this.list();
  }

  /** 「아직 보내지 못한 건수」 — 연계 정의별로 한 번에 센다(되돌림 §X-3 과 같은 셈). */
  private async pendingByInterface(definitionIds: bigint[]): Promise<Map<number, number>> {
    if (definitionIds.length === 0) return new Map();
    const definitions = await this.prisma.interface_definition.findMany({
      where: { interface_definition_id: { in: definitionIds } },
      select: { interface_definition_id: true, interface_code: true },
    });
    const counted = await this.prisma.integration_message.groupBy({
      by: ['interface_code'],
      where: {
        interface_code: { in: definitions.map((d) => d.interface_code) },
        completed_at: null,
      },
      _count: { _all: true },
    });
    const byCode = new Map(counted.map((row) => [row.interface_code, row._count._all]));
    return new Map(
      definitions.map((d) => [
        Number(d.interface_definition_id),
        byCode.get(d.interface_code) ?? 0,
      ]),
    );
  }

  private async assertDefinitions(items: SettingUpdate[]): Promise<void> {
    const ids = [
      ...new Set(items.map((item) => item.interfaceDefinitionId).filter((id): id is number => id != null)),
    ];
    if (ids.length === 0) return;
    const found = await this.prisma.interface_definition.findMany({
      where: { interface_definition_id: { in: ids } },
      select: { interface_definition_id: true },
    });
    const known = new Set(found.map((row) => Number(row.interface_definition_id)));

    const errors: ErrorItem[] = items.flatMap((item, index) =>
      item.interfaceDefinitionId != null && !known.has(item.interfaceDefinitionId)
        ? [
            {
              scope: 'field' as const,
              field: `items[${index}].interfaceDefinitionId`,
              code: ERROR_CODE.INVALID,
              message: '없는 연계 정의입니다.',
            },
          ]
        : [],
    );
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  }
}

function assertShape(items: SettingUpdate[]): void {
  const errors: ErrorItem[] = [];
  const seen = new Map<string, number>();
  const locked = new Map(OUTBOUND_ITEMS.map((item) => [item.code, item]));

  items.forEach((item, index) => {
    const known = locked.get(item.outboundItemCode);
    if (known === undefined) {
      // 어휘는 계약이 enum 으로 못박아 가드가 거르지만, 「검사 결과」처럼 목록에 없는 값이
      // 새로 생기면 여기서 걸린다.
      errors.push({
        scope: 'field',
        field: `items[${index}].outboundItemCode`,
        code: ERROR_CODE.INVALID,
        message: '없는 송신 항목입니다.',
      });
      return;
    }
    if (known.locked && !item.enabled) {
      errors.push({
        scope: 'field',
        field: `items[${index}].enabled`,
        code: ERROR_CODE.STATE_LOCKED,
        message: known.lockReason ?? '이 항목은 끌 수 없습니다.',
      });
    }
    const first = seen.get(item.outboundItemCode);
    if (first === undefined) seen.set(item.outboundItemCode, index);
    else {
      errors.push({
        scope: 'field',
        field: `items[${index}].outboundItemCode`,
        code: ERROR_CODE.UNIQUE_VIOLATION,
        uniqueScope: ['outboundItemCode'],
        message: `${first + 1}번째와 같은 항목입니다.`,
      });
    }
  });

  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

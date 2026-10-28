import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { MESSAGE_STATUS } from '../message/integration-message.service';
import { OUTBOUND_ITEMS, OUTBOUND_ITEM_CODES, OutboundItem } from './outbound-item';

/** 계약 `OutboundItemSetting` 과 동형. */
interface SettingView {
  outboundItemCode: string;
  outboundItemName: string;
  enabled: boolean;
  locked: boolean;
  lockReason?: string;
  sendTimingNote?: string;
  interfaceDefinitionId?: number;
  interfaceCode: string | null;
  pendingMessageCount: number;
  failedMessageCount: number;
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 이 서버에서 ERP 보내기 실행기가 켜져 있는가(`ERP_SEND_ENABLED`). 항목의 `enabled` 와 별개다 —
   * 항목이 켜져 있어도 이것이 꺼지면 메시지가 대기로 쌓이기만 한다(장부 P-129).
   */
  sendEnabled(): boolean {
    return this.config.get<string>('ERP_SEND_ENABLED') === 'true';
  }

  /** 「송신 항목 다섯의 켜짐·꺼짐과 잠금 여부」(계약). 저장된 줄이 없어도 다섯을 낸다. */
  async list(): Promise<SettingView[]> {
    const rows = await this.prisma.outbound_item_setting.findMany({
      where: { outbound_item_code: { in: [...OUTBOUND_ITEM_CODES] } },
    });
    const stored = new Map(rows.map((row) => [row.outbound_item_code as string, row]));

    const linked = await this.definitionCodes(
      rows
        .map((row) => row.interface_definition_id)
        .filter((id): id is bigint => id !== null),
    );
    const codeOf = (item: OutboundItem): string | null => {
      const definitionId = stored.get(item.code)?.interface_definition_id;
      return item.interfaceCode ?? (definitionId == null ? null : (linked.get(definitionId) ?? null));
    };
    const counts = await this.countByStatus(
      OUTBOUND_ITEMS.map(codeOf).filter((code): code is string => code !== null),
    );

    return OUTBOUND_ITEMS.map((item) => {
      const row = stored.get(item.code);
      const definitionId = row?.interface_definition_id ?? null;
      const interfaceCode = codeOf(item);
      const count = (status: string): number =>
        interfaceCode === null ? 0 : (counts.get(`${interfaceCode}|${status}`) ?? 0);
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
        interfaceCode,
        // 「대기」는 아직 안 보낸 것(PENDING)만이다 — 송신 예정 목록(`statusCode=PENDING`)의
        // 건수와 같아야 한다(사용자 결정 2026-10-27 · 장부 P-129). 실패는 따로 센다.
        pendingMessageCount: count(MESSAGE_STATUS.PENDING),
        failedMessageCount: count(MESSAGE_STATUS.FAILED),
      };
    });
  }

  /**
   * 「**묶음으로 저장한다** — 토글이 곧바로 반영되지 않는다. 끄는 순간 외부로 나가는
   * 전표가 끊기고 되돌려도 그 사이는 복구되지 않기 때문이다」(계약).
   *
   * ⛔ 「`locked` 인 항목을 끄려 하면 400 으로 거부한다 — **화면이 조작을 막는 것과 별개로
   *   계약도 막는다**」. 화면만 막으면 API 를 직접 부르는 쪽이 끌 수 있다.
   *
   * ⚠ 계약이 저장 충돌 보호를 두지 않았다 — 「항목이 다섯인 고정 목록이고 행을 오가며
   *   편집하는 형태가 아니다」. 그래서 `If-Match` 가 없다.
   */
  async replace(items: SettingUpdate[], actorId?: number): Promise<SettingView[]> {
    assertShape(items);
    await this.assertDefinitions(items);

    await this.prisma.$transaction(async (tx) => {
      for (const item of items) {
        const definitionId = item.interfaceDefinitionId ?? null;
        // ⛔ 찾고-없으면-넣기가 아니라 upsert 다. 표가 «비어서» 시작하므로 첫 저장이 가장
        //   흔한 경로인데, 둘이 동시에 첫 저장을 누르면 찾고-넣기는 둘 다 「없다」를 보고
        //   둘 다 넣어 `uq_outbound_item_setting_code` 에 부딪힌다.
        await tx.outbound_item_setting.upsert({
          where: { outbound_item_code: item.outboundItemCode },
          create: {
            outbound_item_code: item.outboundItemCode,
            is_enabled: item.enabled,
            interface_definition_id: definitionId,
            ...(actorId === undefined ? {} : { created_by: actorId, updated_by: actorId }),
          },
          update: {
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

  private async definitionCodes(definitionIds: bigint[]): Promise<Map<bigint, string>> {
    if (definitionIds.length === 0) return new Map();
    const definitions = await this.prisma.interface_definition.findMany({
      where: { interface_definition_id: { in: definitionIds } },
      select: { interface_definition_id: true, interface_code: true },
    });
    return new Map(definitions.map((d) => [d.interface_definition_id, d.interface_code]));
  }

  /** 송신 메시지를 인터페이스·상태별로 한 번에 센다. 키는 `코드|상태`. */
  private async countByStatus(interfaceCodes: string[]): Promise<Map<string, number>> {
    if (interfaceCodes.length === 0) return new Map();
    const counted = await this.prisma.integration_message.groupBy({
      by: ['interface_code', 'status_code'],
      where: {
        interface_code: { in: interfaceCodes },
        status_code: { in: [MESSAGE_STATUS.PENDING, MESSAGE_STATUS.FAILED] },
      },
      _count: { _all: true },
    });
    return new Map(
      counted.map((row) => [`${row.interface_code}|${row.status_code}`, row._count._all]),
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
  const catalog = new Map(OUTBOUND_ITEMS.map((item) => [item.code, item]));

  items.forEach((item, index) => {
    const known = catalog.get(item.outboundItemCode);
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

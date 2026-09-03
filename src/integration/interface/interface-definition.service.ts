import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import {
  Editability,
  ReferenceQuery,
  assertNotBlank,
  optional,
  referencePage,
  referenceWhere,
} from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 「확정된 수신 대상」 다섯. 계약이 낱말로만 적었다 —
 * 「품목 · 자재명세 · 조직 · 작업자 · 구매발주 다섯이며 그 밖의 값도 받는다 —
 * 막지 않고 표식만 한다」.
 *
 * ⛔ **막는 목록이 아니다.** `withinConfirmedScope` 를 계산하는 데만 쓴다. 목록 밖 값도
 * 그대로 저장되고, 화면이 「확정 목록 밖입니다」를 표식한다.
 *
 * ⚠ 코드 문자열은 계약이 `example: ITEM` 하나만 보였다. 나머지 넷은 그 결에 맞춰 적었다 —
 * 되돌림 §X-1. 틀려도 손상은 «표식이 안 붙는다»에 갇힌다(저장은 그대로 된다).
 */
const CONFIRMED_TARGETS: ReadonlySet<string> = new Set([
  'ITEM',
  'BOM',
  'ORGANIZATION',
  'WORKER',
  'PURCHASE_ORDER',
]);

/** 계약 `InterfaceColumnMapping` 과 동형. */
interface ColumnMappingView {
  relayColumn: string;
  targetTable: string;
  targetColumn: string;
}

/** 계약 `InterfaceDefinition` 과 동형. */
interface DefinitionView {
  interfaceDefinitionId: number;
  interfaceCode: string;
  interfaceName: string;
  directionCode: string;
  targetCode: string;
  externalSystemCode: string;
  triggerTypeCode: string;
  scheduleExpression: string | null;
  eventCondition: string | null;
  relayTableName: string | null;
  withinConfirmedScope: boolean;
  isActive: boolean;
}

export interface DefinitionWrite {
  interfaceCode?: string;
  interfaceName: string;
  directionCode: string;
  targetCode: string;
  externalSystemCode: string;
  triggerTypeCode: string;
  scheduleExpression?: string | null;
  eventCondition?: string | null;
  relayTableName?: string | null;
  columnMappings?: ColumnMappingView[];
}

export interface DefinitionCreate extends DefinitionWrite {
  interfaceCode: string;
}

export interface DefinitionQuery extends ReferenceQuery {
  directionCode?: string;
  targetCode?: string;
  externalSystemCode?: string;
}

/** 계약 `InterfaceConnectionTestResult` 와 동형. */
export interface ConnectionTestResult {
  succeeded: boolean;
  failureCauseCode?: string;
  message?: string;
}

type DefinitionRow = Prisma.interface_definitionGetPayload<object>;

export interface DefinitionResult {
  interfaceDefinition: DefinitionView;
  columnMappings: ColumnMappingView[];
  editability: Editability;
  pendingMessageCount: number;
  versionNo: number;
}

/** 연계 정의. 화면은 `W-06-09`(ERP-MES I/F 연계정의 관리)가 소유한다. */
@Injectable()
export class InterfaceDefinitionService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: DefinitionQuery): Promise<PagedResponse<DefinitionView>> {
    const page = referencePage(query);
    const where = referenceWhere(query, { code: 'interface_code', name: 'interface_name' }, {
      ...(query.directionCode === undefined ? {} : { direction_code: query.directionCode }),
      ...(query.targetCode === undefined ? {} : { target_code: query.targetCode }),
      ...(query.externalSystemCode === undefined
        ? {}
        : { external_system_code: query.externalSystemCode }),
    });
    const [rows, total] = await Promise.all([
      this.prisma.interface_definition.findMany({
        where,
        orderBy: { interface_code: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.interface_definition.count({ where }),
    ]);
    return pagedResponse(rows.map(view), total, page);
  }

  /** 「기본 정보 · 트리거 · 칸 잇기를 한 번에 내린다」(계약). */
  async get(definitionId: number): Promise<DefinitionResult> {
    const row = await this.load(definitionId);
    const [mappings, pendingMessageCount, referenceCount] = await Promise.all([
      this.readMappings(definitionId),
      this.pendingMessages(row.interface_code),
      this.prisma.integration_message.count({ where: { interface_code: row.interface_code } }),
    ]);

    return {
      interfaceDefinition: view(row),
      columnMappings: mappings,
      // ⛔ 연계 코드를 가리키는 것은 «문자열»이다 — `integration_message.interface_code` 에
      // FK 가 없다. 그래도 셀 수는 있다(같은 값으로 세면 된다). 계약이 「interfaceCode 는
      // 참조가 0일 때만 보낼 수 있다」로 그 판정을 요구했다.
      editability: {
        codeEditable: referenceCount === 0,
        reason: referenceCount === 0 ? 'EDITABLE' : 'REFERENCED',
        referenceCount,
      },
      pendingMessageCount,
      versionNo: row.version_no,
    };
  }

  async create(input: DefinitionCreate, actorId?: number): Promise<DefinitionView> {
    assertShape(input);
    await this.assertCodeFree(input.interfaceCode, null);

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.interface_definition.create({
        data: {
          interface_code: input.interfaceCode,
          interface_name: input.interfaceName,
          direction_code: input.directionCode,
          target_code: input.targetCode,
          external_system_code: input.externalSystemCode,
          trigger_type_code: input.triggerTypeCode,
          ...optional('schedule_expression', input.scheduleExpression),
          ...optional('event_condition', input.eventCondition),
          ...optional('relay_table_name', input.relayTableName),
          ...(actorId === undefined ? {} : { created_by: actorId }),
        },
      });
      await writeMappings(tx, Number(row.interface_definition_id), input.columnMappings, actorId);
      return row;
    });

    return view(created);
  }

  /**
   * 「한 번에 저장한다 — 기본 정보 · 트리거 · 칸 잇기가 한 화면의 한 저장이다.
   * `columnMappings` 는 통째로 교체되며 보내지 않은 줄은 사라진다」(계약).
   *
   * ⛔ 「`interfaceCode` 는 **참조가 0일 때만** 보낼 수 있다」(계약). 연계 메시지가 그 코드를
   * 문자열로 가리키므로, 참조가 있는데 바꾸면 그 메시지들이 가리킬 곳을 잃는다.
   */
  async update(
    definitionId: number,
    version: number,
    input: DefinitionWrite,
    actorId?: number,
  ): Promise<DefinitionResult> {
    assertShape(input);
    const current = await this.load(definitionId);

    if (input.interfaceCode !== undefined && input.interfaceCode !== current.interface_code) {
      const referenceCount = await this.prisma.integration_message.count({
        where: { interface_code: current.interface_code },
      });
      if (referenceCount > 0) {
        throw new ContractException(HttpStatus.BAD_REQUEST, [
          {
            scope: 'field',
            field: 'interfaceCode',
            code: ERROR_CODE.STATE_LOCKED,
            message: `이 연계 코드를 가리키는 메시지가 ${referenceCount}건 있어 코드를 바꿀 수 없습니다.`,
          },
        ]);
      }
      await this.assertCodeFree(input.interfaceCode, definitionId);
    }

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.interface_definition.updateMany({
        // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
        where: { interface_definition_id: definitionId, version_no: version },
        data: {
          ...optional('interface_code', input.interfaceCode),
          interface_name: input.interfaceName,
          direction_code: input.directionCode,
          target_code: input.targetCode,
          external_system_code: input.externalSystemCode,
          trigger_type_code: input.triggerTypeCode,
          ...optional('schedule_expression', input.scheduleExpression),
          ...optional('event_condition', input.eventCondition),
          ...optional('relay_table_name', input.relayTableName),
          version_no: { increment: 1 },
          ...(actorId === undefined ? {} : { updated_by: actorId }),
        },
      });
      if (updated.count === 0) assertUpdated(0);
      await writeMappings(tx, definitionId, input.columnMappings, actorId);
    });

    return this.get(definitionId);
  }

  async setActive(
    definitionId: number,
    version: number,
    isActive: boolean,
  ): Promise<DefinitionResult> {
    const updated = await this.prisma.interface_definition.updateMany({
      where: { interface_definition_id: definitionId, version_no: version },
      data: { is_active: isActive, version_no: { increment: 1 } },
    });
    if (updated.count === 0) {
      await this.load(definitionId);
      assertUpdated(0);
    }
    return this.get(definitionId);
  }

  /**
   * 「중계 테이블에 닿는지만 본다. **실제 동기화는 돌리지 않는다**」(계약).
   * 「실패해도 저장을 막지 않는다 — 설정을 먼저 하고 연결을 나중에 맞추는 것이 정상 순서다」.
   *
   * ⛔ 원인을 셋으로 가른다(계약) — 「연결 실패」 한 마디로 뭉치면 무엇을 고쳐야 할지 모른다.
   * 지금 닿을 수 있는 것은 **우리 DB 안의 중계 테이블**뿐이다. 외부 시스템으로 나가는
   * 전송로(`transport_code`)는 계약에 축이 없어 시험할 대상이 없다 — 되돌림 §X-2.
   */
  async testConnection(definitionId: number): Promise<ConnectionTestResult> {
    const row = await this.load(definitionId);
    if (row.relay_table_name === null || row.relay_table_name.trim() === '') {
      return {
        succeeded: false,
        failureCauseCode: 'TABLE_NOT_FOUND',
        message: '중계 테이블 이름이 비어 있습니다.',
      };
    }

    const [schema, table] = splitTableName(row.relay_table_name);
    const found = await this.prisma.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = ${schema} AND table_name = ${table}
      ) AS "exists"`;
    if (found[0]?.exists !== true) {
      return {
        succeeded: false,
        failureCauseCode: 'TABLE_NOT_FOUND',
        message: `중계 테이블을 찾지 못했습니다: ${row.relay_table_name}`,
      };
    }

    const readable = await this.prisma.$queryRaw<{ allowed: boolean }[]>`
      SELECT has_table_privilege(${row.relay_table_name}, 'SELECT') AS "allowed"`;
    if (readable[0]?.allowed !== true) {
      return {
        succeeded: false,
        failureCauseCode: 'PERMISSION_DENIED',
        message: `중계 테이블을 읽을 권한이 없습니다: ${row.relay_table_name}`,
      };
    }

    return { succeeded: true, message: `중계 테이블에 닿았습니다: ${row.relay_table_name}` };
  }

  private async readMappings(definitionId: number): Promise<ColumnMappingView[]> {
    const rows = await this.prisma.interface_column_mapping.findMany({
      where: { interface_definition_id: definitionId },
      orderBy: { sequence_no: 'asc' },
    });
    return rows.map((row) => ({
      relayColumn: row.relay_column,
      targetTable: row.target_table,
      targetColumn: row.target_column,
    }));
  }

  /** 「아직 보내지 못한」 — 완료도 실패도 아닌 것을 센다(되돌림 §X-3). */
  private async pendingMessages(interfaceCode: string): Promise<number> {
    return this.prisma.integration_message.count({
      where: { interface_code: interfaceCode, completed_at: null },
    });
  }

  private async assertCodeFree(interfaceCode: string, self: number | null): Promise<void> {
    const taken = await this.prisma.interface_definition.findUnique({
      where: { interface_code: interfaceCode },
      select: { interface_definition_id: true },
    });
    if (!taken || (self !== null && Number(taken.interface_definition_id) === self)) return;
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      {
        scope: 'field',
        field: 'interfaceCode',
        code: ERROR_CODE.UNIQUE_VIOLATION,
        uniqueScope: ['interfaceCode'],
        message: '이미 있는 연계 코드입니다.',
      },
    ]);
  }

  private async load(definitionId: number): Promise<DefinitionRow> {
    const row = await this.prisma.interface_definition.findUnique({
      where: { interface_definition_id: definitionId },
    });
    if (!row) throw new NotFoundException('없는 연계 정의입니다.');
    return row;
  }
}

/** `integration.goods_receipt_relay` 처럼 스키마가 붙어 올 수 있다. 없으면 public 이다. */
function splitTableName(name: string): [string, string] {
  const parts = name.trim().split('.');
  return parts.length >= 2 ? [parts[0], parts.slice(1).join('.')] : ['public', parts[0]];
}

async function writeMappings(
  tx: Prisma.TransactionClient,
  definitionId: number,
  mappings: ColumnMappingView[] | undefined,
  actorId: number | undefined,
): Promise<void> {
  if (mappings === undefined) return;
  // ⛔ 통째로 교체다 — 「보내지 않은 줄은 사라진다」(계약). 이 표를 가리키는 곳이 없어
  //   지우고 다시 넣어도 무너지는 것이 없다(공정 라인·검사 항목과 갈리는 지점이다).
  await tx.interface_column_mapping.deleteMany({ where: { interface_definition_id: definitionId } });
  if (mappings.length === 0) return;
  await tx.interface_column_mapping.createMany({
    data: mappings.map((mapping, index) => ({
      interface_definition_id: definitionId,
      sequence_no: index + 1,
      relay_column: mapping.relayColumn,
      target_table: mapping.targetTable,
      target_column: mapping.targetColumn,
      ...(actorId === undefined ? {} : { created_by: actorId }),
    })),
  });
}

/**
 * 「트리거 유형이 `TIME_SCHEDULE` 이면 `scheduleExpression` 이, `EVENT` 이면
 * `eventCondition` 이 함께 있어야 한다. **한쪽만 채워 보내면 400** 이다」(계약).
 */
function assertShape(input: DefinitionWrite): void {
  const fields: (readonly [string, string])[] = [['interfaceName', input.interfaceName]];
  if (input.interfaceCode !== undefined) fields.push(['interfaceCode', input.interfaceCode]);
  assertNotBlank(fields);

  const errors: ErrorItem[] = [];
  const required = input.triggerTypeCode === 'TIME_SCHEDULE' ? 'scheduleExpression' : 'eventCondition';
  const value = required === 'scheduleExpression' ? input.scheduleExpression : input.eventCondition;
  if (value === undefined || value === null || value.trim() === '') {
    errors.push({
      scope: 'field',
      field: required,
      code: ERROR_CODE.PAIR,
      message: `트리거 유형이 ${input.triggerTypeCode} 이면 이 칸이 함께 있어야 합니다.`,
    });
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

function view(row: DefinitionRow): DefinitionView {
  return {
    interfaceDefinitionId: Number(row.interface_definition_id),
    interfaceCode: row.interface_code,
    interfaceName: row.interface_name,
    directionCode: row.direction_code,
    targetCode: row.target_code,
    externalSystemCode: row.external_system_code,
    triggerTypeCode: row.trigger_type_code,
    scheduleExpression: row.schedule_expression,
    eventCondition: row.event_condition,
    relayTableName: row.relay_table_name,
    // ⛔ 계산값이다 — 저장하지 않는다. 확정 목록이 바뀌면 저장된 행을 고칠 일이 없다.
    withinConfirmedScope: CONFIRMED_TARGETS.has(row.target_code),
    isActive: row.is_active,
  };
}

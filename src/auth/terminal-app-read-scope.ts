import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';

import { ContractException, ERROR_CODE } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { TerminalContext } from './terminal-context';

export const TERMINAL_APP_READ_OPERATIONS: Readonly<Record<string, readonly ('POP' | 'MOBILE')[]>> = {
  'GET /app/approval-requests': ['MOBILE'],
  'GET /app/document-issues': ['POP'],
  'GET /app/document-issues/summary': ['POP'],
  'GET /app/document-issues/{documentIssueLogId}/rendition': ['POP'],
  'GET /app/printers': ['POP'],
  'GET /app/operation-policies/effective': ['POP'],
};

/**
 * 단말이 내려받을 수 있는 출력물(D5). ⛔ 자기 공장 소유 대상인지는 `assertOwnedTarget` 이
 * 따로 본다 — 이 목록은 「어떤 출력물이냐」만 가린다.
 */
const RENDITION_DOCUMENT_TYPES: readonly string[] = [
  'MATERIAL_LOT_LABEL',
  'PRODUCTION_LOT_LABEL',
  'DELIVERY_LABEL',
];

export type TerminalApprovalListScope =
  | { plantId: bigint; lotId: bigint; workerId?: never }
  | { plantId: bigint; workerId: bigint; lotId?: never };
const APPROVAL_SCOPE = Symbol('terminalApprovalListScope');
export function currentTerminalApprovalListScope(request: Request): TerminalApprovalListScope | undefined {
  return (request as Request & { [APPROVAL_SCOPE]?: TerminalApprovalListScope })[APPROVAL_SCOPE];
}

export async function assertTerminalAppReadScope(
  prisma: PrismaService,
  request: Request,
  key: string,
  terminal: TerminalContext,
): Promise<void> {
  const query = request.query as Record<string, unknown>;
  switch (key) {
    case 'GET /app/approval-requests': {
      if (terminal.terminalTypeCode !== 'MOBILE') throw denied();
      const allowed = new Set(['targetTypeCode', 'targetId', 'pendingOnly', 'requestedByMe', 'size', 'page']);
      if (Object.keys(query).some((name) => !allowed.has(name))) throw denied();
      const size = query.size === undefined ? 20 : Number(query.size);
      if (!Number.isInteger(size) || size < 1 || size > 20) throw denied();
      let scope: TerminalApprovalListScope;
      if (query.requestedByMe === 'true' || query.requestedByMe === true) {
        if (query.targetId !== undefined || query.targetTypeCode !== undefined || query.pendingOnly !== undefined) throw denied();
        const workerNo = request.headers['x-worker-no'];
        const worker = typeof workerNo === 'string' && workerNo.trim()
          ? await prisma.worker.findFirst({ where: { worker_no: workerNo, plant_id: terminal.plantId, is_active: true },
            select: { worker_id: true } }) : null;
        if (!worker) throw denied();
        scope = { plantId: terminal.plantId, workerId: worker.worker_id };
      } else {
        const lotId = positiveId(query.targetId);
        if (query.targetTypeCode !== 'INBOUND_LOT' || lotId === null
          || !(query.pendingOnly === 'true' || query.pendingOnly === true)
          || query.requestedByMe !== undefined || size > 1) throw denied();
        const lot = await prisma.lot.findFirst({ where: { lot_id: lotId, plant_id: terminal.plantId,
          source_type_code: 'INBOUND_RECEIPT_LINE' }, select: { lot_id: true } });
        if (!lot) throw denied();
        scope = { plantId: terminal.plantId, lotId };
      }
      Object.defineProperty(request, APPROVAL_SCOPE, { value: scope, configurable: true });
      break;
    }
    case 'GET /app/document-issues':
      await assertOwnedTarget(prisma, terminal, query.targetTypeCode, query.targetId);
      break;
    case 'GET /app/document-issues/summary': {
      const ids = csvQueryValues(query.targetIds);
      if (ids.length < 1 || ids.length > 1000) throw denied();
      for (const id of ids) await assertOwnedTarget(prisma, terminal, query.targetTypeCode, id);
      break;
    }
    case 'GET /app/document-issues/{documentIssueLogId}/rendition': {
      const logId = positiveId(request.params.documentIssueLogId);
      const issue = logId === null ? null : await prisma.document_issue_log.findUnique({
        where: { document_issue_log_id: logId },
        select: { document_type_code: true, target_type_code: true, target_id: true },
      });
      // ⭐ 생산 LOT 라벨을 더한다(D5). POP 이 실적 뒤 라벨을 찍으려면 이 렌디션을 받아야 하는데
      //    목록에 없어 401 이었다 — 셸이 인쇄 데이터를 못 받아 인쇄가 실패로 기록됐다.
      //    ⚠ 범위만 연 것이다. 생산 LOT 라벨의 렌디션 «구현»은 아직 없다(아래 서비스가 422).
      if (!issue || !RENDITION_DOCUMENT_TYPES.includes(issue.document_type_code)) throw denied();
      await assertOwnedTarget(prisma, terminal, issue.target_type_code, issue.target_id);
      break;
    }
    case 'GET /app/printers':
      if (query.terminalId !== undefined && positiveId(query.terminalId) !== terminal.terminalId)
        throw denied();
      break;
    case 'GET /app/operation-policies/effective':
      // ⭐ 범위 축을 «좁혀» 묻는 것을 받는다(D2 · 2026-09-15). 전에는 `policyCode` 하나만 오는
      // 공구 사용 화면만 상정해 축이 하나라도 오면 막았는데, 작업 전 점검 게이트(P-02-02)는
      // 단말의 공장과 W/O 의 공정으로 좁혀 묻는다 — 그래서 시작 자체가 401 이었다.
      // 계약의 ⌜범위 축을 비워 보내도 된다⌝ 는 비우는 것을 «허용»할 뿐 금지가 아니다.
      //  ⛔ `plantId` 는 단말의 공장과 «같아야» 한다 — 이 축이 단말의 소속이다.
      //  ⚠ 나머지 셋은 형식만 본다. 정책 «값»을 좁혀 읽을 뿐이라 남의 id 를 넣어도 새로 열리는
      //    것이 없다(업무 데이터가 아니라 마스터 설정값이다).
      if (query.plantId !== undefined && positiveId(query.plantId) !== terminal.plantId) throw denied();
      for (const axis of [query.businessUnitId, query.itemId, query.processId]) {
        if (axis !== undefined && positiveId(axis) === null) throw denied();
      }
      break;
    default:
      throw denied();
  }
}

export async function assertOwnedTarget(
  prisma: PrismaService,
  terminal: TerminalContext,
  targetType: unknown,
  target: unknown,
): Promise<void> {
  const id = positiveId(target);
  if (id === null) throw denied();
  const plantId = terminal.plantId;
  let owned: boolean;
  switch (targetType) {
    case 'LOT':
      owned = !!await prisma.lot.findFirst({ where: { lot_id: id, plant_id: plantId }, select: { lot_id: true } });
      break;
    case 'SERIAL_NUMBER':
      owned = !!await prisma.serial_number.findFirst({ where: { serial_number_id: id, lot: { plant_id: plantId } }, select: { serial_number_id: true } });
      break;
    case 'HANDLING_UNIT': {
      const row = await prisma.handling_unit.findUnique({ where: { handling_unit_id: id },
        select: { warehouse: { select: { plant_id: true } }, location: { select: { warehouse: { select: { plant_id: true } } } } } });
      owned = !!row && !!(row.warehouse || row.location)
        && (row.warehouse === null || row.warehouse.plant_id === plantId)
        && (row.location === null || row.location.warehouse.plant_id === plantId);
      break;
    }
    case 'GOODS_ISSUE_LINE':
      owned = !!await prisma.goods_issue_line.findFirst({ where: {
        goods_issue_line_id: id, location: { warehouse: { plant_id: plantId } },
      }, select: { goods_issue_line_id: true } });
      break;
    case 'MOLD':
      owned = !!await prisma.mold.findFirst({ where: { mold_id: id, plant_id: plantId }, select: { mold_id: true } });
      break;
    case 'LOCATION':
      owned = !!await prisma.location.findFirst({ where: { location_id: id, warehouse: { plant_id: plantId } }, select: { location_id: true } });
      break;
    case 'INSPECTION_RESULT':
      owned = !!await prisma.inspection_result.findFirst({ where: {
        inspection_result_id: id, inspection_request: { work_order: { production_line: { plant_id: plantId } } },
      }, select: { inspection_result_id: true } });
      break;
    case 'SHIPPING_UNIT':
      // 소유는 그 출하 전표의 창고 공장이다(배분과 같은 축).
      owned = !!await prisma.shipping_unit.findFirst({ where: {
        shipping_unit_id: id, shipment: { warehouse: { plant_id: plantId } },
      }, select: { shipping_unit_id: true } });
      break;
    case 'SHIPMENT_LOT_ALLOCATION':
      owned = !!await prisma.shipment_lot_allocation.findFirst({ where: {
        shipment_lot_allocation_id: id,
        shipment_line: { shipment: { warehouse: { plant_id: plantId } } },
      }, select: { shipment_lot_allocation_id: true } });
      break;
    default:
      throw denied();
  }
  if (!owned) throw denied();
}

/**
 * `style: form` · `explode: false` 배열 질의를 «계약 검증기와 같은 규칙»으로 푼다(D7).
 *
 * ⛔ **이 가드는 계약 검증 «앞»에서 돈다**(`app.module.ts`: 인증 → 권한 → 계약 검증).
 * 그래서 `targetIds=1,2,3` 이 아직 나뉘지 않은 문자열 하나로 들어온다 — 전에는 그것을
 * id 하나로 보아 `positiveId("1,2,3")` 이 null 이 되고, 자기 공장 전표인데도 401 이었다.
 * 계약이 그렇게 직렬화하라고 적은 값이라 **클라이언트는 옳았다.**
 *
 * ⚠ **이미 배열로 온 값은 원소 안의 쉼표를 다시 나누지 않는다** — `contract-validator.ts`
 * 의 `splitCsvQuery` 와 한 글자도 다르지 않게 맞춘 자리다. 여기서 더 나누면 두 파서가
 * 이번엔 «반대 방향»으로 어긋나, 계약 검증이 400 으로 가를 값을 이 가드가 먼저 통과시킨다.
 */
function csvQueryValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(',');
  return [value];
}

function positiveId(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return null;
  const text = String(value);
  if (!/^\d+$/.test(text)) return null;
  const id = BigInt(text);
  return id > 0n && id < 9223372036854775808n ? id : null;
}

function denied(): ContractException {
  return new ContractException(HttpStatus.UNAUTHORIZED, [
    { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '단말 인증 범위 밖입니다.' },
  ]);
}

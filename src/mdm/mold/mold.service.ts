import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import {
  Editability,
  ReferenceQuery,
  Referrer,
  assertCodeValues,
  countReferences,
  optional,
  referencePage,
  referenceWhere,
} from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse } from '../../common/pagination';
import { DocumentStateService } from '../../core/document-state';
import { PrismaService } from '../../prisma/prisma.service';
import { ImportRow, parseMoldWorkbook } from './mold-import';
import {
  MoldSort,
  MoldSummary,
  MoldView,
  localDate,
  sorter,
  summarize,
  view,
} from './mold-derivation';

/**
 * 툴 마스터. 표 이름은 금형이지만 담는 것은 **모든 도구**이고 `tool_type_code` 가
 * 가른다 — 표 이름을 바꾸지 않는 근거는 W-05-13 §3-3(참조 4곳을 함께 고칠 값이 없다).
 * 화면은 `W-05-13`(툴 마스터)·`W-05-02`(예방보전 도래 조회)가 함께 쓴다.
 */

/** 툴을 FK 로 가리키는 자리 전부 — 일곱 곳이다. e2e 가 `pg_constraint` 로 대조한다. */
export const MOLD_REFERRERS: readonly Referrer[] = [
  ['maintenance.maintenance_order', 'mold_id'],
  ['maintenance.tool_usage', 'mold_id'],
  ['production.production_result', 'mold_id'],
  ['production.work_order', 'planned_mold_id'],
  ['production.work_order_resource_assignment', 'mold_id'],
  ['production.work_session', 'mold_id'],
  ['quality.defect_record', 'mold_id'],
];

/** 라벨 발행 이력을 세는 축 — `app.document_issue_log` 의 다형 대상 쌍. */
const LABEL_TARGET_TYPE = 'MOLD';
const LABEL_DOCUMENT_TYPE = 'TOOL_LABEL';

/**
 * 열린 보전오더의 뜻 — 끝난 것만 뺀다. 시드 `MAINTENANCE_ORDER_STATUS` 는
 * 발행·완료·취소 셋인데, 상태가 늘면 「끝났다」가 아니라 「아직 열려 있다」가 기본이어야
 * 안전하다. 열린 것을 빠뜨리면 이미 지시가 나간 툴에 지시를 또 낸다.
 */
const CLOSED_ORDER_STATUSES = ['DONE', 'CANCELLED'];

/** 자산 폐기는 사용 중지와 «다른 축»이다 — 공유계약 `B-16`. */
const STATUS_COLUMN = 'mdm.mold.status_code';
const DISPOSED = 'DISPOSED';

export interface MoldQuery extends ReferenceQuery {
  plantId?: number;
  toolTypeCode?: string;
  statusCode?: string;
  withOpenMaintenanceOrder?: boolean | string;
  guaranteedShotCountMissing?: boolean | string;
  pmDueOnly?: boolean | string;
  sort?: MoldSort;
}

/** 계약 `MoldUpdate`. `currentShotCount`·`statusCode` 는 받지 않는다 — 실적과 `:dispose` 가 정한다. */
export interface MoldWrite {
  moldCode?: string;
  moldName: string;
  toolTypeCode: string;
  cavityCount: number;
  guaranteedShotCount?: number | null;
  pmTriggerTypeCode?: string;
  pmCycleInterval?: number | null;
  pmCycleUnitCode?: string | null;
}

/** 계약 `MoldCreate` — 위에 공장과 코드가 붙고 둘 다 required 다. */
export interface MoldCreate extends MoldWrite {
  plantId: number;
  moldCode: string;
}

/** 계약 `BatchFailure` — `index` 는 엑셀 «자료 행»의 순번이다(머리글 제외 0부터). */
interface BatchFailure {
  index: number;
  key?: string;
  errors: ErrorItem[];
}

/** 계약 `BatchResult` — 전체 롤백하지 않고 거부 건만 되돌린다(공유계약 C-2). */
export interface BatchResult {
  succeeded: number;
  failed: BatchFailure[];
}

export type MoldResult = {
  mold: MoldView;
  editability: Editability;
  labelIssueCount: number;
  versionNo: number;
};

@Injectable()
export class MoldService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentState: DocumentStateService,
  ) {}

  /**
   * ⚠ 페이지가 아니라 **필터 전체**를 읽는다. 요약(`summary`)이 전체 기준이고 정렬 축
   * 둘(초과율·다음 예정일)이 저장되지 않은 도출값이라, 어차피 전건을 훑어야 한다.
   * 툴 마스터는 공장당 수천 행 규모라 이 값이 문제가 되는 자리가 아니다.
   */
  async list(query: MoldQuery): Promise<PagedResponse<MoldView> & { summary: MoldSummary }> {
    // ⛔ 요약에 거는 축은 넷뿐이다(계약) — pmDueOnly 를 걸면 「임박」이 항상 0 이 된다.
    // 나머지 필터는 전부 이 집합을 좁히기만 하므로 한 번 읽어 둘 다 만든다.
    const rows = await this.prisma.mold.findMany({
      where: referenceWhere(query, { code: 'mold_code', name: 'mold_name' }, {
        ...optional('plant_id', query.plantId),
        ...optional('tool_type_code', query.toolTypeCode),
      }),
    });

    const today = await this.plantToday(rows.map((row) => row.plant_id));
    const all = rows.map((row) => view(row, today.get(String(row.plant_id)) ?? ''));
    const summary = summarize(all);

    const filtered = await this.narrow(all, query);
    filtered.sort(sorter(query.sort ?? 'CODE'));

    const page = referencePage(query);
    const items = filtered.slice(page.skip, page.skip + page.take);
    return { ...pagedResponse(items, filtered.length, page), summary };
  }

  async get(moldId: number): Promise<MoldResult> {
    const row = await this.prisma.mold.findUnique({ where: { mold_id: moldId } });
    if (!row) throw new NotFoundException('없는 툴입니다.');

    const [referenceCount, labelIssueCount, today] = await Promise.all([
      countReferences(this.prisma, MOLD_REFERRERS, row.mold_id),
      this.labelIssueCount(row.mold_id),
      this.plantToday([row.plant_id]),
    ]);
    return {
      mold: view(row, today.get(String(row.plant_id)) ?? ''),
      editability: editability(referenceCount, labelIssueCount),
      labelIssueCount,
      versionNo: row.version_no,
    };
  }

  async create(input: MoldCreate): Promise<MoldView> {
    await this.assertWritable(input);
    await this.assertCodeFree(input.plantId, input.moldCode, null);

    const row = await this.prisma.mold.create({
      data: {
        plant_id: input.plantId,
        mold_code: input.moldCode,
        mold_name: input.moldName,
        tool_type_code: input.toolTypeCode,
        cavity_count: input.cavityCount,
        // 새 툴은 운용 중이다 — 폐기는 `:dispose` 로만 간다(공유계약 B-16).
        status_code: 'IN_SERVICE',
        // 계약이 이 칸에 기본값 NONE 을 선언했다 — 안 보내면 예방보전을 하지 않는 툴이다.
        pm_trigger_type_code: input.pmTriggerTypeCode ?? 'NONE',
        ...optional('guaranteed_shot_count', input.guaranteedShotCount),
        ...optional('pm_cycle_interval', input.pmCycleInterval),
        ...optional('pm_cycle_unit_code', input.pmCycleUnitCode),
      },
    });
    const today = await this.plantToday([row.plant_id]);
    return view(row, today.get(String(row.plant_id)) ?? '');
  }

  async update(moldId: number, version: number, input: MoldWrite): Promise<MoldResult> {
    await this.assertWritable(input);
    const current = await this.get(moldId);
    assertNotDisposed(current.mold.statusCode);

    if (input.moldCode !== undefined && input.moldCode !== current.mold.moldCode) {
      // 공유계약 B-4 — 참조가 있거나 라벨이 나갔으면 코드를 못 바꾼다.
      // 「업무 규칙 위반은 409 가 아니라 400」(계약).
      if (!current.editability.codeEditable) throw codeLocked(current);
      await this.assertCodeFree(current.mold.plantId, input.moldCode, moldId);
    }

    const updated = await this.prisma.mold.updateMany({
      // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
      where: { mold_id: moldId, version_no: version },
      data: {
        mold_name: input.moldName,
        tool_type_code: input.toolTypeCode,
        cavity_count: input.cavityCount,
        // ⚠ 수정은 통째로 바꾸는 자리다 — 안 보낸 판정 기준은 계약이 선언한 기본값
        // NONE 으로 되돌린다. 옛 값을 남기면 「끄려고 지웠다」가 조용히 무시된다.
        pm_trigger_type_code: input.pmTriggerTypeCode ?? 'NONE',
        ...optional('mold_code', input.moldCode),
        ...optional('guaranteed_shot_count', input.guaranteedShotCount),
        ...optional('pm_cycle_interval', input.pmCycleInterval),
        ...optional('pm_cycle_unit_code', input.pmCycleUnitCode),
        version_no: { increment: 1 },
      },
    });
    await this.assertExists(moldId, updated.count);
    return this.get(moldId);
  }

  /**
   * 사용 중지·재개. 목록에서 감추는 것뿐이라 자산 상태(`status_code`)를 건드리지
   * 않는다 — 물리 삭제를 두지 않으므로 되돌리는 경로가 `:activate` 하나다(계약).
   */
  async setActive(moldId: number, version: number, isActive: boolean): Promise<MoldResult> {
    const updated = await this.prisma.mold.updateMany({
      where: { mold_id: moldId, version_no: version },
      data: { is_active: isActive, version_no: { increment: 1 } },
    });
    await this.assertExists(moldId, updated.count);
    return this.get(moldId);
  }

  /**
   * 자산을 폐기한다. 사용 중지와 «다른 축»이다 — 중지는 목록에서 감추는 것이고 폐기는
   * 자산이 끝난 것이다(B-16). 전이는 상태기계 코어가 가른다.
   */
  async dispose(moldId: number, version: number): Promise<MoldResult> {
    const current = await this.prisma.mold.findUnique({
      where: { mold_id: moldId },
      select: { status_code: true },
    });
    if (!current) throw new NotFoundException('없는 툴입니다.');
    const transition = this.documentState.assertTransition(
      STATUS_COLUMN,
      'mold-dispose',
      current.status_code,
      // ⛔ 400 이다. 계약이 이 오퍼레이션의 409 설명에 「업무 규칙 위반(상태 잠김·참조
      // 존재)은 409 가 아니라 400 이다」로 적었다 — 409 는 저장 충돌 전용이다.
      // ⚠ 형제인 설비 `:dispose` 는 지금 409 를 낸다. 계약 문구는 둘이 같다(되돌림 §O-8).
      HttpStatus.BAD_REQUEST,
    );

    const updated = await this.prisma.mold.updateMany({
      where: { mold_id: moldId, version_no: version },
      data: { status_code: transition.to, version_no: { increment: 1 } },
    });
    await this.assertExists(moldId, updated.count);
    return this.get(moldId);
  }

  /**
   * 엑셀 대장 한 장을 마스터 행으로 옮긴다.
   *
   * ⛔ 통째로 되돌리지 않는다 — 성공한 행은 남기고 거부한 행만 돌려준다(공유계약 C-2).
   * ⛔ 라벨을 자동으로 발행하지 않는다 — 「올리기가 만드는 것은 마스터 행뿐」(계약).
   */
  async importWorkbook(buffer: Buffer): Promise<BatchResult> {
    const parsed = await parseMoldWorkbook(buffer);
    if (parsed.error) throw new ContractException(HttpStatus.BAD_REQUEST, [parsed.error]);

    const plants = await this.prisma.plant.findMany({
      select: { plant_id: true, plant_code: true },
    });
    const result: BatchResult = { succeeded: 0, failed: [] };

    // ⛔ 한 행씩 차례로 넣는다. 병렬로 돌리면 같은 코드가 두 행에 있을 때 둘 다
    // 유일 검사를 통과한다 — 실패 목록이 「무엇이 왜 거부됐는지」를 못 말하게 된다.
    for (const row of parsed.rows) {
      const plantId = resolvePlant(row, plants);
      if (plantId === null) {
        result.failed.push(failure(row, [plantNotResolved(row.plantCode)]));
        continue;
      }
      try {
        await this.create({ plantId, ...row.values });
        result.succeeded += 1;
      } catch (error) {
        if (!(error instanceof ContractException)) throw error;
        result.failed.push(failure(row, error.errors));
      }
    }
    return result;
  }

  /** 코드가 라벨로 나갔는지 센다 — 1 이상이면 참조가 0이어도 코드를 잠근다(계약). */
  private labelIssueCount(moldId: bigint): Promise<number> {
    return this.prisma.document_issue_log.count({
      where: {
        target_type_code: LABEL_TARGET_TYPE,
        document_type_code: LABEL_DOCUMENT_TYPE,
        target_id: moldId,
      },
    });
  }

  /** 도출값·상태로 좁힌다. 요약을 낸 «뒤»에 거는 것이 계약이 요구한 순서다. */
  private async narrow(rows: MoldView[], query: MoldQuery): Promise<MoldView[]> {
    let kept = rows;
    if (query.statusCode !== undefined) {
      kept = kept.filter((row) => row.statusCode === query.statusCode);
    }
    // 「…Missing」은 상태를 묻는 이름이라 양쪽으로 가른다 — 거짓이면 채워진 것만 본다.
    const missing = bool(query.guaranteedShotCountMissing);
    if (missing !== undefined) {
      kept = kept.filter((row) => (row.guaranteedShotCount === null) === missing);
    }
    // 「…Only」는 좁히는 이름이라 참일 때만 건다.
    if (bool(query.pmDueOnly) === true) kept = kept.filter((row) => row.pmDue);

    const open = bool(query.withOpenMaintenanceOrder);
    if (open !== undefined) {
      const ordered = await this.moldsWithOpenOrder(kept.map((row) => row.moldId));
      kept = kept.filter((row) => ordered.has(row.moldId) === open);
    }
    return kept;
  }

  private async moldsWithOpenOrder(moldIds: number[]): Promise<Set<number>> {
    if (moldIds.length === 0) return new Set();
    const rows = await this.prisma.maintenance_order.findMany({
      where: {
        mold_id: { in: moldIds.map((id) => BigInt(id)) },
        status_code: { notIn: CLOSED_ORDER_STATUSES },
      },
      select: { mold_id: true },
      distinct: ['mold_id'],
    });
    return new Set(rows.map((row) => Number(row.mold_id)));
  }

  /**
   * 공장 로컬 오늘. ⛔ 서버 날짜가 아니다 — 하노이는 UTC+7 이라 저녁 이후 하루가
   * 어긋나고, 그 하루가 예방보전 도래를 하루 늦춘다(CLAUDE.md · `plant.timezone_code`).
   */
  private async plantToday(plantIds: readonly bigint[]): Promise<Map<string, string>> {
    const unique = [...new Set(plantIds.map(String))];
    if (unique.length === 0) return new Map();
    const plants = await this.prisma.plant.findMany({
      where: { plant_id: { in: unique.map((id) => BigInt(id)) } },
      select: { plant_id: true, timezone_code: true },
    });
    const now = new Date();
    return new Map(plants.map((p) => [String(p.plant_id), localDate(now, p.timezone_code)]));
  }

  private async assertWritable(input: MoldWrite): Promise<void> {
    const errors: ErrorItem[] = [];
    if (input.cavityCount < 1) {
      errors.push({
        scope: 'field',
        field: 'cavityCount',
        code: ERROR_CODE.RANGE,
        message: '캐비티 수는 1 이상입니다.',
      });
    }
    if (input.guaranteedShotCount != null && input.guaranteedShotCount < 0) {
      errors.push({
        scope: 'field',
        field: 'guaranteedShotCount',
        code: ERROR_CODE.RANGE,
        message: '적정타수는 0 이상입니다.',
      });
    }
    // ⛔ 날짜 축은 간격과 단위가 짝이다 — 하나만 있으면 다음 예정일이 서지 않아
    // 예방보전이 도래하지 않은 채로 조용히 지나간다. 물리에도 CHECK 로 걸었다.
    if ((input.pmCycleInterval == null) !== (input.pmCycleUnitCode == null)) {
      errors.push({
        scope: 'field',
        field: input.pmCycleInterval == null ? 'pmCycleInterval' : 'pmCycleUnitCode',
        code: ERROR_CODE.PAIR,
        message: '주기 간격과 단위는 함께 넣거나 함께 비웁니다.',
      });
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    await assertCodeValues(this.prisma, [
      { field: 'toolTypeCode', value: input.toolTypeCode, groupCode: 'TOOL_TYPE' },
      {
        field: 'pmTriggerTypeCode',
        value: input.pmTriggerTypeCode,
        groupCode: 'MOLD_PM_TRIGGER_TYPE',
      },
      { field: 'pmCycleUnitCode', value: input.pmCycleUnitCode, groupCode: 'CYCLE_TYPE' },
    ]);
  }

  /** `mold_code` 는 **공장 안에서만** 유일하다(uq_mold) — 「중복이면 400」(계약). */
  private async assertCodeFree(plantId: number, moldCode: string, self: number | null): Promise<void> {
    const taken = await this.prisma.mold.findUnique({
      where: { plant_id_mold_code: { plant_id: plantId, mold_code: moldCode } },
      select: { mold_id: true },
    });
    if (!taken || (self !== null && Number(taken.mold_id) === self)) return;
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      {
        scope: 'field',
        field: 'moldCode',
        code: ERROR_CODE.UNIQUE_VIOLATION,
        uniqueScope: ['plantId', 'moldCode'],
        message: '같은 공장에 이미 있는 툴 코드입니다.',
      },
    ]);
  }

  /** 0행이 「없다」인지 「낡았다」인지 가른다 — 화면이 받는 상태 코드가 갈린다. */
  private async assertExists(moldId: number, count: number): Promise<void> {
    if (count > 0) return;
    const exists = await this.prisma.mold.findUnique({
      where: { mold_id: moldId },
      select: { mold_id: true },
    });
    if (!exists) throw new NotFoundException('없는 툴입니다.');
    assertUpdated(0);
  }
}

function editability(referenceCount: number, labelIssueCount: number): Editability {
  // ⛔ 라벨이 먼저다 — 코드가 현장에 물리적으로 나가 있으면 참조가 0이어도 잠근다(계약).
  if (labelIssueCount > 0) {
    return { codeEditable: false, reason: 'LABEL_ISSUED', referenceCount };
  }
  return {
    codeEditable: referenceCount === 0,
    reason: referenceCount === 0 ? 'EDITABLE' : 'REFERENCED',
    referenceCount,
  };
}

function codeLocked(current: MoldResult): ContractException {
  const because =
    current.editability.reason === 'LABEL_ISSUED'
      ? `라벨이 ${current.labelIssueCount}회 발행돼 현장에 나가 있어`
      : `이 툴을 가리키는 행이 ${current.editability.referenceCount}건 있어`;
  return new ContractException(HttpStatus.BAD_REQUEST, [
    {
      scope: 'field',
      field: 'moldCode',
      code: ERROR_CODE.STATE_LOCKED,
      message: `${because} 코드를 바꿀 수 없습니다.`,
    },
  ]);
}

/** 질의 문자열은 불리언이 아니다 — 전역 변환 파이프가 없어 여기서 가른다. */
function bool(value: boolean | string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/** 「폐기된 뒤에는 다시 불러와도 편집이 풀리지 않는다」(계약 · B-16). */
function assertNotDisposed(statusCode: string): void {
  if (statusCode !== DISPOSED) return;
  // ⛔ 400 이다 — 계약이 이 오퍼레이션의 409 설명에 「업무 규칙 위반(상태 잠김·참조
  // 존재)은 409 가 아니라 400 이다」로 적었다. 409 는 저장 충돌 전용이다.
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    {
      scope: 'screen',
      // ⛔ 재로드해도 풀리지 않는다 — 저장 충돌과 구분한다(G-1).
      code: ERROR_CODE.STATE_LOCKED,
      message: '폐기한 툴은 수정할 수 없습니다.',
    },
  ]);
}

function failure(row: ImportRow, errors: ErrorItem[]): BatchFailure {
  return { index: row.index, key: row.values.moldCode, errors };
}

/**
 * 어느 공장의 툴인가. 대장에 공장 열이 있으면 그것으로 찾고, **없으면 공장이 하나일
 * 때만** 그 하나로 본다.
 *
 * ⚠ 계약의 올리기 경로에 공장을 받는 자리가 없는데 `MoldCreate` 는 공장을 필수로
 * 받는다 — 열이 확정되면 다시 본다(되돌림 §P-3).
 */
function resolvePlant(
  row: ImportRow,
  plants: readonly { plant_id: bigint; plant_code: string }[],
): number | null {
  if (row.plantCode === null) {
    return plants.length === 1 ? Number(plants[0].plant_id) : null;
  }
  const found = plants.find((plant) => plant.plant_code === row.plantCode);
  return found === undefined ? null : Number(found.plant_id);
}

function plantNotResolved(plantCode: string | null): ErrorItem {
  return {
    scope: 'field',
    field: 'plantId',
    code: plantCode === null ? ERROR_CODE.REQUIRED : ERROR_CODE.INVALID,
    message:
      plantCode === null
        ? '공장 열이 없고 공장이 여럿이라 어느 공장인지 정할 수 없습니다.'
        : `없는 공장 코드입니다: ${plantCode}`,
  };
}

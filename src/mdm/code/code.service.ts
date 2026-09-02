import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { Editability, ReferenceQuery, filter, optional, optionalDate, referencePage, referenceWhere, toDateString } from '../../common/master';

/** 계약 `CodeGroup`·`CodeValue` 와 동형. 필드는 `x-source-column` 을 그대로 따른다. */
interface CodeGroupView {
  codeGroupId: number;
  groupCode: string;
  groupName: string;
  description: string | null;
  isActive: boolean;
}

interface CodeValueView {
  codeValueId: number;
  codeGroupId: number;
  code: string;
  codeName: string;
  nameKo: string | null;
  nameVi: string | null;
  displayOrder: number;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  isActive: boolean;
}

type CodeGroupRow = Prisma.code_groupGetPayload<object>;
type CodeValueRow = Prisma.code_valueGetPayload<object>;

@Injectable()
export class CodeService {
  constructor(private readonly prisma: PrismaService) {}

  // ── 코드 그룹 ────────────────────────────────────────────────────────────

  async listGroups(query: ReferenceQuery): Promise<PagedResponse<CodeGroupView>> {
    const page = referencePage(query);
    const where = referenceWhere(query, { code: 'group_code', name: 'group_name' });
    const [rows, total] = await Promise.all([
      this.prisma.code_group.findMany({
        where,
        orderBy: { group_code: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.code_group.count({ where }),
    ]);
    return pagedResponse(rows.map(this.groupView), total, page);
  }

  async getGroup(
    codeGroupId: number,
  ): Promise<{ codeGroup: CodeGroupView; editability: Editability; versionNo: number }> {
    const row = await this.prisma.code_group.findUnique({ where: { code_group_id: codeGroupId } });
    if (!row) throw new NotFoundException('없는 코드 그룹입니다.');

    return {
      codeGroup: this.groupView(row),
      editability: this.groupEditability(row),
      versionNo: row.version_no,
    };
  }

  /**
   * ⛔ 그룹도 «셀 수 없다». `code_value.code_group_id` 가 FK 로 걸려 있어 세는 것 자체는
   * 되지만, 그것은 «그룹에 값이 몇 개인가»이지 «그룹 코드 «글자»를 쓰는 곳이 어딘가»가
   * 아니다. 잠금이 물어야 할 것은 뒤쪽이다.
   *
   * 그리고 그 글자를 쓰는 곳은 세지 못한다 — 계약 자신이 151곳에서
   * `GET /mdm/code-values?codeGroupCode=LOT_STATUS` 처럼 «리터럴로» 지시한다(실측).
   * 화면 소스에 박히는 문자열이라 DB 에서 셀 방법이 없다. 값이 0개인 그룹이라도 코드를
   * 바꾸면 그 호출들이 전부 빈 목록을 받는다 — 조용히.
   */
  private groupEditability(row: CodeGroupRow): Editability {
    if (row.is_system_owned) {
      return { codeEditable: false, reason: 'SYSTEM_OWNED', referenceCount: null };
    }
    return { codeEditable: false, reason: 'NOT_COUNTABLE', referenceCount: null };
  }

  /**
   * ⛔ 코드 «값»의 참조는 셀 수 없다 — 174표를 통틀어 `mdm.code_value` 를 가리키는 FK 가
   * 하나도 없고, 업무 표들은 코드 «문자열»을 들고 있다(실측). 계약이 그 경우를
   * `NOT_COUNTABLE` 로 정의했고 「화면은 무조건 잠근다」로 못박았다.
   */
  private valueEditability(groupIsSystemOwned: boolean): Editability {
    if (groupIsSystemOwned) {
      return { codeEditable: false, reason: 'SYSTEM_OWNED', referenceCount: null };
    }
    return { codeEditable: false, reason: 'NOT_COUNTABLE', referenceCount: null };
  }

  async createGroup(input: {
    groupCode: string;
    groupName: string;
    description?: string | null;
  }): Promise<CodeGroupView> {
    return this.groupView(
      await this.prisma.code_group.create({
        data: {
          group_code: input.groupCode,
          group_name: input.groupName,
          ...(input.description === undefined ? {} : { description: input.description }),
        },
      }),
    );
  }

  async updateGroup(
    codeGroupId: number,
    version: number,
    input: { groupCode: string; groupName: string; description?: string | null },
  ): Promise<{ codeGroup: CodeGroupView; editability: Editability; versionNo: number }> {
    const updated = await this.prisma.code_group.updateMany({
      // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
      where: { code_group_id: codeGroupId, version_no: version },
      data: {
        group_code: input.groupCode,
        group_name: input.groupName,
        ...(input.description === undefined ? {} : { description: input.description }),
        version_no: { increment: 1 },
      },
    });
    await this.assertExists(codeGroupId, updated.count);
    return this.getGroup(codeGroupId);
  }

  async setGroupActive(
    codeGroupId: number,
    version: number,
    isActive: boolean,
  ): Promise<{ codeGroup: CodeGroupView; editability: Editability; versionNo: number }> {
    // ⛔ 시스템 소유 그룹은 고객이 내릴 수 없다 — 앱이 그 값에 동작을 걸고 있다.
    const existing = await this.prisma.code_group.findUnique({
      where: { code_group_id: codeGroupId },
      select: { is_system_owned: true },
    });
    if (!existing) throw new NotFoundException('없는 코드 그룹입니다.');
    if (existing.is_system_owned && !isActive) {
      throw new ContractException(HttpStatus.CONFLICT, [
        {
          scope: 'screen',
          code: ERROR_CODE.STATE_LOCKED,
          message: '시스템이 쓰는 코드 그룹은 사용 중지할 수 없습니다.',
        },
      ]);
    }

    const updated = await this.prisma.code_group.updateMany({
      where: { code_group_id: codeGroupId, version_no: version },
      data: { is_active: isActive, version_no: { increment: 1 } },
    });
    await this.assertExists(codeGroupId, updated.count);
    return this.getGroup(codeGroupId);
  }

  // ── 코드 값 ──────────────────────────────────────────────────────────────

  async listValues(
    query: ReferenceQuery & { codeGroupId?: number; codeGroupCode?: string },
  ): Promise<PagedResponse<CodeValueView>> {
    const page = referencePage(query);
    const where = referenceWhere(query, { code: 'code', name: 'code_name' }, {
      ...filter('code_group_id', query.codeGroupId),
      // 화면은 그룹 «이름»으로 부른다 — 채번 식별자를 알 수 없다(공유계약 G-32).
      ...(query.codeGroupCode === undefined
        ? {}
        : { code_group: { group_code: query.codeGroupCode } }),
    });
    const [rows, total] = await Promise.all([
      this.prisma.code_value.findMany({
        where,
        orderBy: [{ display_order: 'asc' }, { code: 'asc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.code_value.count({ where }),
    ]);
    return pagedResponse(rows.map(this.valueView), total, page);
  }

  async getValue(
    codeValueId: number,
  ): Promise<{ codeValue: CodeValueView; editability: Editability; versionNo: number }> {
    const row = await this.prisma.code_value.findUnique({
      where: { code_value_id: codeValueId },
      include: { code_group: { select: { is_system_owned: true } } },
    });
    if (!row) throw new NotFoundException('없는 코드 값입니다.');

    return {
      codeValue: this.valueView(row),
      editability: this.valueEditability(row.code_group.is_system_owned),
      versionNo: row.version_no,
    };
  }

  async createValue(input: {
    codeGroupId: number;
    code: string;
    codeName: string;
    nameKo?: string | null;
    nameVi?: string | null;
    displayOrder?: number;
    effectiveFrom?: string | null;
    effectiveTo?: string | null;
  }): Promise<CodeValueView> {
    return this.valueView(
      await this.prisma.code_value.create({
        data: {
          code_group_id: input.codeGroupId,
          code: input.code,
          code_name: input.codeName,
          ...optional('name_ko', input.nameKo),
          ...optional('name_vi', input.nameVi),
          ...(input.displayOrder === undefined ? {} : { display_order: input.displayOrder }),
          ...optionalDate('effective_from', input.effectiveFrom),
          ...optionalDate('effective_to', input.effectiveTo),
        },
      }),
    );
  }

  async updateValue(
    codeValueId: number,
    version: number,
    input: {
      code: string;
      codeName: string;
      nameKo?: string | null;
      nameVi?: string | null;
      displayOrder: number;
      effectiveFrom?: string | null;
      effectiveTo?: string | null;
    },
  ): Promise<{ codeValue: CodeValueView; editability: Editability; versionNo: number }> {
    const updated = await this.prisma.code_value.updateMany({
      where: { code_value_id: codeValueId, version_no: version },
      data: {
        code: input.code,
        code_name: input.codeName,
        display_order: input.displayOrder,
        ...optional('name_ko', input.nameKo),
        ...optional('name_vi', input.nameVi),
        ...optionalDate('effective_from', input.effectiveFrom),
        ...optionalDate('effective_to', input.effectiveTo),
        version_no: { increment: 1 },
      },
    });
    await this.assertValueExists(codeValueId, updated.count);
    return this.getValue(codeValueId);
  }

  async setValueActive(
    codeValueId: number,
    version: number,
    isActive: boolean,
  ): Promise<{ codeValue: CodeValueView; editability: Editability; versionNo: number }> {
    const updated = await this.prisma.code_value.updateMany({
      where: { code_value_id: codeValueId, version_no: version },
      data: { is_active: isActive, version_no: { increment: 1 } },
    });
    await this.assertValueExists(codeValueId, updated.count);
    return this.getValue(codeValueId);
  }

  // ── 공통 ────────────────────────────────────────────────────────────────

  /**
   * 0행일 때 「없다(404)」와 「그 사이 바뀌었다(409)」를 가른다 —
   * 조건에 `version_no` 가 들어가므로 둘이 같은 결과를 낸다.
   */
  private async assertExists(codeGroupId: number, count: number): Promise<void> {
    if (count > 0) return;
    const exists = await this.prisma.code_group.findUnique({
      where: { code_group_id: codeGroupId },
      select: { code_group_id: true },
    });
    if (!exists) throw new NotFoundException('없는 코드 그룹입니다.');
    assertUpdated(0);
  }

  private async assertValueExists(codeValueId: number, count: number): Promise<void> {
    if (count > 0) return;
    const exists = await this.prisma.code_value.findUnique({
      where: { code_value_id: codeValueId },
      select: { code_value_id: true },
    });
    if (!exists) throw new NotFoundException('없는 코드 값입니다.');
    assertUpdated(0);
  }

  private groupView = (row: CodeGroupRow): CodeGroupView => ({
    codeGroupId: Number(row.code_group_id),
    groupCode: row.group_code,
    groupName: row.group_name,
    description: row.description,
    isActive: row.is_active,
  });

  private valueView = (row: CodeValueRow): CodeValueView => ({
    codeValueId: Number(row.code_value_id),
    codeGroupId: Number(row.code_group_id),
    code: row.code,
    codeName: row.code_name,
    nameKo: row.name_ko,
    nameVi: row.name_vi,
    displayOrder: row.display_order,
    effectiveFrom: toDateString(row.effective_from),
    effectiveTo: toDateString(row.effective_to),
    isActive: row.is_active,
  });
}



import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';
import { PrismaService } from '../../prisma/prisma.service';
import { assertDetectedPeriodRequired, detectedAtWhere } from './defect-view';

export type DefectDistributionGroupBy = 'defectCode' | 'occurrenceProcess' | 'detectionProcess';

export interface DefectDistributionQuery {
  groupBy?: DefectDistributionGroupBy;
  sourceCode?: string;
  itemId?: number;
  detectedFrom?: string;
  detectedTo?: string;
}

export interface DistributionNode {
  defectCodeId: number;
  parentDefectCodeId?: number;
  label: string;
  recordCount: number;
  defectQty: number;
  share?: number;
  duplicateRisk: boolean;
}

/**
 * 불량코드 분포 — `groupBy` 기본은 `occurrenceProcess`(계약 설명 「이렇게 묶어야 개선 대상이
 * 나온다」). enum 3값 밖은 계약이 이미 선언해 **ajv 가 400 INVALID 를 낸다** — 서비스에서
 * 다시 검증하지 않는다(R-19 · 중복 구현 금지).
 *
 * ⭐ R-14 — `DefectDistributionNode` 는 공정 칸이 0개이고 `defectCodeId` 가 required 다.
 * 공정 축(기본값)의 «부모 노드»는 공정이라 required 를 채울 defectCodeId 가 없다 — 계약으로
 * 만들 수 없는 모양이다(§2 1-1 — 본질 아님 ⇒ 통보). 판정: **부모(공정) 노드를 `nodes` 에 넣지
 * 않고 결함코드 자식만 평평히 낸다**(§4-4 ⓐ) — ⓑ(부모 defectCodeId 에 공정 id)는 뜻이 바뀌어
 * 탈락, ⓒ(required 위반)보다 계약을 100% 지키는 이쪽이 §2 2단계 기준 4(값을 지어내지 않는다)에
 * 더 가깝다. 공정 맥락은 `label` 에 `"{공정명} · {결함명}"` 으로 묶어 남긴다.
 * `defectCode` 축은 `defect_code.parent_defect_code_id` 가 실물 2계층이라 부모·자식을 그대로 낸다.
 * // 결정 — 통보 082
 */
@Injectable()
export class DefectDistributionService {
  constructor(private readonly prisma: PrismaService) {}

  async distribution(query: DefectDistributionQuery): Promise<{ nodes: DistributionNode[]; groupBy: string; asOf: string }> {
    assertDetectedPeriodRequired(query);
    const groupBy = query.groupBy ?? 'occurrenceProcess';
    const where = buildDistributionWhere(query);

    const nodes = groupBy === 'defectCode' ? await this.byDefectCode(where) : await this.byProcess(where, groupBy);
    // ⭐ PR #355 리뷰 Minor 1 — PG 의 GROUP BY 반환 순서는 보장되지 않는다. defectQty desc + id 로 동률을 깬다.
    nodes.sort((a, b) => b.defectQty - a.defectQty || a.defectCodeId - b.defectCodeId);
    return { nodes: nodes.map(omitEmpty), groupBy, asOf: new Date().toISOString() };
  }

  /** `defect_code.parent_defect_code_id` 로 2계층 — 부모(대분류) 롤업 + 자식(상세) 실측. */
  private async byDefectCode(where: Prisma.defect_recordWhereInput): Promise<DistributionNode[]> {
    const grouped = await this.prisma.defect_record.groupBy({
      by: ['defect_code_id'],
      where,
      _count: { defect_record_id: true },
      _sum: { defect_qty: true },
    });
    if (grouped.length === 0) return [];

    const codes = await this.prisma.defect_code.findMany({
      where: { defect_code_id: { in: grouped.map((g) => g.defect_code_id) } },
      select: { defect_code_id: true, defect_name: true, parent_defect_code_id: true },
    });
    const codeById = new Map(codes.map((c) => [c.defect_code_id.toString(), c]));
    const parentIds = [...new Set(codes.map((c) => c.parent_defect_code_id).filter((id): id is bigint => id !== null))];
    const parents =
      parentIds.length === 0
        ? []
        : await this.prisma.defect_code.findMany({ where: { defect_code_id: { in: parentIds } }, select: { defect_code_id: true, defect_name: true } });
    const parentById = new Map(parents.map((p) => [p.defect_code_id.toString(), p.defect_name]));

    const totalQty = grouped.reduce((sum, g) => sum + Number(g._sum.defect_qty ?? 0), 0);
    const parentAgg = new Map<string, { recordCount: number; defectQty: number }>();
    const children: DistributionNode[] = [];
    for (const g of grouped) {
      // codeById 는 grouped 와 같은 id 집합으로 조회했으니 항상 있다 — FK 로 없는 결함코드는
      // defect_record 에 못 실린다. 그래도 단언(`!`) 대신 방어적 기본값으로 좁힌다.
      const code = codeById.get(g.defect_code_id.toString()) ?? { defect_code_id: g.defect_code_id, defect_name: g.defect_code_id.toString(), parent_defect_code_id: null };
      const recordCount = g._count.defect_record_id;
      const defectQty = Number(g._sum.defect_qty ?? 0);
      const parentId = code.parent_defect_code_id === null ? undefined : Number(code.parent_defect_code_id);
      if (parentId !== undefined) {
        // 자식 행 — 부모 롤업에 누적하고 자식 노드로도 낸다(2계층).
        const agg = parentAgg.get(String(parentId)) ?? { recordCount: 0, defectQty: 0 };
        parentAgg.set(String(parentId), { recordCount: agg.recordCount + recordCount, defectQty: agg.defectQty + defectQty });
        // groupBy=defectCode 는 공정 축이 아니라 duplicateRisk 는 언제나 false(§4-4).
        children.push({ defectCodeId: Number(code.defect_code_id), parentDefectCodeId: parentId, label: code.defect_name, recordCount, defectQty, share: shareOf(defectQty, totalQty), duplicateRisk: false });
      } else {
        // ⭐ PR #355 리뷰 Major 1 — 부모 코드 자신에 «직접» 달린 행은 잎 노드를 만들지 않고 그
        // 부모(자기 자신) 롤업에 합친다 — 안 그러면 같은 defectCodeId 노드가 둘(롤업+잎) 생긴다.
        const own = String(code.defect_code_id);
        const agg = parentAgg.get(own) ?? { recordCount: 0, defectQty: 0 };
        parentAgg.set(own, { recordCount: agg.recordCount + recordCount, defectQty: agg.defectQty + defectQty });
      }
    }
    const parentNodes: DistributionNode[] = [...parentAgg.entries()].map(([id, agg]) => ({
      defectCodeId: Number(id),
      // 부모 코드 자신에 직행 행이 있으면 codeById 에 그 이름이 있다 — 순수 롤업(직행 행이
      // 없는 부모)만 parentById 로 떨어진다.
      label: codeById.get(id)?.defect_name ?? parentById.get(id) ?? id,
      recordCount: agg.recordCount,
      defectQty: agg.defectQty,
      share: shareOf(agg.defectQty, totalQty),
      duplicateRisk: false,
    }));
    return [...parentNodes, ...children];
  }

  /** 공정 축 — R-14 ⓐ. 부모(공정) 노드는 없다 · (공정,결함코드) 쌍마다 자식 노드 하나. */
  private async byProcess(where: Prisma.defect_recordWhereInput, groupBy: DefectDistributionGroupBy): Promise<DistributionNode[]> {
    const column = groupBy === 'detectionProcess' ? 'detection_process_id' : 'occurrence_process_id';
    // ⭐ PR #355 리뷰 Minor 3 — 그룹 컬럼 하나만 다른 두 갈래를 줄바꿈해 눈으로 대조되게 한다.
    const grouped =
      column === 'detection_process_id'
        ? (
            await this.prisma.defect_record.groupBy({ by: ['detection_process_id', 'defect_code_id'], where, _count: { defect_record_id: true }, _sum: { defect_qty: true } })
          ).map((g) => ({ processId: g.detection_process_id, defectCodeId: g.defect_code_id, count: g._count.defect_record_id, qty: g._sum.defect_qty }))
        : (
            await this.prisma.defect_record.groupBy({ by: ['occurrence_process_id', 'defect_code_id'], where, _count: { defect_record_id: true }, _sum: { defect_qty: true } })
          ).map((g) => ({ processId: g.occurrence_process_id, defectCodeId: g.defect_code_id, count: g._count.defect_record_id, qty: g._sum.defect_qty }));
    if (grouped.length === 0) return [];

    const processIds = [...new Set(grouped.map((g) => g.processId))];
    const codeIds = [...new Set(grouped.map((g) => g.defectCodeId))];
    const [processes, codes, mappings] = await Promise.all([
      this.prisma.process.findMany({ where: { process_id: { in: processIds } }, select: { process_id: true, process_name: true } }),
      this.prisma.defect_code.findMany({ where: { defect_code_id: { in: codeIds } }, select: { defect_code_id: true, defect_name: true } }),
      // 「같은 결함코드가 공정 둘 이상에 매인 노드」— defect_code_process(N:M) 실측(결정 12).
      this.prisma.defect_code_process.groupBy({ by: ['defect_code_id'], where: { defect_code_id: { in: codeIds } }, _count: { defect_code_process_id: true } }),
    ]);
    const processNameById = new Map(processes.map((p) => [p.process_id.toString(), p.process_name]));
    const codeNameById = new Map(codes.map((c) => [c.defect_code_id.toString(), c.defect_name]));
    const mappingCountById = new Map(mappings.map((m) => [m.defect_code_id.toString(), m._count.defect_code_process_id]));

    const totalQty = grouped.reduce((sum, g) => sum + Number(g.qty ?? 0), 0);
    return grouped.map((g) => {
      const defectQty = Number(g.qty ?? 0);
      const codeLabel = codeNameById.get(g.defectCodeId.toString()) ?? g.defectCodeId.toString();
      const processLabel = processNameById.get(g.processId.toString()) ?? g.processId.toString();
      return {
        defectCodeId: Number(g.defectCodeId),
        label: `${processLabel} · ${codeLabel}`,
        recordCount: g.count,
        defectQty,
        share: shareOf(defectQty, totalQty),
        duplicateRisk: (mappingCountById.get(g.defectCodeId.toString()) ?? 0) >= 2,
      };
    });
  }
}

function buildDistributionWhere(query: DefectDistributionQuery): Prisma.defect_recordWhereInput {
  return {
    ...(query.sourceCode === undefined ? {} : { source_type_code: query.sourceCode }),
    // itemId 는 defect_record 에 직접 칸이 없다 — LOT 이 품목의 유일한 직접 축이라 lot.item_id
    // 로 판정한다(lot_id 가 없는 행은 이 필터가 오면 자연히 빠진다).
    ...(query.itemId === undefined ? {} : { lot: { item_id: query.itemId } }),
    ...detectedAtWhere(query.detectedFrom as string, query.detectedTo as string),
  };
}

// ⭐ PR #355 리뷰 Major 2(M3) — `total === 0` 분기를 걷어냈다. `defect_qty CHECK(> 0)`(baseline
// `20260727000000/migration.sql:1942`)상 grouped 가 비면 이미 `[]`로 빠져 도달 불가능한 죽은 분기였다.
function shareOf(qty: number, total: number): number {
  return (qty / total) * 100;
}

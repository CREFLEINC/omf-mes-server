export interface EffectiveAssignmentSource<T> {
  readEquipmentAssignments(): Promise<T[]>;
  readGroupAssignments(groupId: bigint): Promise<T[]>;
  readParentGroupId(groupId: bigint): Promise<bigint | null>;
}

export interface EffectiveAssignmentResolution<T> {
  assignments: T[];
  levelCode: 'EQUIPMENT' | 'EQUIPMENT_GROUP' | 'NONE';
  groupId: bigint | null;
  /** 빈 중간층을 포함해 실제로 탐색한 순서다. 직접 부여를 고르면 비어 있다. */
  groupPath: bigint[];
}

/** 직접 부여가 있으면 그 층, 아니면 가장 가까운 조상 중 처음 부여가 있는 층을 고른다. */
export async function resolveEffectiveAssignments<T>(
  initialGroupId: bigint | null,
  source: EffectiveAssignmentSource<T>,
): Promise<EffectiveAssignmentResolution<T>> {
  const direct = await source.readEquipmentAssignments();
  if (direct.length > 0) {
    return {
      assignments: direct,
      levelCode: 'EQUIPMENT',
      groupId: null,
      groupPath: [],
    };
  }

  const groupPath: bigint[] = [];
  const seen = new Set<bigint>();
  let groupId = initialGroupId;
  while (groupId !== null && !seen.has(groupId)) {
    seen.add(groupId);
    groupPath.push(groupId);
    const assignments = await source.readGroupAssignments(groupId);
    if (assignments.length > 0) {
      return {
        assignments,
        levelCode: 'EQUIPMENT_GROUP',
        groupId,
        groupPath,
      };
    }
    groupId = await source.readParentGroupId(groupId);
  }

  return { assignments: [], levelCode: 'NONE', groupId: null, groupPath };
}

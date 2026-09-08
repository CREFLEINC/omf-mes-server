import { EffectiveAssignmentSource, resolveEffectiveAssignments } from './effective-assignment';

interface Assignment {
  id: number;
  active: boolean;
}

function source(input: {
  direct?: Assignment[];
  groups?: Map<bigint, Assignment[]>;
  parents?: Map<bigint, bigint | null>;
}): EffectiveAssignmentSource<Assignment> & {
  readGroupAssignments: jest.Mock;
  readParentGroupId: jest.Mock;
} {
  return {
    readEquipmentAssignments: jest.fn(async () => input.direct ?? []),
    readGroupAssignments: jest.fn(async (groupId: bigint) => input.groups?.get(groupId) ?? []),
    readParentGroupId: jest.fn(async (groupId: bigint) => input.parents?.get(groupId) ?? null),
  };
}

describe('유효 설비 점검항목 부여층', () => {
  it('직접 부여가 있으면 그룹을 읽지 않는다', async () => {
    const reader = source({ direct: [{ id: 1, active: true }] });

    await expect(resolveEffectiveAssignments(10n, reader)).resolves.toEqual({
      assignments: [{ id: 1, active: true }],
      levelCode: 'EQUIPMENT',
      groupId: null,
      groupPath: [],
    });
    expect(reader.readGroupAssignments).not.toHaveBeenCalled();
    expect(reader.readParentGroupId).not.toHaveBeenCalled();
  });

  it('비활성 직접 부여만 있어도 그 층을 선택하고 상위로 우회하지 않는다', async () => {
    const reader = source({
      direct: [{ id: 1, active: false }],
      groups: new Map([[10n, [{ id: 2, active: true }]]]),
    });

    const resolved = await resolveEffectiveAssignments(10n, reader);

    expect(resolved).toMatchObject({ levelCode: 'EQUIPMENT', assignments: [{ id: 1 }] });
    expect(reader.readGroupAssignments).not.toHaveBeenCalled();
  });

  it('빈 중간층을 지나 가장 가까운 부여층과 전체 탐색 경로를 반환한다', async () => {
    const reader = source({
      groups: new Map([
        [10n, []],
        [20n, [{ id: 2, active: true }]],
        [30n, [{ id: 3, active: true }]],
      ]),
      parents: new Map([
        [10n, 20n],
        [20n, 30n],
      ]),
    });

    await expect(resolveEffectiveAssignments(10n, reader)).resolves.toEqual({
      assignments: [{ id: 2, active: true }],
      levelCode: 'EQUIPMENT_GROUP',
      groupId: 20n,
      groupPath: [10n, 20n],
    });
    expect(reader.readGroupAssignments).toHaveBeenCalledTimes(2);
  });

  it('부여가 없거나 그룹 순환이면 같은 그룹을 반복하지 않고 NONE을 반환한다', async () => {
    const reader = source({
      parents: new Map([
        [10n, 20n],
        [20n, 10n],
      ]),
    });

    await expect(resolveEffectiveAssignments(10n, reader)).resolves.toEqual({
      assignments: [],
      levelCode: 'NONE',
      groupId: null,
      groupPath: [10n, 20n],
    });
    expect(reader.readGroupAssignments).toHaveBeenCalledTimes(2);
  });
});

import { PrismaService } from '../../prisma/prisma.service';

/**
 * 승인 대상의 사람이 읽는 이름(계약 `ApprovalTarget.displayName` 「사람이 읽는 대상 이름. 서버가 만든다」).
 *
 * ⚠ 특채(부적합)만 이름을 찾는다 — 나머지 유형은 등록부에 표시명 칸이 없어(문의 021) 「코드 #id」로 남는다.
 * 형식은 계약 예시(「기타 출고 · 문서 #4412」)를 따라 「업무 이름 · 번호」다.
 */
const LABEL: Readonly<Record<string, string>> = {
  NONCONFORMANCE: '부적합',
};

interface TargetRef {
  target_type_code: string;
  target_id: bigint;
}

export const targetKey = (typeCode: string, id: bigint): string => `${typeCode}:${id}`;

export interface ApprovalTargetInfo {
  name: string;
}

/** 목록 한 쪽의 대상 이름을 유형별로 한 번씩 모아 찾는다. 못 찾은 대상은 맵에 없다. */
export async function approvalTargetNames(prisma: PrismaService, refs: readonly TargetRef[]): Promise<Map<string, ApprovalTargetInfo>> {
  const idsOf = (typeCode: string): bigint[] => [
    ...new Set(refs.filter((ref) => ref.target_type_code === typeCode).map((ref) => ref.target_id)),
  ];
  const ncIds = idsOf('NONCONFORMANCE');
  const ncs = ncIds.length === 0
    ? []
    : await prisma.nonconformance.findMany({ where: { nonconformance_id: { in: ncIds } }, select: { nonconformance_id: true, nonconformance_no: true } });

  const names = new Map<string, ApprovalTargetInfo>();
  for (const nc of ncs) names.set(targetKey('NONCONFORMANCE', nc.nonconformance_id), { name: `${LABEL.NONCONFORMANCE} · ${nc.nonconformance_no}` });
  return names;
}

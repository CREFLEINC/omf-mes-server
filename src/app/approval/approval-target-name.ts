import { PrismaService } from '../../prisma/prisma.service';

/**
 * 승인 대상의 사람이 읽는 이름(계약 `ApprovalTarget.displayName` 「사람이 읽는 대상 이름. 서버가 만든다」).
 *
 * ⚠ 품질 승인 세 유형만 이름을 찾는다 — IQC 생략(입하 LOT) · 특채(부적합) · OQC 생략(출하지시).
 *   나머지 유형은 등록부에 표시명 칸이 없어(문의 021) 「코드 #id」로 남는다.
 * 형식은 계약 예시(「기타 출고 · 문서 #4412」)를 따라 「업무 이름 · 번호」다.
 */
const LABEL: Readonly<Record<string, string>> = {
  INBOUND_LOT: '입하 LOT',
  NONCONFORMANCE: '부적합',
  SHIPMENT_REQUEST: '출하지시',
};

interface TargetRef {
  target_type_code: string;
  target_id: bigint;
}

export const targetKey = (typeCode: string, id: bigint): string => `${typeCode}:${id}`;

/** 목록 한 쪽의 대상 이름을 유형별로 한 번씩 모아 찾는다. 못 찾은 대상은 맵에 없다. */
export async function approvalTargetNames(prisma: PrismaService, refs: readonly TargetRef[]): Promise<Map<string, string>> {
  const idsOf = (typeCode: string): bigint[] => [
    ...new Set(refs.filter((ref) => ref.target_type_code === typeCode).map((ref) => ref.target_id)),
  ];
  const lotIds = idsOf('INBOUND_LOT');
  const ncIds = idsOf('NONCONFORMANCE');
  const srIds = idsOf('SHIPMENT_REQUEST');
  const [lots, ncs, srs] = await Promise.all([
    lotIds.length === 0 ? [] : prisma.lot.findMany({ where: { lot_id: { in: lotIds } }, select: { lot_id: true, lot_no: true } }),
    ncIds.length === 0
      ? []
      : prisma.nonconformance.findMany({ where: { nonconformance_id: { in: ncIds } }, select: { nonconformance_id: true, nonconformance_no: true } }),
    srIds.length === 0
      ? []
      : prisma.shipment_request.findMany({ where: { shipment_request_id: { in: srIds } }, select: { shipment_request_id: true, shipment_request_no: true } }),
  ]);

  const names = new Map<string, string>();
  for (const lot of lots) names.set(targetKey('INBOUND_LOT', lot.lot_id), `${LABEL.INBOUND_LOT} · ${lot.lot_no}`);
  for (const nc of ncs) names.set(targetKey('NONCONFORMANCE', nc.nonconformance_id), `${LABEL.NONCONFORMANCE} · ${nc.nonconformance_no}`);
  for (const sr of srs) {
    names.set(targetKey('SHIPMENT_REQUEST', sr.shipment_request_id), `${LABEL.SHIPMENT_REQUEST} · ${sr.shipment_request_no}`);
  }
  return names;
}

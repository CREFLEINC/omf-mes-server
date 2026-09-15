import { Prisma } from '@prisma/client';

/**
 * 자재 피킹 출고의 **도착 위치를 서버가 푼다**(P-15).
 *
 * 모바일 `M-01-08` 은 도착지를 «일부러» 비운다 — 「이 화면에는 그 위치를 받을 경로가 없다.
 * 지어낸 값을 실으면 엉뚱한 자리로 나간 것으로 기록된다」(클라이언트 주석). 화면이 모르는
 * 값을 서버는 안다: 피킹 지시 → 자재 출고요청 → `destination_location_id`(NOT NULL).
 * 채우지 않으면 원장에 `to` 가 안 실려 자재가 창고에서 «나가기만» 하고 WIP 에 안 들어온다
 * (`issue-posting.ts` `destinationAxis`).
 *
 * ⛔ 세 자리에서 멈춘다 — 넓히면 자체 폐기·공급사 반품·출하가 도착지를 갖게 된다.
 */

const DESTINATION_LOCATION = 'LOCATION';
/** 출고 헤더의 원천 — 이 값일 때만 피킹 지시를 거쳐 도착지를 푼다. */
const SOURCE_PICKING_ORDER = 'PICKING_ORDER';
/** 피킹 지시의 원천 — 출하 피킹(`SHIPMENT_REQUEST`)은 고객에게 나가므로 도착 «위치»가 없다. */
const PICKING_SOURCE_MATERIAL_ISSUE_REQUEST = 'MATERIAL_ISSUE_REQUEST';

export interface IssueDestinationInput {
  sourceDocumentTypeCode: string;
  sourceDocumentId: number | bigint;
  destinationTypeCode?: string | null;
  destinationId?: number | bigint | null;
  lines: readonly { sourceLocationId: number | bigint }[];
}

export interface IssueDestination {
  typeCode: string | null;
  id: bigint | null;
}

/**
 * 채울 값이 없으면 받은 짝을 그대로 돌려준다 — 「비었다」도 유효한 값이다(자체 폐기).
 */
export async function resolveIssueDestination(
  tx: Prisma.TransactionClient,
  input: IssueDestinationInput,
): Promise<IssueDestination> {
  const given: IssueDestination = {
    typeCode: input.destinationTypeCode ?? null,
    id: input.destinationId == null ? null : BigInt(input.destinationId),
  };
  // ⛔ 화면이 채운 도착지는 덮지 않는다 — 비어 있을 때만 서버가 푼다.
  if (given.typeCode !== null || given.id !== null) return given;
  if (input.sourceDocumentTypeCode !== SOURCE_PICKING_ORDER) return given;

  const order = await tx.picking_order.findUnique({
    where: { picking_order_id: BigInt(input.sourceDocumentId) },
    select: { source_document_type_code: true, source_document_id: true },
  });
  if (order === null || order.source_document_type_code !== PICKING_SOURCE_MATERIAL_ISSUE_REQUEST) {
    return given;
  }
  const request = await tx.material_issue_request.findUnique({
    where: { material_issue_request_id: order.source_document_id },
    select: { destination_location_id: true },
  });
  if (request === null) return given;

  // ⛔ 출발 == 도착이면 채우지 않는다 — 같은 자리에서 나갔다 들어온 원장이 되고 순변화가 0 이다.
  //    라인이 전부 그 위치에 있을 때만 「움직이지 않는다」가 참이다.
  const stays = input.lines.every(
    (line) => BigInt(line.sourceLocationId) === request.destination_location_id,
  );
  if (input.lines.length === 0 || stays) return given;

  return { typeCode: DESTINATION_LOCATION, id: request.destination_location_id };
}

/** 원장 라인의 한쪽 끝. 잔량 차원 키(`uq_inventory_balance_dim`)와 같은 축이다. */
export interface PostingEndpoint {
  warehouseId: number;
  locationId: number;
  qualityStatusCode: string;
  inventoryStatusCode: string;
}

export interface PostingLine {
  itemId: number;
  lotId?: number;
  qty: number;
  uomId: number;
  /** 없으면 입고다. */
  from?: PostingEndpoint;
  /** 없으면 출고다. */
  to?: PostingEndpoint;
  ownershipTypeCode: string;
  ownerPartnerId?: number;
  handlingUnitId?: number;
}

export interface PostingInput {
  /**
   * ⛔ 클라이언트가 준 값을 그대로 쓴다. 서버가 수신 시각으로 다시 잡지 않는다 —
   * 자정을 넘긴 오프라인 재전송이 `(K, 08-04)`·`(K, 08-05)` 둘 다 통과해 이중 전기가 된다
   * (공유계약 C-8). `YYYY-MM-DD`.
   */
  businessDate: string;
  occurredAt: Date;
  transactionTypeCode: string;
  /**
   * ⚠ 전표 번호는 posting 이 지어내지 않는다 — 채번 규칙이 `PRODUCTION_RESULT` 하나뿐이라
   * 재고 전표 형식이 없다. 채번은 C-6 소관이고, 그때까지 호출자가 준다.
   */
  transactionNo: string;
  statusCode: string;
  plantId: number;
  sourceDocumentTypeCode: string;
  sourceDocumentId: number;
  idempotencyKey: string;
  createdBy?: number;
  lines: PostingLine[];
}

export interface PostingResult {
  inventoryTransactionId: bigint;
  businessDate: string;
  /** 같은 (멱등키, 영업일) 이 이미 있어 새로 만들지 않았다는 뜻. */
  alreadyPosted: boolean;
}

export interface ReverseInput {
  /** 되돌릴 원 트랜잭션. PK 가 복합이라 `businessDate` 가 짝으로 온다. */
  inventoryTransactionId: bigint;
  /**
   * ⛔ 원 트랜잭션의 영업일이다 — «새» 영업일이 아니다. `:cancel` 이 `businessDate` 를
   * 안 받고(계약 실측), 서버가 수신 시각으로 다시 잡지도 않는다(C-8 · CLAUDE.md).
   * `YYYY-MM-DD`.
   */
  businessDate: string;
  /** 역처리가 «언제» 일어났는지는 새 사실이다 — 취소 실행 시각을 호출자가 넘긴다. */
  occurredAt: Date;
  createdBy?: number;
}

export interface ReverseResult {
  /** 새로 만든 역트랜잭션(이미 있었으면 그 행). */
  inventoryTransactionId: bigint;
  transactionNo: string;
  businessDate: string;
  /** 원 트랜잭션을 이미 되돌린 뒤라 새로 만들지 않았다는 뜻. */
  alreadyReversed: boolean;
}

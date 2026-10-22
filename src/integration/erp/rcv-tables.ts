/**
 * ERP 중계 DB(MSSQL `sample_mes`)에서 MES 가 «넣는» 표. 이름의 RCV 는 ERP 쪽에서 본 방향이다.
 *
 * ⛔ 넣기만 한다. 다시 보내기는 IF_SEQ 를 올린 새 행, 취소는 CREATE_TYPE 'C' 행이다
 * (`erp-mock/docs/interface-common-rules.md`).
 */
export interface RcvTable {
  /** `dbo` 아래 표 이름. */
  name: string;
  /** 중계 표 PK — 순서도 그대로다. `relay_key` 가 이 순서로 값을 잇는다. */
  keyColumns: readonly string[];
  /** IF_SEQ 를 세는 단위(건). 이 칸 값이 같은 행끼리 번호를 이어 간다. */
  documentColumns: readonly string[];
  /**
   * 한 번 보낼 때 IF_SEQ 를 매기는 법. 키에 IF_SEQ 말고 건 안의 행을 가를 칸이 없으면 행마다 올리고,
   * 있으면 그 번호 하나를 같이 쓴다.
   */
  ifSeq: 'perRow' | 'perSend';
  /** 넣을 때의 처리 표시. ERP 가 반영하면서 바꾼다. */
  initialFlags: Readonly<Record<string, string>>;
  /** ERP 가 반영을 마치며 'Y' 로 올리는 칸. 오류는 어느 표나 `ERP_APPLY_ERROR` 에 적고 이 칸은 그대로 둔다. */
  appliedFlag: string;
  /** ERP 가 반영하며 돌려 적는 전표번호 칸. */
  replyColumn: string;
}

/** 생산입고. 키에 양품·불량 구분이 없어 양품 한 행과 불량유형마다 한 행이 IF_SEQ 로만 갈린다. */
export const PROD_RSLT: RcvTable = {
  name: 'T_IF_RCV_PROD_RSLT_KO324',
  keyColumns: ['PLANT_CD', 'PRODT_ORDER_NO', 'IF_SEQ', 'CREATE_TYPE'],
  documentColumns: ['PLANT_CD', 'PRODT_ORDER_NO'],
  ifSeq: 'perRow',
  initialFlags: { ERP_APPLY_FLAG: 'N' },
  appliedFlag: 'ERP_APPLY_FLAG',
  replyColumn: 'RCPT_ITEM_DOCUMENT_NO',
};

/** 제품출하. 라인은 DN_REQ_SEQ 로 갈린다. */
export const GOODS_ISSUE: RcvTable = {
  name: 'T_IF_RCV_GOODS_ISSUE_KO324',
  keyColumns: ['DN_REQ_NO', 'IF_SEQ', 'CREATE_TYPE', 'DN_REQ_SEQ'],
  documentColumns: ['DN_REQ_NO'],
  ifSeq: 'perSend',
  // 이 표만 두 단계다 — ERP 가 출하전표(DN_NO)를 발번하며 1 을, 출하를 확정하며 2 를 올린다. 처음 값은 'N' 이 아니라 빈 값이다.
  initialFlags: { ERP_APPLY_FLAG1: '', ERP_APPLY_FLAG2: '' },
  appliedFlag: 'ERP_APPLY_FLAG2',
  replyColumn: 'DN_NO',
};

/** 구매입고. POP_INF_KEY 는 MES 가 매기는 건 번호다. */
export const GR_INFOR: RcvTable = {
  name: 'T_IF_RCV_GR_INFOR_KO324',
  keyColumns: ['POP_INF_KEY', 'PLANT_CD', 'ITEM_CD', 'PO_NO', 'PO_SEQ_NO', 'IF_SEQ', 'CREATE_TYPE'],
  documentColumns: ['POP_INF_KEY'],
  ifSeq: 'perSend',
  initialFlags: { ERP_APPLY_FLAG: 'N' },
  appliedFlag: 'ERP_APPLY_FLAG',
  replyColumn: 'GM_NO',
};

export const RCV_TABLES: readonly RcvTable[] = [PROD_RSLT, GOODS_ISSUE, GR_INFOR];

/** 적어 둔 표 이름 → 표. */
export function tableNamed(tables: readonly RcvTable[], name: string): RcvTable {
  const table = tables.find((candidate) => candidate.name === name);
  if (table === undefined) throw new Error(`보내는 표가 아니다: ${name}`);
  return table;
}

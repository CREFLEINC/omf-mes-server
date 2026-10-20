/**
 * ERP 중계 DB(MSSQL `sample_mes`)의 받는 표. 이름의 SND·RCV 는 ERP 쪽에서 본 방향이다 —
 * `T_IF_SND_*`·`T_ERP_*_TIG_DOWN` 이 ERP→MES 다.
 *
 * ⛔ 행을 고치거나 지우지 않는다. 우리 몫은 미반영 표시 칸을 'Y' 로 올리는 것뿐이다
 * (`erp-mock/docs/interface-common-rules.md`).
 */
export interface RelayTable {
  /** `integration_message.interface_code`. */
  interfaceCode: string;
  /**
   * `integration_message.target_type_code` — 계약 `IntegrationMessage.targetTypeCode` 의 어휘
   * (`INTERFACE_TARGET`, 열린 그룹). 확정 다섯 밖의 값은 막지 않고 표식만 한다(계약).
   */
  targetTypeCode: string;
  /** `dbo` 아래 표 이름. */
  name: string;
  /** 화면에 보이는 이름 — 연동 현황 탭의 「지금 읽기」 줄(장부 P-81). */
  label: string;
  /**
   * 'N' 이 미반영, 'Y' 가 반영. TIG_DOWN 계열은 `IF_YN` 뿐이고, SND 계열(`MES_APPLY_FLAG`)은
   * 반영 시각·실패 사유 칸(`MES_APPLY_DT`·`MES_APPLY_ERROR`)과 수정자 칸을 함께 쓴다.
   */
  flagColumn: 'IF_YN' | 'MES_APPLY_FLAG';
  /** 업무 키. 같은 키의 앞 판이 막히면 뒤 판도 반영하지 않는다(옛 값이 새 값을 덮지 않게). */
  keyColumns: readonly string[];
  /** 같은 업무 키 안에서 판의 순서. 같은 판의 취소(CREATE_TYPE=C)는 IDENTITY 가 가른다. */
  versionColumn: 'T_SEQ' | 'IF_SEQ';
}

/** 행 하나. `MES_INF_ID` 는 중계 DB 의 IDENTITY 다. */
export type RelayRow = Record<string, unknown> & { MES_INF_ID: number };

export const COMMON_CODE: RelayTable = {
  interfaceCode: 'IF-ERP-CODE-RECV',
  targetTypeCode: 'COMMON_CODE',
  name: 'T_ERP_TYPE_TIG_DOWN',
  label: '공통코드',
  flagColumn: 'IF_YN',
  // PLANT_CD 는 키에 넣지 않는다 — MES 코드 값의 키가 (그룹, 코드)이고 244행 전부 비어서 온다.
  keyColumns: ['TYPE_CODE', 'CODE'],
  versionColumn: 'T_SEQ',
};

/** 사원. 부서 마스터가 따로 없어 부서도 여기서 뽑는다(DEPT_CODE·PDEPT). */
export const EMPLOYEE: RelayTable = {
  interfaceCode: 'IF-ERP-EMP-RECV',
  targetTypeCode: 'WORKER',
  name: 'T_ERP_EMP_TIG_DOWN',
  label: '사원',
  flagColumn: 'IF_YN',
  keyColumns: ['EMP_CODE'],
  versionColumn: 'T_SEQ',
};

/** 품목. 공장별로 오지만 MES 품목은 품목코드 하나다 — 두 공장 544건은 값이 모두 같았다. */
export const ITEM: RelayTable = {
  interfaceCode: 'IF-ERP-ITEM-RECV',
  targetTypeCode: 'ITEM',
  name: 'T_IF_SND_ITEM_INFOR_KO324',
  label: '품목',
  flagColumn: 'MES_APPLY_FLAG',
  keyColumns: ['ITEM_CD', 'PLANT_CD'],
  versionColumn: 'IF_SEQ',
};

export const PARTNER: RelayTable = {
  interfaceCode: 'IF-ERP-BP-RECV',
  targetTypeCode: 'PARTNER',
  name: 'T_IF_SND_BIZ_PARTNER_KO324',
  label: '거래처',
  flagColumn: 'MES_APPLY_FLAG',
  keyColumns: ['BP_CD'],
  versionColumn: 'IF_SEQ',
};

/**
 * BOM. 한 행이 (모품목, 자품목, 순번) 하나다. 모품목이 키의 맨 앞이라 한 모품목의 행이 붙어서
 * 오고, MES 는 그것을 묶어 BOM 판 하나로 반영한다. 두 공장에 걸친 모품목은 없었다.
 */
export const BOM: RelayTable = {
  interfaceCode: 'IF-ERP-BOM-RECV',
  targetTypeCode: 'BOM',
  name: 'T_IF_SND_BOM_INFOR_KO324',
  label: 'BOM',
  flagColumn: 'MES_APPLY_FLAG',
  keyColumns: ['PRNT_ITEM_CD', 'PLANT_CD', 'CHILD_ITEM_SEQ', 'CHILD_ITEM_CD'],
  versionColumn: 'IF_SEQ',
};

/**
 * 발주. 한 행이 발주 라인 하나다 — 헤더 칸(공장·거래처·유형·일자)은 라인마다 같이 온다.
 * ⛔ 업무 키에 품목을 넣지 않는다 — 판마다 품목이 바뀔 수 있어 넣으면 판보다 품목코드 순으로 읽힌다.
 */
export const PURCHASE_ORDER: RelayTable = {
  interfaceCode: 'IF-ERP-PO-RECV',
  targetTypeCode: 'PURCHASE_ORDER',
  name: 'T_IF_SND_PO_INFOR_KO324',
  label: '구매발주',
  flagColumn: 'MES_APPLY_FLAG',
  keyColumns: ['PO_NO', 'PO_SEQ_NO'],
  versionColumn: 'IF_SEQ',
};

/** 수주. 발주와 같은 모양이다. */
export const SALES_ORDER: RelayTable = {
  interfaceCode: 'IF-ERP-SO-RECV',
  targetTypeCode: 'SALES_ORDER',
  name: 'T_IF_SND_SO_INFOR_KO324',
  label: '수주',
  flagColumn: 'MES_APPLY_FLAG',
  keyColumns: ['SO_NO', 'SO_SEQ_NO'],
  versionColumn: 'IF_SEQ',
};

/** ERP W/O. 원본 한 행이 ERP W/O 하나다. */
export const PRODUCTION_ORDER: RelayTable = {
  interfaceCode: 'IF-ERP-PRODORD-RECV',
  targetTypeCode: 'PRODUCTION_ORDER',
  name: 'T_IF_SND_PROD_ORD_KO324',
  label: 'ERP W/O',
  flagColumn: 'MES_APPLY_FLAG',
  keyColumns: ['PRODT_ORDER_NO'],
  versionColumn: 'IF_SEQ',
};

/** 읽는 순서 — 업무 키, 판, 그리고 같은 판이 둘일 때를 가를 IDENTITY. */
export function orderColumns(table: RelayTable): string[] {
  return [...table.keyColumns, table.versionColumn, 'MES_INF_ID'];
}

export function businessKey(table: RelayTable, row: RelayRow): string {
  return table.keyColumns.map((column) => text(row, column)).join('|');
}

/** 문자 칸. 중계 DB 는 `'EA '` 처럼 뒤에 공백을 달고 오는 값이 있다. */
export function text(row: RelayRow, column: string): string {
  const value = row[column];
  return value === null || value === undefined ? '' : String(value).trim();
}

/** SND 계열의 취소 행 — 지우지 않고 끈다. */
export function isCancel(row: RelayRow): boolean {
  return text(row, 'CREATE_TYPE') === 'C';
}

export function requiredText(row: RelayRow, column: string): string {
  const value = text(row, column);
  if (value === '') throw new Error(`${column} 이 비어 있다`);
  return value;
}

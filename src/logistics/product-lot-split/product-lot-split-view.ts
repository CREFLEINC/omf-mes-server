import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';

import { currentTerminal, TerminalContext } from '../../auth/terminal-context';
import { ContractException, ERROR_CODE } from '../../common/errors';
import type { SplitBlock } from './product-lot-split-rules';

/** 계약 `ProductLotSplitLookup` — POP P-04-08 스캔 조회. */
export interface ProductLotSplitLookup {
  lot: {
    lotId: number; lotNo: string; itemCode: string; itemName: string; uomCode: string; statusCode: string;
    workOrderNo: string | null; labelQty: number;
  };
  blocked: SplitBlock | null;
  locations: {
    locationId: number; locationCode: string; warehouseCode: string; onHandQty: number; selectable: boolean;
    blocked: { code: string } | null;
    /** 위치 역할(`PUTAWAY_STAGING` 등) — 보통 위치는 null. */
    systemRoleCode: string | null;
  }[];
}

export interface SplitLotRef { lotId: number; lotNo: string; qty: number }

/** 계약 `ProductLotSplitResult` — 분리 응답. POP 은 두 발행 id 로 렌디션 → 인쇄 → `:report-print`. */
export interface ProductLotSplitResult {
  productLotSplitId: number;
  parentLot: SplitLotRef & { documentIssueLogId: number; issueSeq: number };
  childLot: SplitLotRef & { documentIssueLogId: number; issueSeq: number };
  location: { locationId: number; locationCode: string; warehouseCode: string };
  splitAt: string;
}

export type PrintState = 'PRINTED' | 'FAILED' | 'NONE';

/** 계약 `ProductLotSplit` — 목록·확인 응답의 한 분리. */
export interface ProductLotSplitView {
  productLotSplitId: number;
  status: 'UNCONFIRMED' | 'CONFIRMED';
  parentLot: SplitLotRef;
  childLot: SplitLotRef;
  item: { itemId: number; itemCode: string; itemName: string; uomCode: string };
  location: { locationId: number; locationCode: string };
  splitAt: string;
  splitWorkerNo: string | null;
  confirmedAt: string | null;
  confirmedWorkerNo: string | null;
  lastPrint: { parent: PrintState; child: PrintState };
}

/** 단말 전용 경로 — 계정 세션은 403(관리웹 화면이 없다). 단말 유형은 가드가 이미 걸렀다. */
export function requireTerminal(request: Request): TerminalContext {
  const terminal = currentTerminal(request);
  if (terminal === undefined) {
    throw new ContractException(HttpStatus.FORBIDDEN, [
      { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '단말에서만 쓰는 기능입니다.' },
    ]);
  }
  return terminal;
}

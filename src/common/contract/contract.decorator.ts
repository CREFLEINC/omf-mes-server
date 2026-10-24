import { SetMetadata } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

export const CONTRACT_OPERATION = 'contract:operation';
/** 계약에 없는 경로가 «다른 오퍼레이션과 똑같이» 검사받게 하는 표시(`ContractAlias`). 커버리지에 세지 않는다. */
export const CONTRACT_ALIAS = 'contract:alias';

/** `METHOD /path` — 계약의 템플릿 경로 그대로. 490건 전부 이 형태로 유일하다. */
const OPERATION_KEY = /^(GET|POST|PUT|PATCH|DELETE) \/\S*$/;

/**
 * 핸들러를 계약 오퍼레이션에 **명시로** 묶는다.
 *
 * 라우트 패턴에서 계약 경로를 되짚지 않는다 — 전역 프리픽스·컨트롤러 접두사·파라미터
 * 이름이 계약과 어긋날 수 있고, 어긋나면 검증기가 «다른» 스키마로 조용히 통과시킨다.
 *
 * `operationId` 는 쓰지 않는다 — 490건 중 8건에만 있다.
 *
 * 쓰임: `@Contract('POST /trace/lots')`
 */
export const Contract = (operation: string): MethodDecorator => {
  if (!OPERATION_KEY.test(operation)) {
    throw new Error(`계약 오퍼레이션 표기가 «METHOD /path» 가 아니다: ${operation}`);
  }
  return SetMetadata(CONTRACT_OPERATION, operation);
};

/**
 * 계약 사본에 없는 경로를 기존 오퍼레이션과 **같은 검사**(인증·단말 범위·권한·본문 검증·멱등 키·잠금)로 묶는다.
 * 그 오퍼레이션의 요청 모양을 그대로 받는 서버 선행 경로(장부에 적는다)에만 쓴다 — 예: 입하 등록 본문으로
 * 줄마다 한 건씩 만드는 `POST /logistics/inbound-receipts:per-line`(P-117).
 * `@Contract` 와 달리 계약 바인딩으로 세지 않는다 — 커버리지가 부풀지 않고 「한 오퍼레이션을 두 핸들러가 주장하지
 * 않는다」에 걸리지 않는다. 경로 파라미터가 있는 오퍼레이션에는 쓰지 않는다(검증기가 그 이름으로 읽는다).
 */
export const ContractAlias = (operation: string): MethodDecorator => {
  if (!OPERATION_KEY.test(operation)) {
    throw new Error(`계약 오퍼레이션 표기가 «METHOD /path» 가 아니다: ${operation}`);
  }
  if (operation.includes('{')) throw new Error(`경로 파라미터가 있는 오퍼레이션에는 별칭을 달지 않는다: ${operation}`);
  return SetMetadata(CONTRACT_ALIAS, operation);
};

/** 가드가 볼 오퍼레이션 — `@Contract` 가 먼저, 없으면 `@ContractAlias`. */
export function contractOperationOf(reflector: Reflector, handler: object): string | undefined {
  return (
    reflector.get<string | undefined>(CONTRACT_OPERATION, handler as never) ??
    reflector.get<string | undefined>(CONTRACT_ALIAS, handler as never)
  );
}

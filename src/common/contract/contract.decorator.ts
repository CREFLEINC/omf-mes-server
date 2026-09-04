import { SetMetadata } from '@nestjs/common';

export const CONTRACT_OPERATION = 'contract:operation';

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

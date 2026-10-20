/**
 * ⭐⭐ **정본 없이 서빙하던 6 오퍼레이션이 계약에 있고 `@Contract` 로 묶였음을 지킨다**(2026-10-20).
 *
 * 정본화 전에는 설계 사본에 없어 `@Contract` 를 달 수 없었다 — 그래서 컨트롤러가 인증·권한·질의 검증을 손으로 했다
 * (장부 P-58 · P-78 · P-81 · P-10 · FR-007). 이제 정본에 올리고 가드가 본다. 이 검사가 빨개지면 누가 계약에서
 * 경로를 빼거나 바인딩을 떼어 «가드 밖» 라우트가 다시 생긴 것이다.
 *
 * 단말 전용 둘은 `@Contract` 와 함께 인증 가드의 특수 경로 표지(POP 자기 단말 · 토큰 세대 검사)를 계속 단다 —
 * 일반 경로는 세션을 먼저 받는데 이 둘은 세션을 받지 않는다.
 */
import { join } from 'node:path';

import { TERMINAL_ACCESSIBLE_SCREENS_OPERATION, TERMINAL_REGISTRATION_OPERATION } from '../../auth/terminal-registration-operation';
import { TerminalController } from '../../mdm/terminal/terminal.controller';
import { collectContractBindings } from './contract-bindings';
import { ContractRegistry } from './contract-registry';

const SRC = join(__dirname, '../..');

const LISTED = {
  'GET /app/dashboard-quality-lots': 'DashboardQualityLotsController.read',
  'GET /logistics/purchase-order-lines': 'PurchaseOrderLineListController.list',
  'GET /integration/erp-sync/tables': 'ErpSyncController.list',
  'POST /integration/erp-sync/tables/{interfaceCode}:run': 'ErpSyncController.run',
  'GET /mdm/terminals/{terminalId}/accessible-screens': 'TerminalController.accessibleScreens',
  'POST /mdm/terminals/{terminalId}:confirm-registration': 'TerminalController.confirmRegistration',
} as const;

type Operation = { security?: Record<string, unknown>[]; responses?: Record<string, unknown> };

describe('계약 정본 — 가드 밖에서 서빙하던 6 오퍼레이션', () => {
  const registry = ContractRegistry.load();
  const operation = (key: string): Operation => registry.get(key)?.operation as Operation;

  it('⭐ 여섯 다 계약에 있다', () => {
    expect(Object.keys(LISTED).filter((key) => !registry.has(key))).toEqual([]);
  });

  it('⭐ 여섯 다 그 핸들러가 `@Contract` 로 묶었다 — 가드(인증·권한·계약 검증·멱등)가 본다', async () => {
    const bindings = await collectContractBindings(SRC);
    const bound = Object.fromEntries(bindings.map((binding) => [binding.key, binding.handler]));
    expect(Object.fromEntries(Object.keys(LISTED).map((key) => [key, bound[key]]))).toEqual(LISTED);
  });

  it('⛔ 관리웹 넷은 세션 전용 · 단말 둘은 단말 토큰 전용이다 — 모두 401 을 선언한다', () => {
    const security = (key: string) => operation(key).security?.flatMap((entry) => Object.keys(entry));
    for (const key of Object.keys(LISTED).slice(0, 4)) expect(security(key)).toEqual(['omfSession']);
    for (const key of Object.keys(LISTED).slice(4)) expect(security(key)).toEqual(['terminalToken']);
    for (const key of Object.keys(LISTED)) expect(operation(key).responses).toHaveProperty('401');
  });

  it('⛔ 단말 둘은 인증 가드의 특수 경로 표지를 그대로 단다 — 세션 쿠키·남의 단말·옛 세대 토큰은 401', () => {
    const prototype = TerminalController.prototype;
    expect(Reflect.getMetadata(TERMINAL_ACCESSIBLE_SCREENS_OPERATION, prototype.accessibleScreens)).toBe(true);
    expect(Reflect.getMetadata(TERMINAL_REGISTRATION_OPERATION, prototype.confirmRegistration)).toBe(true);
  });

  it('⛔ 「지금 읽기」는 Idempotency-Key 를 요구하지 않는다 · 등록 확인은 요구한다 — 계약 올리기 전과 같다', () => {
    const refs = (key: string) =>
      ((registry.get(key)?.operation as { parameters?: { $ref?: string }[] }).parameters ?? []).map((p) => p.$ref);
    expect(refs('POST /integration/erp-sync/tables/{interfaceCode}:run')).not.toContain('#/components/parameters/IdempotencyKey');
    expect(refs('POST /mdm/terminals/{terminalId}:confirm-registration')).toContain('#/components/parameters/IdempotencyKey');
  });
});

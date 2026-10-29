import Test from 'supertest/lib/test';

/**
 * supertest 는 요청마다 `listen(0)`(모든 주소)으로 빈 포트를 받고 `127.0.0.1` 로 붙는다. macOS 는 다른 프로그램이
 * `127.0.0.1` 에만 묶어 둔 포트를 모든 주소 쪽에 또 내줄 수 있어, 그 포트에 걸린 요청은 남의 프로그램이 받는다 —
 * 전체 실행에서만 아무 묶음이나 501·socket hang up 으로 떨어지던 까닭이다. 그래서 IPv6 루프백(`::1`)으로 붙는다.
 * ⛔ `listen(0, '127.0.0.1')` 로 고치지 않는다 — 주소를 주면 Node 가 비동기로 열어 supertest 가 포트를 못 읽는다.
 */
const serverAddress = Test.prototype.serverAddress;
Test.prototype.serverAddress = function (this: Test, ...args: Parameters<typeof serverAddress>): string {
  return serverAddress.apply(this, args).replace('://127.0.0.1:', '://[::1]:');
};

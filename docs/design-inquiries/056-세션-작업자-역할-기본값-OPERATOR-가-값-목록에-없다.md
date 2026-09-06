# 56. `work_session_worker.worker_role_code` 의 기본값 `'OPERATOR'` 가 `WORK_SESSION_WORKER_ROLE` 값 목록에 없다

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `POST /production/work-sessions` · `POST /production/work-sessions/{workSessionId}/workers` |
| 구현 상태 | **구현함(I-11 · 물리 DEFAULT `'OPERATOR'` 를 그대로 태운다 — 서버가 칸을 안 넣는다 · 마이그 0 · 시드 무변경)** |
| 판정 | `coverage-100/README.md` §2 1단계 **본길** — `WorkSessionCreate.workerIds[]` 에 역할 축이 아예 없어 세션 열기가 만드는 참여 행은 **전건**이 default 를 탄다(가장자리가 아니다) → **계약 문자 그대로** · 2단계 기준 4(`'MAIN'` 으로 갈아 넣지 않는다 — 조용한 도출) + 기준 3(default 를 바꾸는 마이그를 만들지 않는다) |
| 되돌릴 때 | 「`OPERATOR` 를 값 목록에 넣어라」면 시드 **1행**(고객이 소유하는 마스터라 우리가 안 넣었다 · G-31) · 「default 를 `MAIN` 으로」면 마이그 한 줄 + 계약 `default` 정정 · 「`workerIds[]` 에 역할 축을 열어라」면 계약 요청 스키마 한 칸 + 서비스 한 줄 |

## 무엇이 문제인가

ⓐ 물리 DEFAULT 와 **계약 스키마의 `default`** 가 둘 다 `"OPERATOR"` 인데(`WorkSessionWorker.workerRoleCode`) 시드·DB 의 `WORK_SESSION_WORKER_ROLE` 은 `MAIN`·`SUB` **둘뿐**이다(실측).
ⓑ `WorkSessionCreate.workerIds[]` 는 **id 배열일 뿐 역할 축이 없다** ⇒ 세션 열기가 만드는 참여 행은 **전건**이 목록 밖 값을 갖는다. 「한두 행이 그럴 수 있다」가 아니라 **오늘 만들어지는 참여 행 전부**다.
ⓒ 계약이 ⌜⭐ **고객이 늘릴 수 있다 — 위 둘은 초기값(기본값)이지 닫힌 목록이 아니다**⌝ 라 적어 목록 밖이라는 사실 자체는 계약 위반이 **아니다**. 그러나 화면이 `code_name` 을 못 찾아 **코드 글자가 그대로 노출**된다(`code-reference.ts` 주석이 경고한 그 자리).
ⓓ 역할을 **고르는 화면이 0건**이라 `MAIN`/`SUB` 를 사람이 고를 자리도 없다 — `POST …/workers` 의 `workerRoleCode` 는 선택 칸인데 그 칸을 채워 보낼 화면이 인벤토리에 없다.

## 지금 서버는

- 세션 열기의 `work_session_worker.createMany` 가 **역할 칸을 아예 안 넣는다** — 물리 default `'OPERATOR'` 가 들어간다.
- `POST …/workers` 는 값이 **«오면»** `assertCodeValues(…, 'WORK_SESSION_WORKER_ROLE')` 로 그룹 대조를 걸고, **안 오면 칸을 안 넣는다**(같은 default). ⇒ 대조는 「보낸 값」에만 걸린다.
- 시드에 `OPERATOR` 행을 **더하지 않았다**(고객 마스터) · default 를 갈아 끼우는 마이그도 **만들지 않았다**.

흔적: `docs/coverage-100/slices/I-11.md` §2-2 ⓒ · §11-1 #3 · R-12 · `work-session-worker.service.ts:74` · `work-session-rules.spec.ts:56` · `work-session.service.spec.ts:211`.

# Team workflow (multi-agent-team-workflow V3)

이 저장소는 `../../multi-agent-team-workflow-v3.md`(정본, 저장소 루트)가 정의하는
**백엔드 개발팀 저장소**다. 이 문서는 그 규칙을 이 저장소에서 어떻게 지키는지 못박는다 — 정본
텍스트 자체는 옮기지 않는다.

로컬 상태 갱신: `pnpm workflow:bootstrap` (`.backend-dev/state.json`, 로컬 전용 — 담당 팀·적용
워크플로 버전·설계 고정 커밋 스냅샷). 설계 저장소 참고 클론 새로고침:
`pnpm workflow:sync-design`.

## 우리 위치

- **우리 저장소** : `CREFLEINC/omf-mes-server` — 백엔드 개발팀, 단일 팀(팀 번호 분할 없음).
- **설계 저장소** : `CREFLEINC/omf-mes` (비공개). 로컬 참고 클론은 `.design-reference/omf-mes`
  (V2 §2.2 그대로 — 워크트리 임시 폴더 격리. `.git/info/exclude`로 로컬 전용, 커밋되지 않는다).
  읽기 전에 항상 `pnpm workflow:sync-design`으로 `main` 최신을 받는다.
- ⭐ **2026-09-03 설계팀 방침 개정(설계 저장소 `CLAUDE.md` 확인)** : 설계팀은 더 이상 업무를
  배정하거나 개발팀 진행 상황을 보유하지 않는다. "설계 변동 공지"는 이 저장소로 오는 이슈가
  아니라 `design/wiki/progress/변경-요약.md`(git 이력에서 자동 생성되는 "무엇이 언제
  바뀌었나" 표, `design/schema/generators/build-change-digest.py`가 만든다) 하나로 대체됐다.
  ⚠ 이 경로는 설계 저장소가 옮긴다 — 2026-09-04 에 `handover/` → `progress/` 로 옮겼다.
  `bootstrap.mjs`는 후보를 여럿 두고 **하나도 못 찾으면 실패로 끝낸다**(회차 감시가 조용히
  꺼진 채로 지나가지 않게 한다 — 실제로 그렇게 한 회차를 놓쳤다).
  우리가 **정기적으로 당겨서 확인**하는 것이 규칙 2·5의 실제 이행 방식이다 — 아래 참조.
- **클라이언트 저장소** : `CREFLEINC/omf-mes-client` — 규칙 2의 직접 소통 금지 대상. 이 저장소
  에서 이슈를 열거나 코멘트하지 않는다.

## 라벨 (사전 정보 — V2 형식을 쓴다)

| 라벨 | 상태 | 용도 |
| --- | --- | --- |
| `Agent : Backend` | 신설 | 팀 유형 라벨 |
| `status:in-progress` | 신설 | 진행 라벨. ⚠ 원문은 `in progress`지만 설계 저장소가 GH 예약어 충돌로 이미 `status:in-progress`로 대체해 운용 중이다(`.design-reference/omf-mes/CLAUDE.md` 변경 이력 2026-08-25). 저장소 간 신호를 맞추기 위해 이 저장소도 같은 문자열을 쓴다. |
| `help wanted` | 기존 | 중단(검토 중) 라벨 — 이미 저장소에 있다. |

팀 번호 라벨(`Agent : T{n}`)은 지금 쓰지 않는다 — 백엔드가 하위 팀으로 나뉘면 그때 만든다.

> `docs/agents/triage-labels.md`의 5종 라벨(`needs-triage` 등)은 이 워크플로와 무관한 별도
> 축(AFK 에이전트 트리아지)이다. 같은 이슈에 두 축을 동시에 붙여도 충돌하지 않는다.

## 규칙 2 — 직접 소통 금지 (요청 프로토콜)

1. ⛔ `CREFLEINC/omf-mes`나 `CREFLEINC/omf-mes-client`에 이슈를 만들거나 코멘트하지 않는다.
   예외는 설계팀이 우리에게 여는 "설계 변동 공지"뿐이다 — 우리가 여는 게 아니라 받는 것이다.
2. 필요(정보 요청 / 설계 개선)를 자료로 정리한다 — 어떤 계약·화면·자료 경로가 걸렸는지, 왜
   막혔는지 근거를 남긴다.
3. 자료를 사용자에게 전달하고 지시를 기다린다. **자료를 대신 발행하거나 커밋하지 않는다.**
4. 사용자가 "전달했고 회신 대기"라고 하면 그때 우리 저장소(`omf-mes-server`)에
   `gh issue create`로 추적 이슈를 연다(제목 접두 `[설계 요청]` 권장). 업무는 계속한다 —
   대기하며 멈추지 않는다.
5. 사용자가 답변서를 가져오면 내용을 확인하고, 기존 가정이 바뀌었으면
   `docs/계약-되돌림-mdm.md` 같은 이 저장소의 기존 기록 관행에 맞춰 남긴 뒤 추적 이슈를 닫는다.

## 규칙 4 — 진행 중 표시

이슈 작업을 시작하면 `status:in-progress`를 붙인다. 설계팀 답변 대기로 멈추면
`help wanted`로 바꾼다(이때도 이슈는 **우리 저장소**의 추적 이슈지, 설계 저장소 것이 아니다).

## 규칙 5 — 설계 자료 고정

이 저장소는 이미 설계 산출물 중 하나(OpenAPI 계약)를 고정하는 메커니즘을 갖고 있다 —
`contracts/COMMIT.txt` + `pnpm contracts:check` / `contracts:update`(`contracts/README.md`).
백엔드가 기대는 두 자료(물리 모델은 우리 소관, API 계약서는 설계 소관)중 후자가 여기 해당한다 —
"설계 고정 커밋"은 이 값을 그대로 쓴다.

`pnpm workflow:bootstrap`이 이 값과 함께 **설계 변경 회차**(`변경-요약.md`의 "변경 회차" 숫자)도
`.backend-dev/state.json`에 스냅샷하고, 직전 실행과 회차가 달라지면 경고를 찍는다.

설계 변동 공지를 확인하는 절차(이 저장소로 이슈가 오는 게 아니라 우리가 당겨서 본다):

1. `pnpm workflow:sync-design`으로 `.design-reference/omf-mes`를 최신 main으로 새로고침한다.
2. `pnpm workflow:bootstrap`을 다시 돌린다 — 회차가 바뀌었으면 경고가 뜬다.
3. `.design-reference/omf-mes/design/wiki/progress/변경-요약.md`에서 직전에 확인한 회차 이후
   행만 읽는다. **"무엇이 바뀌었나"(사실)까지만** 보고, "어디를 보나"가 API 계약·물리 모델에
   걸리는지 판단한다 — 내용 추측은 하지 않고 가리키는 파일을 직접 연다.
4. 계약이 걸리면 `pnpm contracts:check <새 커밋>`으로 실제 차이를 확인하고, 반영할 준비가 되면
   `pnpm contracts:update <새 커밋>`.
5. **전면 재검토** — 진행 중이거나 이미 구현한 도메인이 diff에 걸리면
   `docs/계약-되돌림-mdm.md` 관행대로 남긴다.

## 하네스는 이 문서의 소관이 아니다

루트 `CLAUDE.md`/`AGENTS.md`, `.claude/agents/`, `.claude/skills/` 구성은 이 저장소에서 실제
개발을 이끄는 담당자가 자신의 작업 방식에 맞춰 구성한다. 이 문서가 보장하는 것은 그 하네스가
무엇이든 **공통 워크플로우(V3)는 지켜진다**는 것뿐이다.

# API 계약 정본

이 폴더의 OpenAPI 7개가 OMF MES API 계약의 **유일한 정본**이다. 서버 개발팀이 소유하고
직접 고친다. 설계 저장소(`CREFLEINC/omf-mes`)에서 받아오거나 그쪽에 맞추지 않는다
(2026-10-20 정본화 — 그 전까지는 설계 저장소의 읽기 전용 사본이었다).

## 정본은 서버가 실제로 하는 일과 같다

- 서버는 이 파일을 런타임에 읽는다 — 요청 검증(`ContractValidationGuard`), `/api/docs`,
  `src/contracts/*.d.ts` 타입 생성. 계약과 구현이 어긋나면 그 자리에서 드러난다.
- 컨트롤러 핸들러는 `@Contract('METHOD /path')`로 오퍼레이션에 묶인다. 계약의 모든
  오퍼레이션은 구현돼 있다(`contract-coverage.spec.ts`).
- 구현이 일부만 된 오퍼레이션은 `x-omf-server-implementation: { status: "partial", limitation }`
  으로 적는다. 서버 동작에 대한 보충 설명은 `x-omf-known-differences`에 남아 있다.
- 인증: `POST /app/sessions` 외 모든 오퍼레이션은 관리웹 세션 쿠키(`omfSession`)가 필요하다.
  단말(POP·모바일)이 부를 수 있는 오퍼레이션은 `terminalToken`(Bearer)도 받는다.

## 바꾸는 방법

1. 피처 설계(`omf-all-around/specs/NNN-이름/contracts/`)에서 변경안을 만들고 승인받는다.
2. 구현 PR에서 이 폴더의 해당 파일을 고친다. 계약 변경과 구현은 같은 PR에 담는다.
3. `pnpm contracts:generate`로 타입을 다시 만들고, 오퍼레이션 수가 바뀌면
   `contract-registry.spec.ts`·`contract-coverage.spec.ts`의 수치를 함께 고친다.

파일은 `JSON.stringify` 1칸 들여쓰기 형식을 유지한다(키 순서 보존).

## 파일과 생성 타입

| 계약 | 생성 타입 |
|---|---|
| `app-공통.json` | `src/contracts/app.d.ts` |
| `equipment-05설비툴.json` | `src/contracts/equipment.d.ts` |
| `logistics-01자재창고.json` | `src/contracts/logistics.d.ts` |
| `mdm-기준정보.json` | `src/contracts/mdm.d.ts` |
| `production-02생산실행.json` | `src/contracts/production.d.ts` |
| `quality-03품질.json` | `src/contracts/quality.d.ts` |
| `shipment-04제품출하.json` | `src/contracts/shipment.d.ts` |

타입 이름만 ASCII로 줄인다 — import 경로에 한글이 섞이지 않게. 대응은
`scripts/contracts/contracts.mjs` 한 곳에 있다.

`src/contracts/*.d.ts`는 파생물이라 커밋하지 않는다(`.gitignore`). CI와 Docker 빌드가 매번
다시 만든다. `src/` 밑에 두는 이유는 `tsconfig.json`의 `include`가 `src/**/*`뿐이어서다.

## 클라이언트

클라이언트(`omf-mes-client`)는 이 폴더를 서버 커밋 하나에 고정해 API 타입과 목 서버를 만든다.

## 이력

정본화 전 설계 사본 시절의 기록은 `docs/계약-선행-수정항목.md`(P-1 ~ P-80, 마감)와
`docs/coverage-100/계약-사본-당길-때.md`에 남아 있다. 새 항목은 더하지 않는다.

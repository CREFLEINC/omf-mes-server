# 계약 사본

정본은 설계 저장소 [CREFLEINC/omf-mes](https://github.com/CREFLEINC/omf-mes) 의
`design/wiki/api-contracts/openapi/` 다. 여기 있는 7개는 **읽기 전용 사본**이며
손으로 고치지 않는다. 고칠 것이 있으면 설계 저장소에 알린다.

## 왜 커밋하나

사본이 저장소 안에 있어야 하는 이유는 둘이다.

- **CI·Docker 가 계약 없이는 타입을 만들 수 없다.** `actions/checkout` 은 git clone 이라
  커밋되지 않은 것은 따라오지 않는다. 설계 저장소는 비공개라 빌드가 직접 받아오려면
  토큰을 주입해야 한다.
- **같은 커밋은 언제 빌드해도 같은 계약으로 빌드돼야 한다.** 정본은 버전을 올리지 않고
  바뀐다 — `info.version` 이 `0.1.0` 인 채로 mdm 오퍼레이션이 46 → 103 으로 늘었다.
  받아오는 시점에 빌드가 좌우되면 이미지가 사람마다 달라진다.

## 명령

```bash
pnpm contracts:check          # 설계 저장소 main 과 대조만 한다
pnpm contracts:check <sha>    # 특정 커밋과 대조

pnpm contracts:update         # main 최신을 받아온다
pnpm contracts:update <sha>   # 특정 커밋으로 고정

pnpm contracts:generate       # contracts/*.json → src/contracts/<slug>.d.ts
```

`gh` 의 로그인 자격증명을 쓴다. 설계 저장소가 비공개라 읽기 권한이 있는 계정이어야 한다.
`gh` 가 없으면 `check` 는 **종료 코드 2(SKIP)** 로 빠진다 — 확인하지 못한 것을
이상 없음으로 적지 않는다.

## 이슈 작업을 시작하기 전에 `check` 를 돌린다

2026-08-10 부터 18일간 사본이 낡은 줄 아무도 몰랐고, 그 사이 mdm 오퍼레이션이
46 → 103 으로 늘었다. 갱신을 사람이 하는 이상 「하는 걸 잊었다」를 막을 것이 필요하다.

`update` 뒤의 `git diff contracts/` 가 곧 계약 변경 알림이다.

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

파일명은 설계 저장소를 그대로 따르고, 타입 이름만 ASCII 로 줄인다 — import 경로에
한글이 섞이지 않게. 대응은 `scripts/contracts/contracts.mjs` 한 곳에 있다.

`COMMIT.txt` 는 사본이 어느 설계 커밋에서 왔는지다. 산출물의
`contract_reference_commit` 이 이 값이며 `update` 가 적는다.

## 생성물

`src/contracts/*.d.ts` 는 파생물이라 커밋하지 않는다(`.gitignore`). Prisma Client 와
같은 취급이며 CI 와 Docker 빌드가 매번 다시 만든다.

`src/` 밑에 두는 이유: `tsconfig.json` 의 `include` 가 `src/**/*` 뿐이고, 형제
디렉터리를 넣으면 빌드 산출물이 한 단계 깊어져 `start:prod` 가 깨진다.

## ⚠ 지금 타입이 만들어지지 않는 계약이 하나 있다

`logistics-01자재창고.json` 의 `InboundReceiptCreate` 스키마에 `x-internal-note` 키가
**두 번** 있다(8501행·8598행). JSON 파서는 뒤엣것만 남기므로 앞의 메모
(거래명세서 OCR 파싱 결과를 담을 곳이 없다는 결손 표시)가 조용히 사라지고,
`openapi-typescript` 는 파싱 단계에서 실패한다.

사본은 읽기 전용이라 여기서 고치지 않는다. 설계 저장소가 고치면
`pnpm contracts:update` 로 받는다. 관련: 이슈 `#49`.

# 계약 사본

정본은 문서 저장소([CREFLEINC/omf-mes](https://github.com/CREFLEINC/omf-mes))의
`deliverables/openapi/` 다. 여기 있는 것은 **읽기 전용 사본**이며 손으로 고치지 않는다.

## 갱신

```bash
cp ../omf-mes/deliverables/openapi/mdm-기준정보.json contracts/
pnpm run contracts:generate
```

갱신은 사람이 하고, **그 diff 가 곧 계약 변경 알림이다.** 정본은 버전을 올리지 않고
바뀐다 — 2026-08-04 하루 사이에 `0.1.0` 인 채로 예시 478개가 들어왔다.

## 생성물

`src/contracts/mdm.d.ts` 는 `contracts/mdm-기준정보.json` 에서 만들어지는 파생물이라
커밋하지 않는다(`.gitignore`). Prisma Client 와 같은 취급이며, CI 와 Docker 빌드가
매번 다시 만든다.

`src/` 밑에 두는 이유: `tsconfig.json` 의 `include` 가 `src/**/*` 뿐이고, 형제
디렉터리를 넣으면 빌드 산출물이 한 단계 깊어져 `start:prod` 가 깨진다.

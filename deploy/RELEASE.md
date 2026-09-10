# 하노이 현장 배포 절차

하노이 공장은 **3교대 24시간 가동**입니다. 무중단 창이 없으므로 현장 배포는 자동화하지 않고, 합의된 시각에 사람이 실행합니다.

## 두 서버의 역할

| | 개발 서버 (한국) | 하노이 운영 서버 |
|---|---|---|
| 배포 경로 | `/opt/omf-mes` | `/opt/omf-mes` |
| `IMAGE_TAG` | `main` | `stable` |
| `LOG_TZ` | `Asia/Seoul` | `Asia/Ho_Chi_Minh` |
| 배포 시점 | main 머지 후 self-hosted runner 가 자동 | 합의된 창에 수동 |
| 반영 대상 | main 브랜치 최신 코드 | `git tag` 로 릴리스한 버전 |
| 목적 | 통합 검증 | 현장 가동 |

`.env.prod` 두 줄 차이입니다. 컨테이너 타임존은 양쪽 모두 UTC 이고, `LOG_TZ` 는 배포 로그를 읽는 사람을 위한 표기용입니다.

## 다운타임

배포하면 `api` 컨테이너가 재생성됩니다.

```
migrate deploy          스키마 변경 없으면 1~3초, 있으면 마이그레이션 크기에 비례
api 컨테이너 재생성      즉시
NestJS 부팅             5~15초
헬스체크 start_period    20초 (이 시간이 지나야 healthy 판정)
────────────────────────────────────────────
합계                    통상 30~60초
```

이 시간 동안 POP 단말은 서버 응답을 받지 못합니다. 마이그레이션 이력에 `work_session_idempotency_key` 가 있으므로 단말이 재시도하도록 되어 있다면 대부분 흡수됩니다 — **단말 재시도 동작을 먼저 확인하세요.** 재시도가 없다면 작업자가 실적 등록을 다시 해야 합니다.

## 배포 창 고르기

3교대라면 교대 전환 시점에 라인이 잠시 멈추는 구간이 있습니다. 그때가 POP 사용이 가장 적습니다.

```
예) 06:00 / 14:00 / 22:00 교대 전환
    → 전환 직전 5~10분 또는 전환 직후 라인 준비 시간
```

현장 관리자와 **어느 교대 경계를 쓸지 미리 합의해 두세요.** 매번 협의하면 배포가 미뤄지고, 미뤄진 변경이 쌓이면 한 번에 큰 배포가 되어 위험이 커집니다. 격주 목요일 22:00 전환 같은 고정 슬롯을 정해두는 편이 낫습니다.

---

## 릴리스 절차

### 0. 최초 구축 — **한 번만** 돈다 (아직 안 했다)

2026-09-10 확인: **하노이에는 DB 가 아직 없다.** 아래는 그 첫 설치 절차이고, 두 번째부터는 §1 로 간다.

⭐ **이미 데이터가 든 DB 에 올리는 것이 아니라 «빈 DB»에 처음 얹는 것**이라, 「기존 행이 새 제약을
어긴다」는 부류의 사고가 원리상 0 이다. 별도 수기 SQL·백필·`NOT VALID` 가 필요 없다.

**검증**: 빈 DB 에 마이그레이션 **79개**를 처음부터 적용해 보았다(2026-09-10 · PostgreSQL 16).
`All migrations have been successfully applied` · 드리프트 **0** · 시드 완주 · 서버 부팅 · `admin` 로그인 200.

```bash
cd /opt/omf-mes
./deploy.sh                    # postgres → migrate(79개) → api
curl -s localhost:3100/api/health     # {"status":"ok","db":"up"}
```

#### ⛔ 여기서 멈추면 안 된다 — **시드는 «자동으로» 안 돈다**

`docker-compose.prod.yml` 에는 `migrate` 서비스만 있고 **seed 서비스가 없다.** `deploy.sh` 도
시드를 부르지 않는다. 그래서 위까지만 하면 **표는 다 섰는데 행이 거의 없다**:

| | 코드 그룹 | 코드 값 |
|---|:-:|:-:|
| `migrate deploy` **만** | **2** | **18** |
| `db seed` 까지 | **109** | **377** |

⇒ 시드를 빼면 **화면 드롭다운이 전부 비고**, 코드값을 검사하는 오퍼레이션이 **전건 400** 이다.
게다가 계정이 0개라 **아무도 로그인할 수 없다.**

`install-deploy.sh`는 8자 이상의 관리자 비밀번호를 두 번 입력받아 `.env.prod`의
`ADMIN_INITIAL_PASSWORD`에 평문으로 보관한다. 최초 `admin`은 이 값으로 만들어지며 첫 로그인
비밀번호 변경을 강제하지 않는다.

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  run --rm migrate node dist/seed.js
```

⛔ **`prisma db seed` 를 쓰지 마라.** `prisma.config.ts` 가 `NODE_ENV` 로 갈리는데 `migrate`
서비스에는 그 값이 없어 `ts-node prisma/seed.ts` 로 빠지고, **운영 이미지에는 ts-node 도
`prisma/seed.ts` 도 없다**(런타임 스테이지가 안 복사한다) ⇒ `spawn ts-node ENOENT`.
`node dist/seed.js` 를 직접 부르면 그 갈림을 지나가지 않는다.

시드는 `upsert` 라 **여러 번 돌려도 안전하다.**

#### 그 다음 — 사람이 해야 하는 것 둘

**① 역할별 권한을 준다.** 시드는 `ROLE_SYS_ADMIN` 에만 권한 3개(`W-CO-01`·`W-CO-02`·`W-CO-10`)를
주고 **나머지 세 역할은 권한 0 으로 둔다** — 설계 확정(2026-09-01)대로 **고객이 `W-CO-02` 에서
정하는 것**이기 때문이다. `admin` 으로 로그인해 `W-CO-02` 에서 부여한다.
⚠ 이걸 안 하면 **관리자 말고는 아무도 아무것도 못 한다.**

**② 값이 비어 있는 코드 그룹을 채운다.** 시드가 그룹은 세우고 **값을 0개로 둔 것이 10개**다
(설계팀 회신 대기분 — 전달분 §7-2):

```
DEFECT_RESPONSIBILITY_TYPE   JUDGMENT_TYPE                  LATE_ENTRY_REASON
MAINTENANCE_RESULT_LINE_RESULT  MATERIAL_CHANGE_REASON      PRODUCTION_RESULT_CORRECT_REASON
REINSPECTION_REASON          STOCK_REINSTATEMENT_REASON     STOCK_TRANSFER_REASON
WORK_ORDER_HOLD_REASON
```

⚠ 그리고 **`QUALITY_STATUS` 는 그룹 자체가 없다.** 그 값을 쓰는 화면은 열리지 않는다.

```bash
# 오픈 전 확인 — 빈 그룹이 몇 개인가
docker compose -f docker-compose.prod.yml --env-file .env.prod exec postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
  "SELECT g.group_code FROM mdm.code_group g
     LEFT JOIN mdm.code_value v ON v.code_group_id=g.code_group_id AND v.is_active
    WHERE g.is_active GROUP BY g.group_code HAVING count(v.code)=0 ORDER BY 1"
```

---

### 1. 개발 서버에서 검증

main 에 머지된 코드는 이미지 빌드가 끝나는 대로 개발 서버에 자동 반영됩니다(수 분). **최소 하루는 개발 서버에서 돌려보세요.**

```bash
# 개발 서버
cat /opt/omf-mes/DEPLOYED
curl -s localhost:3100/api/health
```

### 2. 릴리스 태그

```bash
cd ~/work/omf-mes-server
git switch main && git pull
git tag v1.2.0
git push origin v1.2.0
```

Actions 가 돌고 Harbor 에 `v1.2.0` 과 `stable` 이 생깁니다.

**확인**: Harbor → `mes` → `mes/backend` → Artifacts 에 두 태그.

### 3. 스키마 변경 여부 확인

```bash
git diff v1.1.0..v1.2.0 --stat -- prisma/migrations/
```

**새 마이그레이션이 있다면** 아래를 추가로 하세요.

- 마이그레이션 SQL 을 직접 읽고 파괴적 변경(컬럼/테이블 삭제, 타입 변경, NOT NULL 추가)이 있는지 확인
- 파괴적 변경이 있으면 **이번 배포는 롤백이 불가능합니다.** `prisma migrate deploy` 는 forward-only 이고, 이미지를 되돌려도 스키마는 되돌아가지 않습니다
- 배포 직전 DB 백업:

```bash
cd /opt/omf-mes
mkdir -p backup
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec -T postgres pg_dump -U omf -d omf_mes -Fc \
  > backup/$(date -u +%Y%m%dT%H%M%SZ)-before-v1.2.0.dump
ls -lh backup/
```

### 4. 현장 협의

배포 창을 확정하고 현장에 공지합니다. **작업자가 "서버가 안 된다"고 놀라지 않도록** 미리 알리는 것이 중요합니다.

### 5. 배포

```bash
cd /opt/omf-mes
./rollback.sh v1.2.0
```

> 스크립트 이름이 `rollback.sh` 지만 하는 일은 "`IMAGE_TAG` 를 지정한 값으로 바꾸고 배포"입니다. 특정 버전으로 올릴 때도 이걸 씁니다.
>
> `.env.prod` 의 `IMAGE_TAG=stable` 을 그대로 두고 `./deploy.sh` 만 실행해도 됩니다 — `stable` 이 방금 만든 `v1.2.0` 을 가리키니까요. 다만 **버전을 명시적으로 박아두는 편이 낫습니다.** 나중에 `cat DEPLOYED` 로 "지금 뭐가 돌고 있나"를 봤을 때 `stable` 보다 `v1.2.0` 이 훨씬 유용합니다.

**확인**: 마지막 줄 `===== 배포 완료 =====`

### 6. 동작 확인

```bash
curl -s localhost:3100/api/health
cat /opt/omf-mes/DEPLOYED
```

`git_revision` 이 릴리스 태그의 커밋과 같은지 확인하세요. `image_tag` 만 보면 안 됩니다 — `stable` 은 가변 태그라 무엇을 가리키는지 기록으로 남지 않습니다.

```bash
git rev-list -n1 v1.2.0        # 이 값과 DEPLOYED 의 git_revision 이 같아야 한다
```

그리고 **POP 단말 1대에서 실제 트랜잭션을 한 번 돌려보세요.** 헬스체크는 `SELECT 1` 만 하므로 통과해도 업무 로직이 정상이라는 보장은 없습니다.

### 7. 실패 시 롤백

```bash
/opt/omf-mes/rollback.sh v1.1.0
curl -s localhost:3100/api/health
```

`deploy.sh` 는 헬스체크 실패 시 **자동으로 직전 이미지로 되돌립니다.** 수동 롤백은 "떴지만 업무 로직이 잘못된" 경우에 씁니다.

스키마를 바꾼 릴리스를 되돌리는 경우, 구버전 코드가 신버전 스키마 위에서 돕니다. 컬럼 추가 정도면 대개 무사하지만 파괴적 변경이 있었다면 3번에서 뜬 백업으로 복구해야 합니다.

---

## 마이그레이션 작성 규칙 (권장)

롤백 사고의 대부분은 이 규칙 하나로 사라집니다.

**컬럼·테이블 삭제는 두 릴리스로 나눈다.**

```
v1.2.0  코드에서 해당 컬럼 사용을 제거 (컬럼은 그대로 둔다)
        → 이 시점에 롤백해도 안전하다
v1.3.0  컬럼을 삭제
        → v1.2.0 이 이미 그 컬럼을 안 쓰므로 v1.2.0 으로 롤백 가능
```

한 릴리스에서 "사용 제거 + 삭제"를 동시에 하면 그 배포는 되돌릴 수 없는 배포가 됩니다.

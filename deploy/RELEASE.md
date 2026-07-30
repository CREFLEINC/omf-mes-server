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

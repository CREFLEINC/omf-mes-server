# 개발 서버 self-hosted runner 구성

cron 을 대체합니다. main 머지 → 이미지 빌드 → **수 분 내 개발 서버 반영**, 실패는 GitHub 알림으로, 이력은 Actions 탭에 남습니다.

대상: 개발 서버(한국)만. 하노이 운영 서버는 `RELEASE.md` 절차를 유지합니다.

---

## 0. 사전 확인

```bash
# 이 서버에서 실행
id -nG | tr ' ' '\n' | grep -qx docker && echo "docker 그룹 OK" || echo "✗ docker 그룹 필요"
curl -sI https://github.com | head -1                       # 200/301 이면 OK
loginctl show-user "$USER" 2>/dev/null | grep Linger        # Linger=yes 면 좋음
systemctl --user status >/dev/null 2>&1 && echo "사용자 systemd OK" || echo "✗ 사용자 systemd 불가"
```

**레포가 private 인지 확인하세요.** public 레포에 self-hosted runner 를 붙이면 외부인이 fork PR 로 이 서버에서 임의 코드를 실행할 수 있습니다.

권한이 없어 막히면 인프라 담당자에게 한 번에 요청하세요.

```
usermod -aG docker hulk        # docker 접근 (배포에 필수)
loginctl enable-linger hulk    # 사용자 서비스 상시 실행 (러너 상주에 필요)
```

## 1. 배포 디렉터리 (최초 1회, 수동)

러너는 `.env.prod` 를 만들어주지 않습니다. 시크릿이라 레포에 없기 때문입니다.

```bash
mkdir -p /home/hulk/working/omf-mes/logs
cd /home/hulk/working/omf-mes

# 레포에서 아래 파일들을 복사 (이후에는 워크플로가 자동 동기화)
#   docker-compose.prod.yml
#   .env.prod.example
#   deploy/deploy.sh  deploy/rollback.sh  deploy/omf-mes-deploy.logrotate

cp .env.prod.example .env.prod
vi .env.prod          # POSTGRES_PASSWORD, JWT_SECRET 채우기
                      # IMAGE_TAG=main, LOG_TZ=Asia/Seoul 확인
chmod 600 .env.prod
chmod +x deploy.sh rollback.sh

docker login hub.crefle.com
#   Username: robot$mes+server-pull
#   Password: <토큰>
```

**확인**: `./deploy.sh` 를 손으로 한 번 돌려 성공시켜 두세요. 러너를 붙이기 전에 배포 자체가 되는지 확인하는 게 순서입니다.

## 2. 러너 설치

GitHub 레포 → **Settings → Actions → Runners → New self-hosted runner → Linux**

화면에 다운로드·전개 명령이 현재 버전으로 나옵니다. **그 명령을 그대로 복사해서 실행하세요** (버전이 계속 올라가므로 여기 적어두면 낡습니다).

`./config.sh` 단계만 아래처럼 라벨을 붙여 실행합니다.

```bash
cd ~/actions-runner
./config.sh \
  --url https://github.com/CREFLEINC/omf-mes-server \
  --token <화면에 표시된 등록 토큰> \
  --name omf-dev-01 \
  --labels omf-dev \
  --work _work \
  --unattended
```

`--labels omf-dev` 가 중요합니다. 워크플로의 `runs-on: [self-hosted, omf-dev]` 와 짝이 맞아야 합니다. 나중에 하노이에 러너를 추가할 때 `omf-hanoi` 라벨로 구분합니다.

**확인**: Settings → Actions → Runners 에 `omf-dev-01` 이 **Idle** 로 보입니다.

## 3. 러너 상주시키기

세 가지 경로 중 환경에 맞는 것을 고르세요.

| 방법 | 재부팅 후 자동 시작 | root |
|---|---|---|
| A. `svc.sh` 정식 설치 | ✅ | 필요 (1회) |
| B. 사용자 systemd + linger | ✅ (linger 허용 시) | 환경에 따라 |
| C. `tmux` 임시 | ❌ | 불필요 |

**A. 정식 설치** — 담당자에게 1회 실행 요청

```bash
cd ~/actions-runner
sudo ./svc.sh install hulk
sudo ./svc.sh start
sudo ./svc.sh status
```

**B. 사용자 systemd** (이 폴더의 `actions-runner.service`)

```bash
mkdir -p ~/.config/systemd/user
cp ~/work/omf-mes-server/deploy/actions-runner.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now actions-runner
systemctl --user status actions-runner

loginctl enable-linger hulk        # 없으면 로그아웃 시 죽는다
loginctl show-user hulk | grep Linger    # Linger=yes 확인
```

**C. tmux** — 검증용. 재부팅되면 사라지므로 임시로만.

```bash
tmux new -d -s runner '~/actions-runner/run.sh'
tmux ls
```

**확인**: 서버에서 로그아웃한 뒤 다시 접속해 Runners 화면이 여전히 **Idle** 인지 보세요. Offline 이 되면 상주에 실패한 것입니다.

## 4. 워크플로 배치

`.github/workflows/deploy-dev.yml` 을 커밋해 main 에 올립니다.

> `workflow_run` 트리거는 **기본 브랜치에 있는 워크플로 파일만** 동작합니다. 브랜치에 두고 테스트해도 자동 트리거가 안 걸리니, main 머지 후에 확인하세요. 그 전에는 `workflow_dispatch`(수동 버튼)로 시험할 수 있습니다.

## 5. 동작 확인

```
Actions 탭 → Deploy to dev server → Run workflow → (image_tag 비움) → 실행
```

**확인**: 4개 스텝(사전 점검 · 자산 동기화 · 배포 · 요약)이 모두 초록. Summary 에 `DEPLOYED` 내용이 표시됩니다.

그다음 main 에 아무 커밋이나 하나 머지해서 **자동 연쇄**를 확인하세요.

```
Build & Push to Harbor 성공  →  Deploy to dev server 자동 시작
```

## 6. cron 제거

러너가 붙었으면 cron 은 중복입니다. 같은 시각에 둘이 겹치면 `deploy.sh` 의 flock 이 막아주긴 하지만, 남겨둘 이유가 없습니다.

```bash
crontab -l                # 다른 작업이 섞여 있는지 먼저 확인
crontab -r                # 전체 삭제 (omf 작업만 있을 때)
# 섞여 있으면: crontab -e 로 열어 omf-mes 두 줄만 제거
crontab -l                # 삭제 확인
```

배포 로그는 이제 Actions 에 남으므로 `logs/deploy.log` 는 손으로 `./deploy.sh` 를 돌릴 때만 쌓입니다. logrotate 도 사실상 불필요해집니다 — `omf-mes-deploy.logrotate` 는 수동 실행이 잦은 경우를 위해 남겨둡니다.

`omf-mes-deploy.crontab` 은 **러너를 못 쓰게 될 때의 대안**으로 레포에 남겨둡니다.

---

## 알아둘 점

**수동 배포 시 태그 일회성 지정**

```
Run workflow → image_tag: v1.2.0
```

`.env.prod` 를 바꾸지 않고 그 배포만 `v1.2.0` 으로 올립니다. 다음 자동 배포는 다시 `.env.prod` 의 `main` 을 씁니다. 영구히 고정하려면 서버에서 `./rollback.sh v1.2.0` 을 쓰세요.

`docker compose` 가 셸 환경변수를 `--env-file` 보다 우선하고, `deploy.sh` 도 같은 규칙을 따르도록 맞춰뒀습니다. 두 쪽이 어긋나면 롤백 시 엉뚱한 태그에 이미지를 붙이게 됩니다.

**배포 자산은 항상 main 기준으로 동기화됩니다**

워크플로가 `ref: main` 을 체크아웃해 `docker-compose.prod.yml` 과 스크립트를 서버에 덮어씁니다. `image_tag: v1.0.0` 으로 수동 배포하면 **이미지는 v1.0.0, compose 는 main 기준**이 됩니다. 개발 서버에서는 무해하지만 알고 계시는 게 좋습니다.

**워크플로 파일 수정 권한 = 이 서버의 셸 권한**

`.github/workflows/` 를 고칠 수 있는 사람은 러너가 있는 서버에서 아무 명령이나 실행할 수 있습니다. main 브랜치 보호가 여기서는 보안 통제 역할을 합니다.

**PR 은 러너를 타지 않습니다**

`ci.yml` 은 `ubuntu-latest`(GitHub 호스팅)에서 돌고, `deploy-dev.yml` 은 `pull_request` 로 트리거되지 않습니다. 외부 코드가 사내 서버에서 실행될 경로가 없습니다. **트리거를 추가할 때 이 성질을 깨지 않도록 주의하세요.**

**러너가 죽으면 배포가 조용히 멈춥니다**

Actions 는 러너가 없으면 작업을 큐에 넣고 기다립니다. 실패가 아니라 대기라서 알림이 안 옵니다. Settings → Actions → Runners 를 가끔 확인하거나, 큐 대기 시간에 알림을 걸어두세요.

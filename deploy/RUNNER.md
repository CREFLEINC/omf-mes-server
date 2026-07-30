# 개발 서버 self-hosted runner 구성

cron 을 대체합니다. main 머지 → 이미지 빌드 → **수 분 내 개발 서버 반영**, 실패는 GitHub 알림으로, 이력은 Actions 탭에 남습니다.

대상: 개발 서버(한국)만. 하노이 운영 서버는 `RELEASE.md` 절차를 유지합니다.

---

## 0. 사전 확인

```bash
# 이 서버에서 실행
id -nG | tr ' ' '\n' | grep -qx docker && echo "docker 그룹 OK" || echo "✗ docker 그룹 필요"
curl -sI https://github.com | head -1                       # 200/301 이면 OK
sudo -n true 2>/dev/null && echo "sudo OK" || echo "sudo 확인 필요"
```

docker 그룹이 없으면 지금 붙입니다. **재로그인해야 반영됩니다.**

```bash
sudo usermod -aG docker hulk
# 로그아웃 후 재접속 → docker info 로 확인
```

**레포가 private 인지 확인하세요.** public 레포에 self-hosted runner 를 붙이면 외부인이 fork PR 로 이 서버에서 임의 코드를 실행할 수 있습니다.

> **러너는 `hulk` 로 돌립니다. root 로 올리지 마세요.** 배포에 필요한 건 docker 접근뿐입니다.
>
> 다만 **docker 그룹은 이미 root 와 사실상 동등합니다** — `docker run -v /:/host` 한 줄이면 호스트 파일시스템 전체입니다. 러너를 어느 계정으로 돌리든 "`.github/workflows/` 를 고칠 수 있는 사람 = 이 서버의 root" 라는 사실은 변하지 않습니다. 이걸 실제로 끊으려면 rootless Docker 나 socket proxy 가 필요하고, 그전까지는 **main 브랜치 보호가 유일한 실질 통제**입니다.

## 1. 배포 디렉터리 (최초 1회, 수동)

러너는 `.env.prod` 를 만들어주지 않습니다. 시크릿이라 레포에 없기 때문입니다.

디렉터리만 root 로 만들고 **소유자를 배포 계정으로 넘깁니다.** 이후 배포·롤백·로그는 전부 sudo 없이 돕니다.

```bash
sudo mkdir -p /opt/omf-mes/logs
sudo chown -R hulk:hulk /opt/omf-mes
cd /opt/omf-mes

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

> 홈 디렉터리가 아니라 `/opt` 를 쓰는 이유는 `.env.prod`(DB 비밀번호, JWT 서명 키)와 `DEPLOYED` 기록이 **개인 계정 수명에 묶이지 않게** 하기 위해서입니다. `deploy.sh`·`rollback.sh` 는 자기가 놓인 위치를 배포 디렉터리로 인식하므로 경로를 바꿔도 스크립트는 그대로입니다. 워크플로의 `DEPLOY_DIR` 과 이 경로만 맞으면 됩니다.

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

러너 패키지가 들고 있는 `svc.sh` 로 systemd 서비스에 등록합니다.

> `svc.sh` 는 **`./config.sh` 를 마쳐야 생깁니다.** 서비스 이름(`actions.runner.<owner>-<repo>-<러너이름>`)이 등록 후에야 정해지기 때문에, 러너 루트의 `bin/systemd.svc.sh.template` 에서 그때 생성됩니다. 압축 푼 직후에는 이 파일이 없습니다 — 2번을 먼저 하세요.

```bash
cd ~/actions-runner
sudo ./svc.sh install hulk     # ← 사용자명을 반드시 명시할 것
```

**`install` 뒤의 사용자명을 빠뜨리지 마세요.** `svc.sh` 는 `run_as_user=${arg_2:-$SUDO_USER}` 로 동작합니다. `sudo` 로 부르면 호출자 계정이 들어가지만, **root 셸에 들어가 있는 상태에서 인자 없이** 실행하면 `$SUDO_USER` 가 비어 러너가 root 로 뜹니다. help 텍스트가 `Install runner service as Root or specified user` 라고 되어 있어 root 가 기본인 것처럼 읽히는 것도 함정입니다.

공식 유닛 템플릿에는 `Restart=` 가 없어서 **러너 프로세스가 죽으면 systemd 가 되살리지 않습니다.** drop-in 으로 보강합니다.

```bash
sudo systemctl edit actions.runner.CREFLEINC-omf-mes-server.omf-dev-01.service
```

```ini
[Unit]
Wants=network-online.target     # 템플릿에 After 만 있고 Wants 가 없다

[Service]
Restart=always
RestartSec=10
```

```bash
sudo systemctl daemon-reload
sudo ./svc.sh start
sudo ./svc.sh status
```

**확인 — 실행 계정이 `hulk` 인지 반드시 보세요.**

```bash
systemctl show -p User --value 'actions.runner.*.service'     # hulk
systemctl show -p Restart --value 'actions.runner.*.service'  # always
```

그다음 서버에서 로그아웃한 뒤 다시 접속해 Runners 화면이 여전히 **Idle** 인지 보세요. Offline 이면 상주에 실패한 것입니다.

<details>
<summary>사용자 systemd 로 이미 띄워둔 경우 (구 방식에서 전환)</summary>

같은 러너 등록을 두 프로세스가 잡을 수 없습니다. **먼저 정리하고 `svc.sh` 로 넘어가세요.**

```bash
systemctl --user disable --now actions-runner
rm -f ~/.config/systemd/user/actions-runner.service
systemctl --user daemon-reload
loginctl disable-linger hulk      # svc.sh 경로에서는 불필요
```
</details>

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

배포 로그는 이제 Actions 에 남으므로 `logs/deploy.log` 는 손으로 `./deploy.sh` 를 돌릴 때만 쌓입니다. logrotate 도 사실상 불필요해집니다 — 수동 실행이 잦다면 `omf-mes-deploy.logrotate` 를 설치하세요.

```bash
sudo cp /opt/omf-mes/omf-mes-deploy.logrotate /etc/logrotate.d/omf-mes-deploy
sudo chown root:root /etc/logrotate.d/omf-mes-deploy
sudo chmod 644 /etc/logrotate.d/omf-mes-deploy
sudo logrotate -d /etc/logrotate.d/omf-mes-deploy     # 검사만
```

로그 디렉터리 소유자가 root 가 아니므로 파일 안의 `su hulk hulk` 지시자가 필요합니다. 빠뜨리면 logrotate 가 권한 문제로 조용히 건너뜁니다.

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

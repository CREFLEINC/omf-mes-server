import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, "../..");
const CONTRACT_DIR = join(ROOT_DIR, "contracts");
const GENERATED_ON = "2026-09-17";
const OUTPUT_DIR = join(ROOT_DIR, `docs/client-api/${GENERATED_ON}`);
const OPENAPI_DIR = join(OUTPUT_DIR, "openapi");

// 기준 커밋이 태그보다 앞선다 — v0.1.3 뒤의 미출시 지점이라 「-next」로 적는다.
// 정확한 지점은 SERVER_COMMIT 이 고정한다.
//
// ⛔ **main 히스토리에 «남을» 커밋을 적는다.** 이 저장소는 PR 을 squash 로 병합하므로
// 작업 브랜치의 커밋 해시는 병합과 함께 사라진다(원격 브랜치도 자동 삭제된다). 사라진
// 해시를 적어 두면 아래 assertSourceMatchesServerCommit 의 `git rev-parse <sha>:src` 가
// 새 클론에서 죽는다 — 지금 로컬에서 돌아가는 것은 객체가 아직 남아 있어서일 뿐이다.
// 그래서 전달본은 «병합된 뒤» 그 병합 커밋을 적어 다시 뽑는다.
// ⚠ **지금 적힌 것은 «브랜치» 커밋이다**(SHIP-UNIT-01 `final-routine/ship-unit-01-server`).
// 위 경고대로 squash 병합이면 이 해시가 사라지므로, **병합 뒤 그 병합 커밋으로 다시 뽑는다.**
// 클라이언트가 `gen:api` 를 지금 돌려야 해서 통합 결정으로 먼저 낸 임시 기준이다.
const SERVER_VERSION = "v0.1.3-next";
const SERVER_COMMIT = "7d6f2a32aba8adbaa45574f48bce9e3a7126af2d";
const GENERATED_VERSION = "0.1.3-next-server.20260917";
const CONTRACT_COMMIT = readFileSync(
  join(CONTRACT_DIR, "COMMIT.txt"),
  "utf8",
).trim();
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

const EXCLUDED_OPERATIONS = new Map([
  [
    "GET /app/dashboard-summary",
    "집계 대상 도메인 완성 뒤 구현하기로 이번 루틴에서 제외했다.",
  ],
  ["POST /app/attachments", "바이너리 저장소가 이번 범위 밖이다."],
  [
    "GET /app/attachments/{attachmentId}/content",
    "바이너리 저장소가 이번 범위 밖이다.",
  ],
  [
    "POST /maintenance/breakdowns/{breakdownId}/attachments",
    "바이너리 저장소가 이번 범위 밖이다.",
  ],
]);

const PARTIAL_OPERATIONS = new Map([
  [
    "GET /app/document-issues/{documentIssueLogId}/rendition",
    "MATERIAL_LOT_LABEL 발행 기록만 PNG로 렌더링한다. 다른 문서 유형은 422다. 산출물을 저장하지 않으므로 호출할 때마다 다시 그린다.",
  ],
  [
    "POST /app/document-issues",
    "IDENTIFICATION_TAG는 항상 422 STATE_LOCKED, DELIVERY_LABEL은 항상 422 INVALID다. 나머지 지원 조합만 기록을 생성한다.",
  ],
  [
    "POST /planning/production-orders/{productionOrderId}:resync",
    "재송신 대상을 가르는 축이 없어 재송신 자체는 수행하지 않는다.",
  ],
  [
    "POST /production/work-orders/{workOrderId}:close",
    "연동 메시지는 아웃박스 적재까지만 수행한다.",
  ],
  [
    "POST /logistics/shipments/{shipmentId}:confirm",
    "연동 메시지는 아웃박스 적재까지만 수행한다.",
  ],
  [
    "PUT /app/notification-subscriptions",
    "zaloEnabled 값은 저장하지만 실제 Zalo 발송 경로는 없다.",
  ],
  [
    "GET /app/printers",
    "실제 프린터 상태 수집 경로가 없어 statusCode를 OFFLINE으로 고정 반환한다.",
  ],
  [
    "POST /maintenance/results",
    "closed=true와 resetCounter=true는 항상 422 INVALID다. 마감하지 않고 누계를 초기화하지 않는 실적만 등록한다.",
  ],
  [
    "PUT /maintenance/results/{maintenanceResultId}",
    "closed=true는 항상 422 INVALID다. 마감 전 실적 수정만 처리한다.",
  ],
]);

const KNOWN_DIFFERENCES = [
  {
    id: "074",
    operations: [
      "GET /quality/defect-records",
      "GET /quality/defect-records/distribution",
    ],
    summary:
      "detectedFrom·detectedTo가 모두 없거나 한쪽만 있으면 서버는 400 REQUIRED를 반환한다.",
  },
  {
    id: "122",
    operations: ["POST /logistics/stock-transfers"],
    summary:
      "reasonCode·remarks를 요청으로 받지 않는다. 알 수 없는 키로 보내도 계약 검증상 저장되지 않는다.",
  },
  {
    id: "186",
    operations: [
      "GET /quality/nonconformances",
      "GET /quality/disposition-candidates",
      "GET /quality/nonconformances/{nonconformanceId}/disposition-decisions",
      "GET /quality/disposition-decisions",
      "GET /quality/concessions",
    ],
    summary: "서버가 요청 검증 실패에 400 표준 오류 봉투를 반환한다.",
  },
  {
    id: "201",
    operations: [
      "GET /logistics/sales-orders",
      "GET /logistics/shipment-requests",
      "GET /logistics/shipment-requests/summary",
      "GET /logistics/shipment-lot-allocations",
    ],
    summary: "서버가 요청 검증 실패에 400 표준 오류 봉투를 반환한다.",
  },
  {
    id: "217",
    operations: ["GET /logistics/goods-issues", "POST /logistics/shipments"],
    summary:
      "출하가 만든 GoodsIssue 응답은 sourceDocumentTypeCode=SHIPMENT를 반환할 수 있다.",
  },
  {
    id: "218",
    operations: [
      "GET /trace/lot-status-events",
      "POST /logistics/stock-reinstatements",
    ],
    summary:
      "LOT 상태 이력 응답은 C17~C20 및 원천 유형 DISPOSITION_DECISION·STOCK_TRANSFER를 반환할 수 있지만 transitionCode 질의는 아직 C17~C20을 거부한다.",
  },
  {
    id: "219",
    operations: ["GET /logistics/shipments"],
    summary:
      "shipDateFrom은 필수이며 정렬 키는 shippedAt·shipmentNo만 허용한다. 잘못된 요청은 400이다.",
  },
  {
    id: "221",
    operations: [
      "POST /logistics/shipments",
      "POST /logistics/stock-reinstatements",
    ],
    summary:
      "긴급 직행과 재등록은 창고 관리 수준에 따라 위치 입력을 검증하며 409 응답에는 conflictCause가 항상 포함된다.",
  },
  {
    id: "222",
    operations: [
      "GET /quality/disposition-decisions",
      "POST /logistics/stock-reinstatements",
    ],
    summary:
      "재등록 진입 목록의 followUpPending·reinstatable 축이 아직 한 개의 완결된 대기열을 만들지 못한다.",
  },
  {
    id: "273",
    operations: [
      "GET /inventory/counts/{inventoryCountId}/lines",
      "PUT /inventory/counts/{inventoryCountId}/lines",
    ],
    summary:
      "블라인드 실사는 counted 값과 관계없이 systemQty를 생략한다. 미실사 여부는 counted=false로 판정한다.",
  },
  {
    id: "109",
    operations: ["POST /maintenance/downtimes/{downtimeId}:close"],
    summary:
      "종료시각은 클라이언트 발생시각이 아니라 서버의 최초 처리시각이다. 같은 멱등 키 재전송은 최초 시각을 유지한다.",
  },
  {
    id: "113·114",
    operations: [
      "POST /maintenance/results",
      "PUT /maintenance/results/{maintenanceResultId}",
    ],
    summary:
      "closed=true와 resetCounter=true의 의미가 확정되지 않아 서버가 해당 입력을 422로 거부한다.",
  },
  {
    id: "사용자결정 2026-09-12",
    operations: ["POST /app/users", "POST /app/sessions"],
    summary:
      "등록이 초기 비밀번호까지 만든다. AppUserCreate.password를 보내면 그 값으로 정해지고 강제 변경이 걸리지 않으며, 생략하면 응답 temporaryPassword로 임시 비밀번호가 한 번만 내려오고 Session.mustChangePassword가 true가 된다.",
  },
  {
    id: "I-27",
    operations: ["POST /app/document-issues"],
    summary:
      "IDENTIFICATION_TAG와 DELIVERY_LABEL 발행 입력은 현재 서버가 각각 422 STATE_LOCKED·INVALID로 거부한다.",
  },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(absolutePath) : [absolutePath];
  });
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function operationKey(method, path) {
  return `${method.toUpperCase()} ${path}`;
}

function getOperation(document, key) {
  const separator = key.indexOf(" ");
  const method = key.slice(0, separator).toLowerCase();
  const path = key.slice(separator + 1);
  const operation = document.paths?.[path]?.[method];
  assert(operation, `오퍼레이션을 찾을 수 없습니다: ${key}`);
  return operation;
}

function getParameter(operation, name) {
  const parameter = operation.parameters?.find(
    (candidate) => candidate.name === name,
  );
  assert(parameter, `파라미터를 찾을 수 없습니다: ${name}`);
  return parameter;
}

function addBadRequest(operation) {
  operation.responses ??= {};
  operation.responses["400"] ??= {
    description:
      "요청 오류 — 필수값 누락·허용되지 않은 값·형식 오류 등 검증 실패",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ErrorResponse" },
      },
    },
  };
}

function addUnauthorized(operation) {
  operation.responses ??= {};
  operation.responses["401"] ??= {
    description: "로그인이 필요하다 — omf_session 쿠키가 없거나 유효하지 않다",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ErrorResponse" },
      },
    },
  };
}

function addEnumValues(schema, values) {
  assert(Array.isArray(schema.enum), "enum 스키마가 아닙니다.");
  for (const value of values)
    if (!schema.enum.includes(value)) schema.enum.push(value);
}

function appendDescription(target, sentence) {
  target.description = `${target.description ?? ""}\n\n${sentence}`.trim();
}

function assertSourceMatchesServerCommit() {
  const git = (...args) =>
    execFileSync("git", args, { cwd: ROOT_DIR, encoding: "utf8" }).trim();
  const currentSourceTree = git("rev-parse", "HEAD:src");
  const baselineSourceTree = git("rev-parse", `${SERVER_COMMIT}:src`);
  const dirtySource = git(
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    "src",
  );
  assert(
    currentSourceTree === baselineSourceTree && dirtySource.length === 0,
    `현재 src가 서버 기준 커밋 ${SERVER_COMMIT}과 다릅니다. 기준 버전을 갱신한 뒤 생성하세요.`,
  );
}

function applyAuthentication(document, key, operation) {
  document.components.securitySchemes ??= {};
  document.components.securitySchemes.omfSession = {
    type: "apiKey",
    in: "cookie",
    name: "omf_session",
    description:
      "로그인 성공 시 서버가 발급하는 HttpOnly 세션 쿠키. 브라우저 교차 출처 요청은 credentials: include, Axios는 withCredentials: true를 사용한다.",
  };

  if (key === "POST /app/sessions") {
    operation.security = [];
    const success = operation.responses?.["200"];
    assert(success, "POST /app/sessions의 200 응답이 없습니다.");
    success.headers ??= {};
    success.headers["Set-Cookie"] = {
      description:
        "omf_session HttpOnly 세션 쿠키. SameSite=Lax, Path=/이며 Secure는 COOKIE_SECURE 설정을 따른다.",
      schema: { type: "string" },
    };
    return;
  }

  operation.security = [{ omfSession: [] }];
  addUnauthorized(operation);
}

function applyLogisticsPatches(document) {
  const schemas = document.components.schemas;

  addEnumValues(schemas.GoodsIssue.properties.sourceDocumentTypeCode, [
    "SHIPMENT",
  ]);
  schemas.GoodsIssue.properties.sourceDocumentTypeCode.description =
    schemas.GoodsIssue.properties.sourceDocumentTypeCode.description
      .replace(
        "처분 결정(`DISPOSITION_DECISION` → `quality.disposition_decision`, 제품 폐기) 셋이다.",
        "처분 결정(`DISPOSITION_DECISION` → `quality.disposition_decision`, 제품 폐기) · 출하(`SHIPMENT` → `logistics.shipment`, 출하 확정) 넷이다.",
      )
      .replace("`enum` 3값", "`enum` 4값");
  schemas.GoodsIssue.properties.sourceDocumentTypeCode["x-internal-note"] =
    schemas.GoodsIssue.properties.sourceDocumentTypeCode[
      "x-internal-note"
    ].replace(
      "2026-09-01 `omf-mes#336` — 자유 문자열에서 `enum` 3값으로 닫았다.",
      "2026-09-01 `omf-mes#336`에서 원본 계약을 `enum` 3값으로 닫았고, v0.1.2 서버 구현 기준선이 응답값 SHIPMENT를 더해 4값으로 확장한다.",
    );
  appendDescription(
    schemas.GoodsIssue.properties.sourceDocumentTypeCode,
    "서버 구현 기준 추가값: SHIPMENT → logistics.shipment. 출하 등록이 내부에서 만든 출고 전표의 원천이다(통보 217).",
  );

  addEnumValues(schemas.LotStatusHistoryEvent.properties.transitionCode, [
    "C17",
    "C18",
    "C19",
    "C20",
  ]);
  schemas.LotStatusHistoryEvent.description =
    schemas.LotStatusHistoryEvent.description.replace(
      "도식스펙03 §1.3 전이 9종(C4·C5·C6·C7·C8·C9·C10·C14·C15) 전건을 담는다.",
      "원본 설계의 전이 9종(C4·C5·C6·C7·C8·C9·C10·C14·C15)에 서버 구현 전이 C17·C18·C19·C20을 더해 13종을 담는다.",
    );
  schemas.LotStatusHistoryEvent.properties.transitionCode.description =
    schemas.LotStatusHistoryEvent.properties.transitionCode.description.replace(
      "전이 9종 — 도식스펙03 §1.3 · W-03-01 §5-1 표",
      "원본 설계 전이 9종 — 도식스펙03 §1.3 · W-03-01 §5-1 표. 서버 구현 기준 C17·C18·C19·C20을 더해 응답은 13종이다",
    );
  schemas.LotStatusHistoryEvent.properties.sourceDocumentTypeCode.description =
    schemas.LotStatusHistoryEvent.properties.sourceDocumentTypeCode.description.replace(
      "전이 9종에서 도출했다",
      "기존 전이 9종에서 도출했다",
    );
  appendDescription(
    schemas.LotStatusHistoryEvent.properties.transitionCode,
    "서버 구현 기준 추가값: C17·C18·C19=처분 전이, C20=재고 재등록 후 정상 전이(통보 089·218).",
  );
  addEnumValues(
    schemas.LotStatusHistoryEvent.properties.sourceDocumentTypeCode,
    ["DISPOSITION_DECISION", "STOCK_TRANSFER"],
  );
  appendDescription(
    schemas.LotStatusHistoryEvent.properties.sourceDocumentTypeCode,
    "서버 구현 기준 추가값: DISPOSITION_DECISION=C17~C19의 원천, STOCK_TRANSFER=C20의 원천(통보 089·218 및 구현 코드 대조).",
  );

  schemas.InventoryCountLine.required =
    schemas.InventoryCountLine.required.filter((name) => name !== "systemQty");
  appendDescription(
    schemas.InventoryCountLine.properties.systemQty,
    "서버 구현 기준: 블라인드 실사이면 counted 값과 관계없이 이 키를 생략한다(통보 273 및 구현 코드 대조).",
  );

  const goodsReceiptSource =
    schemas.GoodsReceipt.properties.sourceDocumentTypeCode;
  delete goodsReceiptSource["x-no-example"];

  const documentProgressReason =
    schemas.DocumentProgress.properties.cancelBlockedReasonCode;
  appendDescription(
    documentProgressReason,
    "서버 구현 기준: 출하가 소유한 하위 입고·출고 전표의 개별 취소 차단도 현재 STATE_LOCKED로 반환한다(통보 217).",
  );

  const lotStatusEvents = getOperation(
    document,
    "GET /trace/lot-status-events",
  );
  lotStatusEvents.summary =
    "LOT 상태 변경이력 조회 — 서버 구현 기준 전이 13종 전건";
  lotStatusEvents.description = lotStatusEvents.description.replace(
    "도식스펙03 §1.3 공통 범례가 요구하는 상태 전이 9종(C4·C5·C6·C7·C8·C9·C10·C14·C15) 전건을 사건별 행으로 낸다",
    "원본 설계 상태 전이 9종(C4·C5·C6·C7·C8·C9·C10·C14·C15)과 서버 구현 전이 C17·C18·C19·C20을 합친 13종을 사건별 행으로 낸다",
  );
  addBadRequest(lotStatusEvents);
}

function applyEquipmentPatches(document) {
  const schemas = document.components.schemas;
  schemas.MaintenanceResultCreate.properties.closed.description =
    "서버 v0.1.2 구현 기준: true는 결과코드별 완료 의미가 확정되지 않아 항상 422 INVALID다. false 또는 생략만 사용한다(통보 113).";
  schemas.MaintenanceResultCreate.properties.resetCounter.description =
    "서버 v0.1.2 구현 기준: true는 예방보전 시행일 기준이 확정되지 않아 항상 422 INVALID다. false 또는 생략만 사용한다(통보 114).";
  schemas.MaintenanceResultCreate.properties.shotCountAfterReset.description =
    "서버 v0.1.2 구현 기준: 누계 리셋을 지원하지 않으므로 null 또는 생략만 허용한다(통보 114).";
  schemas.MaintenanceResultCreate.properties.shotCountAfterReset.example = null;
  schemas.MaintenanceResultUpdate.properties.closed.description =
    "서버 v0.1.2 구현 기준: true는 항상 422 INVALID다. 마감 전 수정만 지원한다(통보 113).";
  schemas.MaintenanceResultUpdate.properties.closed.example = false;

  schemas.MaintenanceResult.properties.resetCounter.description =
    "툴 누계 리셋 여부. 서버 v0.1.2의 신규 등록·수정에서는 false로 고정되며, 기존 데이터와 원본 계약 호환을 위해 응답 필드를 유지한다(통보 114).";
  schemas.MaintenanceResult.properties.shotCountBeforeReset.description =
    "리셋 직전 누계 스냅샷. 서버 v0.1.2의 신규 등록·수정에서는 null로 고정되며 기존 데이터 조회용 필드로 유지한다(통보 114).";
  schemas.MaintenanceResult.properties.shotCountBeforeReset.example = null;
  schemas.MaintenanceResult.properties.shotCountAfterReset.description =
    "리셋 후 시작값. 서버 v0.1.2의 신규 등록·수정에서는 null로 고정되며 기존 데이터 조회용 필드로 유지한다(통보 114).";
  schemas.MaintenanceResult.properties.shotCountAfterReset.example = null;
  appendDescription(
    schemas.MaintenanceResult.properties.closed,
    "서버 v0.1.2의 신규 등록·수정에서는 false로 고정된다(통보 113).",
  );

  getOperation(document, "POST /maintenance/results").description =
    "지시에서 이어받거나 고장에서 바로 등록한다. 지시가 없어도 성립한다. 서버 v0.1.2는 closed=true·resetCounter=true를 항상 422 INVALID로 거부하므로 마감하지 않고 누계를 초기화하지 않는 실적만 등록한다(통보 113·114).";
  appendDescription(
    getOperation(document, "PUT /maintenance/results/{maintenanceResultId}"),
    "서버 v0.1.2는 closed=true를 항상 422 INVALID로 거부한다(통보 113).",
  );

  appendDescription(
    getOperation(document, "POST /maintenance/downtimes/{downtimeId}:close"),
    "서버 구현 기준: 종료시각은 이 API에 한해 서버의 최초 처리시각을 사용한다. 오프라인 전송 지연을 허용하며 같은 Idempotency-Key 재전송에는 최초 종료시각과 응답을 재생한다(통보 109).",
  );

  const breakdownCreate = getOperation(
    document,
    "POST /maintenance/breakdowns",
  );
  breakdownCreate.description = breakdownCreate.description.replace(
    "사진은 이 요청에 싣지 않는다 — 만들어진 건에 따로 붙인다.",
    "사진은 이 요청에 싣지 않으며 현재 첨부 API도 미구현이므로 사진 첨부를 제공하지 않는다.",
  );
}

function applyAppPatches(document) {
  const login = getOperation(document, "POST /app/sessions");
  login["x-internal-note"] =
    "서버 구현 기준: 인증 세션은 omf_session HttpOnly 쿠키로 운반한다. 로그인 성공 응답이 쿠키를 설정하고 이후 요청은 브라우저 자격증명을 포함한다.";
  document.components.schemas.LoginRequest["x-internal-note"] =
    "서버 구현 기준: 자격증명은 app.user_credential의 password_hash·failed_attempt_count·last_login_at으로 관리한다.";

  // 서버는 이 값을 이미 계산하고 있었으나 원본 계약에 칸이 없어 내리지 못했다.
  // 화면이 강제 변경으로 보낼 근거가 이것뿐이라 기준선에서 칸을 연다.
  const session = document.components.schemas.Session;
  session.properties.mustChangePassword = {
    type: "boolean",
    example: false,
    description:
      "임시 비밀번호로 들어왔는가. true면 화면은 곧바로 비밀번호 변경(POST /app/users/me:change-password)으로 보낸다. 서버가 뽑아 준 임시 비밀번호로 로그인하면 true이고, 관리자가 등록할 때 직접 정한 비밀번호로 로그인하면 false다.",
  };
  // 서버가 «언제나» 싣는다 — 부재를 「모른다」로 읽을 자리를 만들지 않는다(공유계약 G-9).
  session.required.push("mustChangePassword");
  appendDescription(
    session,
    "서버 구현 기준: mustChangePassword는 로그인 응답과 GET /app/sessions/current 양쪽에 항상 실린다.",
  );
  appendDescription(
    getOperation(document, "POST /app/document-issues"),
    "서버 구현 기준: IDENTIFICATION_TAG는 항상 422 STATE_LOCKED, DELIVERY_LABEL은 항상 422 INVALID다. 두 문서 유형은 현재 클라이언트에서 발행 요청하지 않는다(I-27 마감 결정).",
  );
  appendDescription(
    getOperation(document, "GET /app/printers"),
    "서버 구현 기준: 실제 상태 수집 경로가 없어 statusCode를 OFFLINE으로 고정 반환한다. 연결 상태 판정에 사용하지 않는다.",
  );
}

/**
 * 사용자 등록이 초기 비밀번호까지 만든다(사용자 결정 2026-09-12).
 * 원본 계약은 비밀번호를 :reset-password 한 곳에만 두어, 등록만으로는 로그인할 수 없는
 * 계정이 남았다. 기준선은 서버가 실제로 받는 칸과 내리는 칸을 그대로 적는다.
 */
function applyMdmPatches(document) {
  const schemas = document.components.schemas;

  schemas.AppUserCreate.properties.password = {
    type: "string",
    format: "password",
    writeOnly: true,
    minLength: 8,
    "x-no-example": "비밀번호에 예시를 두지 않는다",
    description:
      "관리자가 직접 정하는 초기 비밀번호. 보내면 그 값이 계정의 비밀번호가 되고 첫 로그인 강제 변경이 걸리지 않는다(Session.mustChangePassword=false). 생략하면 서버가 임시 비밀번호를 만들어 응답 temporaryPassword로 한 번만 내려주고 강제 변경을 건다. 최소 길이 8만 검사하며 조합 규칙은 없다 — PasswordChangeRequest.newPassword와 같은 기준이다.",
  };
  appendDescription(
    schemas.AppUserCreate,
    "서버 구현 기준: 등록은 계정과 자격을 한 트랜잭션으로 만든다. password를 생략해도 계정은 즉시 로그인할 수 있다. 8자 미만은 400 RANGE, 문자열이 아니면 400 INVALID이며 null은 「보내지 않음」으로 읽는다.",
  );

  schemas.AppUserCreated = {
    description:
      "사용자 등록 응답. temporaryPassword는 요청에 password를 담지 «않았을» 때만 실린다 — 담았다면 그 칸 자체가 없다.",
    allOf: [
      { $ref: "#/components/schemas/AppUser" },
      {
        type: "object",
        properties: {
          temporaryPassword: {
            type: "string",
            readOnly: true,
            "x-no-example": "실제 임시 비밀번호 모양을 남기지 않는다",
            description:
              "서버가 만든 임시 비밀번호. 이 응답에서 한 번만 보이고 서버는 해시만 저장한다(:reset-password와 같은 규약). 같은 Idempotency-Key로 재전송하면 저장된 앞 응답을 그대로 돌려주므로 값이 바뀌지 않는다. 이 값으로 로그인하면 Session.mustChangePassword가 true다.",
          },
        },
      },
    ],
  };

  const create = getOperation(document, "POST /app/users");
  create.responses["201"].content["application/json"].schema = {
    $ref: "#/components/schemas/AppUserCreated",
  };
  appendDescription(
    create,
    "서버 구현 기준: 비밀번호를 함께 정할 수 있다. 생략하면 응답 temporaryPassword로 임시 비밀번호가 한 번만 내려온다 — 화면은 이 값을 그 자리에서 관리자에게 보여 주어야 한다. 다시 받을 길은 :reset-password로 새로 뽑는 것뿐이다.",
  );
}

function applyQualityPatches(document) {
  const schemas = document.components.schemas;
  delete schemas.DispositionDecision.properties.dispositionTypeCode[
    "x-no-example"
  ];
  delete schemas.DispositionDecisionCreate.properties.dispositionTypeCode[
    "x-no-example"
  ];

  for (const key of [
    "GET /quality/defect-records",
    "GET /quality/defect-records/distribution",
    "GET /quality/nonconformances/{nonconformanceId}/disposition-decisions",
    "GET /quality/disposition-decisions",
    "GET /quality/concessions",
  ]) {
    addBadRequest(getOperation(document, key));
  }

  for (const key of [
    "GET /quality/defect-records",
    "GET /quality/defect-records/distribution",
  ]) {
    const operation = getOperation(document, key);
    getParameter(operation, "detectedFrom").required = true;
    getParameter(operation, "detectedTo").required = true;
  }
}

function applyShipmentPatches(document) {
  const schemas = document.components.schemas;
  const expedited = schemas.ShipmentCreate.properties.expedited;
  const staleExpeditedText =
    "원천 문서 유형의 값 목록만 아직 확정 전이다(omf-mes#145).";
  assert(
    expedited.description.includes(staleExpeditedText),
    "ShipmentCreate.expedited의 낡은 설명을 찾지 못했습니다.",
  );
  expedited.description = expedited.description.replace(
    staleExpeditedText,
    "원천 문서 유형은 SHIPMENT로 구현됐다(통보 221).",
  );
  expedited["x-internal-note"] =
    "서버 구현 기준: receiptTypeCode=PRODUCT, sourceDocumentTypeCode=SHIPMENT, sourceDocumentId=shipmentId다(통보 221).";

  const stockConflict = schemas.StockReinstatementConflictResponse;
  const shipmentConflict = schemas.ShipmentConflictResponse;
  shipmentConflict.required.push("conflictCause");
  shipmentConflict.properties.conflictCause.description =
    shipmentConflict.properties.conflictCause.description.replace(
      " — code=VERSION_CONFLICT 일 때 함께 내린다",
      ". code와 독립적인 필수 원인 축으로 모든 409 응답에 포함된다",
    );
  stockConflict.properties.conflictCause = structuredClone(
    shipmentConflict.properties.conflictCause,
  );
  stockConflict.required.push("conflictCause");
  appendDescription(
    stockConflict.properties.conflictCause,
    "서버는 공용 충돌 봉투를 사용하므로 StockReinstatementConflictResponse에도 이 키를 항상 싣는다(통보 221).",
  );

  for (const key of [
    "GET /logistics/sales-orders",
    "GET /logistics/shipment-requests",
    "GET /logistics/shipment-requests/summary",
    "GET /logistics/shipment-lot-allocations",
    "GET /logistics/shipments",
    "GET /quality/nonconformances",
    "GET /quality/disposition-candidates",
  ]) {
    addBadRequest(getOperation(document, key));
  }

  const nonconformances = getOperation(
    document,
    "GET /quality/nonconformances",
  );
  getParameter(nonconformances, "openedFrom").required = true;
  getParameter(nonconformances, "openedTo").required = true;

  for (const key of [
    "GET /logistics/shipment-requests",
    "GET /logistics/shipment-requests/summary",
  ]) {
    getParameter(getOperation(document, key), "shipDateFrom").required = true;
  }

  const requestSort = getParameter(
    getOperation(document, "GET /logistics/shipment-requests"),
    "sort",
  );
  requestSort.schema.enum = [
    "requestedShipDate",
    "customerId",
    "shipmentRequestNo",
  ];
  requestSort.schema.example = "requestedShipDate";
  appendDescription(
    requestSort,
    "서버 구현 기준 허용 키는 requestedShipDate·customerId·shipmentRequestNo다(통보 201).",
  );

  const shipments = getOperation(document, "GET /logistics/shipments");
  getParameter(shipments, "shipDateFrom").required = true;
  const shipmentSort = getParameter(shipments, "sort");
  shipmentSort.schema.enum = ["shippedAt", "shipmentNo"];
  shipmentSort.schema.example = "shippedAt";
  appendDescription(
    shipmentSort,
    "서버 구현 기준 허용 키는 shippedAt·shipmentNo다(통보 219).",
  );
  appendDescription(
    getParameter(shipments, "shipDateFrom"),
    "서버 구현 기준: shippedAt을 출하 창고가 속한 공장의 로컬 날짜로 비교한다(통보 219).",
  );
  appendDescription(
    getParameter(shipments, "shipDateTo"),
    "서버 구현 기준: 끝 날짜를 포함하며 다음 날 공장 자정 미만으로 비교한다(통보 219).",
  );
}

function applyKnownDifferences(documentsByOperation) {
  for (const difference of KNOWN_DIFFERENCES) {
    for (const key of difference.operations) {
      const record = documentsByOperation.get(key);
      if (!record) continue;
      record.operation["x-omf-known-differences"] ??= [];
      record.operation["x-omf-known-differences"].push({
        designRecord: difference.id,
        summary: difference.summary,
      });
    }
  }
}

function readImplementedBindings() {
  const bindings = [];
  const sourceFiles = listFiles(join(ROOT_DIR, "src")).filter(
    (file) =>
      file.endsWith(".controller.ts") &&
      !file.split(/[\\/]/).some((segment) => segment.startsWith("__")),
  );
  for (const file of sourceFiles) {
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node) => {
      const decorators = ts.canHaveDecorators(node)
        ? (ts.getDecorators(node) ?? [])
        : [];
      for (const decorator of decorators) {
        const expression = decorator.expression;
        if (
          ts.isCallExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          expression.expression.text === "Contract" &&
          expression.arguments.length === 1 &&
          ts.isStringLiteralLike(expression.arguments[0])
        ) {
          bindings.push(expression.arguments[0].text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return bindings;
}

function build() {
  assertSourceMatchesServerCommit();
  const contractFiles = readdirSync(CONTRACT_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort();
  const bindingKeys = readImplementedBindings();
  const implementedBindings = new Set(bindingKeys);
  const documents = new Map();
  const documentsByOperation = new Map();
  const originalHashes = new Map();

  for (const file of contractFiles) {
    const source = readFileSync(join(CONTRACT_DIR, file), "utf8");
    const document = JSON.parse(source);
    originalHashes.set(file, sha256(source));
    documents.set(file, document);

    for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
      for (const method of HTTP_METHODS) {
        const operation = pathItem[method];
        if (!operation) continue;
        const key = operationKey(method, path);
        assert(
          !documentsByOperation.has(key),
          `계약 오퍼레이션이 중복됐습니다: ${key}`,
        );
        documentsByOperation.set(key, { file, operation });
      }
    }
  }

  const phantomBindings = [...implementedBindings].filter(
    (key) => !documentsByOperation.has(key),
  );
  assert(
    phantomBindings.length === 0,
    `계약에 없는 @Contract 바인딩: ${phantomBindings.join(", ")}`,
  );
  const invalidPartialOperations = [...PARTIAL_OPERATIONS.keys()].filter(
    (key) => !documentsByOperation.has(key) || !implementedBindings.has(key),
  );
  assert(
    invalidPartialOperations.length === 0,
    `부분 구현 목록에 없거나 미구현인 오퍼레이션이 있습니다: ${invalidPartialOperations.join(", ")}`,
  );
  const bindingCounts = new Map();
  for (const key of bindingKeys) {
    bindingCounts.set(key, (bindingCounts.get(key) ?? 0) + 1);
  }
  const duplicateBindings = [...bindingCounts]
    .filter(([, count]) => count > 1)
    .map(([key]) => key);
  assert(
    duplicateBindings.length === 0,
    `두 컨트롤러가 같은 계약을 주장합니다: ${duplicateBindings.join(", ")}`,
  );
  // ⚠ 이 수치는 **제 변경 전부터 실제와 1 어긋나 있었다** — 사본을 마지막으로 뽑은 뒤
  //    FR-005 이행 공장 지정 PUT 1건이 들어왔는데 여기만 487 로 남았다(실측: 선반영 직전이
  //    이미 488). SHIP-UNIT-01 출하 단위 6건(장부 P-24)을 더해 **494** 다.
  //    `contract-registry.spec.ts`·`contract-coverage.spec.ts` 의 같은 수치와 맞춘다.
  assert(
    documentsByOperation.size === 494,
    `계약 오퍼레이션 수가 494가 아닙니다: ${documentsByOperation.size}`,
  );

  const missingOperations = [...documentsByOperation.keys()].filter(
    (key) => !implementedBindings.has(key),
  );
  // ⚠ 이 수치도 사본 상태를 따라 움직인다. 4 → **1** — 종전 넷 중 첨부 셋이 그 사이 구현됐고,
  //    SHIP-UNIT-01 ③b 3경로는 이 전달본 시점에 «구현돼» 미구현이 아니다.
  //    ⛔ 남은 하나는 `GET /app/dashboard-summary` 다(집계 대상 도메인 미완).
  assert(
    missingOperations.length === 1,
    `미구현 오퍼레이션 수가 1이 아닙니다: ${missingOperations.length}`,
  );
  assert(
    missingOperations.every((key) => EXCLUDED_OPERATIONS.has(key)),
    `예상하지 못한 미구현 오퍼레이션: ${missingOperations.join(", ")}`,
  );
  const fullyImplementedCount = [...documentsByOperation.keys()].filter(
    (key) => implementedBindings.has(key) && !PARTIAL_OPERATIONS.has(key),
  ).length;

  for (const [key, { operation }] of documentsByOperation) {
    const isImplemented = implementedBindings.has(key);
    operation["x-omf-server-implementation"] = {
      status: isImplemented
        ? PARTIAL_OPERATIONS.has(key)
          ? "partial"
          : "implemented"
        : "not-implemented",
      serverVersion: SERVER_VERSION,
      serverCommit: SERVER_COMMIT,
      ...(PARTIAL_OPERATIONS.has(key)
        ? { limitation: PARTIAL_OPERATIONS.get(key) }
        : {}),
      ...(!isImplemented ? { reason: EXCLUDED_OPERATIONS.get(key) } : {}),
    };
    if (isImplemented) {
      const { file } = documentsByOperation.get(key);
      applyAuthentication(documents.get(file), key, operation);
    }
  }

  applyLogisticsPatches(documents.get("logistics-01자재창고.json"));
  applyQualityPatches(documents.get("quality-03품질.json"));
  applyShipmentPatches(documents.get("shipment-04제품출하.json"));
  applyEquipmentPatches(documents.get("equipment-05설비툴.json"));
  applyAppPatches(documents.get("app-공통.json"));
  applyMdmPatches(documents.get("mdm-기준정보.json"));
  applyKnownDifferences(documentsByOperation);

  rmSync(OPENAPI_DIR, { recursive: true, force: true });
  mkdirSync(OPENAPI_DIR, { recursive: true });

  const generatedFiles = [];
  for (const [file, document] of documents) {
    const originalVersion = document.info?.version;
    document.info.version = GENERATED_VERSION;
    document["x-omf-server-baseline"] = {
      status: "interim-server-implementation-baseline",
      generatedOn: GENERATED_ON,
      designContractCommit: CONTRACT_COMMIT,
      designContractVersion: originalVersion,
      serverVersion: SERVER_VERSION,
      serverCommit: SERVER_COMMIT,
      replacementPolicy:
        "설계팀 확정본 수신 시 폐기하고 공식 계약으로 교체한다.",
    };

    const content = `${JSON.stringify(document, null, 2)}\n`;
    const outputPath = join(OPENAPI_DIR, file);
    writeFileSync(outputPath, content);
    generatedFiles.push({
      file: relative(OUTPUT_DIR, outputPath),
      sourceSha256: originalHashes.get(file),
      generatedSha256: sha256(content),
      operations: Object.values(document.paths ?? {}).reduce(
        (count, pathItem) =>
          count + HTTP_METHODS.filter((method) => pathItem[method]).length,
        0,
      ),
    });
  }

  const manifest = {
    status: "interim-server-implementation-baseline",
    generatedOn: GENERATED_ON,
    designContractCommit: CONTRACT_COMMIT,
    serverVersion: SERVER_VERSION,
    serverCommit: SERVER_COMMIT,
    operationCounts: {
      contract: documentsByOperation.size,
      available: documentsByOperation.size - missingOperations.length,
      implemented: fullyImplementedCount,
      notImplemented: missingOperations.length,
      partial: PARTIAL_OPERATIONS.size,
    },
    authentication: {
      scheme: "omfSession",
      cookieName: "omf_session",
      anonymousOperations: ["POST /app/sessions"],
      protectedAvailableOperations:
        documentsByOperation.size - missingOperations.length - 1,
    },
    notImplementedOperations: missingOperations
      .sort()
      .map((key) => ({ operation: key, reason: EXCLUDED_OPERATIONS.get(key) })),
    partialOperations: [...PARTIAL_OPERATIONS].map(
      ([operation, limitation]) => ({ operation, limitation }),
    ),
    knownDifferenceRecords: KNOWN_DIFFERENCES.map(
      ({ id, operations, summary }) => ({ id, operations, summary }),
    ),
    files: generatedFiles,
  };
  writeFileSync(
    join(OUTPUT_DIR, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

assert(
  existsSync(CONTRACT_DIR) && statSync(CONTRACT_DIR).isDirectory(),
  "contracts 디렉터리가 없습니다.",
);
build();

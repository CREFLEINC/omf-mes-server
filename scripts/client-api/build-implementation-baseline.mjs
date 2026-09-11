import { createHash } from "node:crypto";
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

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, "../..");
const CONTRACT_DIR = join(ROOT_DIR, "contracts");
const OUTPUT_DIR = join(ROOT_DIR, "docs/client-api/2026-09-11");
const OPENAPI_DIR = join(OUTPUT_DIR, "openapi");

const SERVER_VERSION = "v0.1.2";
const SERVER_COMMIT = "72a960c0599711458a0ce4198b34a11d5353a645";
const GENERATED_VERSION = "0.1.2-server.20260911";
const CONTRACT_COMMIT = readFileSync(
  join(CONTRACT_DIR, "COMMIT.txt"),
  "utf8",
).trim();
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

const EXCLUDED_OPERATIONS = new Map([
  [
    "GET /app/document-issues/{documentIssueLogId}/rendition",
    "렌더링 산출물 저장·수명 규약이 없다.",
  ],
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
      "긴급 직행과 재등록은 창고 관리 수준에 따라 위치 입력을 검증하며 409 응답에 conflictCause가 포함될 수 있다.",
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
    operations: ["GET /inventory/counts/{inventoryCountId}/lines"],
    summary:
      "블라인드 실사의 미실사 라인은 systemQty를 생략한다. counted=false로 미실사를 판정한다.",
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

function addEnumValues(schema, values) {
  assert(Array.isArray(schema.enum), "enum 스키마가 아닙니다.");
  for (const value of values)
    if (!schema.enum.includes(value)) schema.enum.push(value);
}

function appendDescription(target, sentence) {
  target.description = `${target.description ?? ""}\n\n${sentence}`.trim();
}

function applyLogisticsPatches(document) {
  const schemas = document.components.schemas;

  addEnumValues(schemas.GoodsIssue.properties.sourceDocumentTypeCode, [
    "SHIPMENT",
  ]);
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
    "서버 구현 기준: 블라인드 실사이고 counted=false이면 이 키를 생략한다(통보 273).",
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
  stockConflict.properties.conflictCause = structuredClone(
    shipmentConflict.properties.conflictCause,
  );
  appendDescription(
    stockConflict.properties.conflictCause,
    "서버는 공용 충돌 봉투를 사용하므로 StockReinstatementConflictResponse에도 이 키를 실을 수 있다(통보 221).",
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
  appendDescription(
    requestSort,
    "서버 구현 기준 허용 키는 requestedShipDate·customerId·shipmentRequestNo다(통보 201).",
  );

  const shipments = getOperation(document, "GET /logistics/shipments");
  getParameter(shipments, "shipDateFrom").required = true;
  const shipmentSort = getParameter(shipments, "sort");
  shipmentSort.schema.enum = ["shippedAt", "shipmentNo"];
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
  const pattern = /@Contract\(\s*["']([A-Z]+\s+\/[^"']+)["']\s*\)/g;

  for (const file of sourceFiles) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(pattern)) bindings.push(match[1]);
  }
  return bindings;
}

function build() {
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
  assert(
    documentsByOperation.size === 487,
    `계약 오퍼레이션 수가 487이 아닙니다: ${documentsByOperation.size}`,
  );

  const missingOperations = [...documentsByOperation.keys()].filter(
    (key) => !implementedBindings.has(key),
  );
  assert(
    missingOperations.length === 5,
    `미구현 오퍼레이션 수가 5가 아닙니다: ${missingOperations.length}`,
  );
  assert(
    missingOperations.every((key) => EXCLUDED_OPERATIONS.has(key)),
    `예상하지 못한 미구현 오퍼레이션: ${missingOperations.join(", ")}`,
  );

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
  }

  applyLogisticsPatches(documents.get("logistics-01자재창고.json"));
  applyQualityPatches(documents.get("quality-03품질.json"));
  applyShipmentPatches(documents.get("shipment-04제품출하.json"));
  applyKnownDifferences(documentsByOperation);

  rmSync(OPENAPI_DIR, { recursive: true, force: true });
  mkdirSync(OPENAPI_DIR, { recursive: true });

  const generatedFiles = [];
  for (const [file, document] of documents) {
    const originalVersion = document.info?.version;
    document.info.version = GENERATED_VERSION;
    document["x-omf-server-baseline"] = {
      status: "interim-server-implementation-baseline",
      generatedOn: "2026-09-11",
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
    generatedOn: "2026-09-11",
    designContractCommit: CONTRACT_COMMIT,
    serverVersion: SERVER_VERSION,
    serverCommit: SERVER_COMMIT,
    operationCounts: {
      contract: documentsByOperation.size,
      implemented: documentsByOperation.size - missingOperations.length,
      notImplemented: missingOperations.length,
      partial: PARTIAL_OPERATIONS.size,
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

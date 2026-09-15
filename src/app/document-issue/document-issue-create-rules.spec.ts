import { ERROR_CODE } from "../../common/errors";
import {
  assertReissueReason,
  DocumentIssueCreateInput,
  DocumentIssueTargetFacts,
  prepareDocumentIssueTargets,
  PreparedDocumentIssueTarget,
  qualifyDocumentIssueTarget,
} from "./document-issue-create-rules";
import {
  DOCUMENT_TARGET_TYPES,
  DocumentTargetType,
} from "./document-issue-target-lookup";
import { DocumentIssueView } from "./document-issue-view";

type DocumentType = DocumentIssueView["documentTypeCode"];

const PAIRS: ReadonlyArray<[DocumentType, readonly DocumentTargetType[]]> = [
  ["MATERIAL_LOT_LABEL", ["LOT"]],
  ["GOODS_ISSUE_QR", ["GOODS_ISSUE_LINE", "HANDLING_UNIT"]],
  ["PRODUCTION_LOT_LABEL", ["LOT"]],
  ["IDENTIFICATION_TAG", ["SERIAL_NUMBER"]],
  ["PACKING_LABEL", ["HANDLING_UNIT"]],
  ["DELIVERY_LABEL", ["SHIPMENT_LOT_ALLOCATION"]],
  ["CERTIFICATE_OF_ANALYSIS", ["INSPECTION_RESULT"]],
  ["TOOL_LABEL", ["MOLD"]],
  ["LOCATION_LABEL", ["LOCATION"]],
];

describe("발행 요청 규칙 (I-27 C1)", () => {
  it("9개 문서와 8개 대상의 짝을 정확히 닫는다", () => {
    for (const [documentTypeCode, allowed] of PAIRS) {
      for (const targetTypeCode of DOCUMENT_TARGET_TYPES) {
        const run = () =>
          prepareDocumentIssueTargets(input(documentTypeCode, targetTypeCode));
        if (allowed.includes(targetTypeCode)) expect(run).not.toThrow();
        else
          expectFailure(run, ERROR_CODE.INVALID, "targets[0].targetTypeCode");
      }
    }
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, 1.5])(
    "안전하지 않은 targetId %p는 400 RANGE다",
    (targetId) => {
      expectFailure(
        () =>
          prepareDocumentIssueTargets({
            ...input("LOCATION_LABEL", "LOCATION"),
            targets: [{ targetTypeCode: "LOCATION", targetId }],
          }),
        ERROR_CODE.RANGE,
        "targets[0].targetId",
        400,
      );
    },
  );

  it("안전하지 않은 lotId를 원본 index로 거부한다", () => {
    expectFailure(
      () =>
        prepareDocumentIssueTargets({
          documentTypeCode: "MATERIAL_LOT_LABEL",
          targets: [
            { targetTypeCode: "LOT", targetId: 1 },
            {
              targetTypeCode: "LOT",
              targetId: 2,
              lotId: Number.MAX_SAFE_INTEGER + 1,
            },
          ],
        }),
      ERROR_CODE.RANGE,
      "targets[1].lotId",
      400,
    );
  });

  it("같은 대상 중복을 두 번째 원본 index로 거부한다", () => {
    expectFailure(
      () =>
        prepareDocumentIssueTargets({
          documentTypeCode: "LOCATION_LABEL",
          targets: [
            { targetTypeCode: "LOCATION", targetId: 7 },
            { targetTypeCode: "LOCATION", targetId: 7 },
          ],
        }),
      ERROR_CODE.INVALID,
      "targets[1].targetId",
    );
  });

  it("없는 대상은 422 INVALID다", () => {
    expectFailure(
      () =>
        qualifyDocumentIssueTarget(
          "LOCATION_LABEL",
          prepared("LOCATION"),
          undefined,
        ),
      ERROR_CODE.INVALID,
      "targets[0].targetId",
    );
  });

  it.each([
    ["MATERIAL", "INSPECTION_PENDING"],
    ["MATERIAL", "NORMAL"],
  ])("자재 LOT의 %s/%s는 자기 LOT으로 발행한다", (lotTypeCode, statusCode) => {
    const target = prepared("LOT");
    expect(
      qualifyDocumentIssueTarget("MATERIAL_LOT_LABEL", target, {
        targetTypeCode: "LOT",
        targetId: target.targetId,
        lotTypeCode,
        statusCode,
        completedAt: null,
      }),
    ).toBe(target.targetId);
  });

  it.each([
    ["MATERIAL", "DEFECTIVE", null, undefined],
    // ⭐ 「실적이 반영되지 않았다」가 거부의 축이다(P-18) — 완료 여부가 아니다.
    ["PRODUCTION", "NORMAL", null, "WAITING"],
    ["PRODUCTION", "NORMAL", null, undefined],
    ["PRODUCTION", "DEFECTIVE", new Date(), "ACTIVE"],
    ["PRODUCTION", "SCRAPPED", null, "ACTIVE"],
  ] as const)(
    "부적격 LOT %s/%s/%p/%s를 422 STATE_LOCKED로 거부한다",
    (lotTypeCode, statusCode, completedAt, lifecycleStatusCode) => {
      const target = prepared("LOT");
      const documentTypeCode =
        lotTypeCode === "MATERIAL"
          ? "MATERIAL_LOT_LABEL"
          : "PRODUCTION_LOT_LABEL";
      expectFailure(
        () =>
          qualifyDocumentIssueTarget(documentTypeCode, target, {
            targetTypeCode: "LOT",
            targetId: target.targetId,
            lotTypeCode,
            statusCode,
            lifecycleStatusCode,
            completedAt,
          }),
        ERROR_CODE.STATE_LOCKED,
        "targets[0].targetId",
      );
    },
  );

  it.each([
    // ⭐ P-18 — 마감 «전»에도 낸다. P-02-04 는 라벨을 찍어 그것을 스캔하는 것이 마감 입력이라,
    //    완료를 요구하면 라벨과 마감이 서로를 기다린다.
    ["실적만 반영된 검사대기 LOT", "INSPECTION_PENDING", "ACTIVE", null],
    ["실적이 반영된 정상 LOT", "NORMAL", "ACTIVE", null],
    // 마감된 LOT 은 그대로 받는다 — 재발행이 회차로 열려 있다.
    ["완료된 정상 LOT(재발행)", "NORMAL", null, new Date()],
    ["완료된 검사대기 LOT", "INSPECTION_PENDING", null, new Date()],
  ] as const)(
    "%s은 생산 LOT 라벨을 낼 수 있다",
    (_name, statusCode, lifecycleStatusCode, completedAt) => {
      const target = prepared("LOT");
      expect(
        qualifyDocumentIssueTarget("PRODUCTION_LOT_LABEL", target, {
          targetTypeCode: "LOT",
          targetId: target.targetId,
          lotTypeCode: "PRODUCTION",
          statusCode,
          lifecycleStatusCode,
          completedAt,
        }),
      ).toBe(target.targetId);
    },
  );

  it.each([
    ["GOODS_ISSUE_LINE", true, "POSTED", 31n],
    ["HANDLING_UNIT", true, "POSTED", null],
  ] as const)(
    "출고 QR %s 정상 경로의 LOT 귀속을 보존한다",
    (type, hasContent, status, lotId) => {
      const target = prepared(type);
      const facts: DocumentIssueTargetFacts =
        type === "GOODS_ISSUE_LINE"
          ? {
              targetTypeCode: type,
              targetId: target.targetId,
              lotId: 31n,
              goodsIssueStatusCode: status,
            }
          : { targetTypeCode: type, targetId: target.targetId, hasContent };
      expect(qualifyDocumentIssueTarget("GOODS_ISSUE_QR", target, facts)).toBe(
        lotId,
      );
    },
  );

  it("미전기 출고 라인과 빈 출고 포장을 거부한다", () => {
    const line = prepared("GOODS_ISSUE_LINE");
    expectFailure(
      () =>
        qualifyDocumentIssueTarget("GOODS_ISSUE_QR", line, {
          targetTypeCode: "GOODS_ISSUE_LINE",
          targetId: line.targetId,
          lotId: 31n,
          goodsIssueStatusCode: "REGISTERED",
        }),
      ERROR_CODE.STATE_LOCKED,
    );
    const unit = prepared("HANDLING_UNIT");
    expectFailure(
      () =>
        qualifyDocumentIssueTarget("GOODS_ISSUE_QR", unit, {
          targetTypeCode: "HANDLING_UNIT",
          targetId: unit.targetId,
          hasContent: false,
        }),
      ERROR_CODE.STATE_LOCKED,
    );
  });

  it("포장 라벨은 빈 포장도 허용하고 LOT을 연결하지 않는다", () => {
    const target = prepared("HANDLING_UNIT");
    expect(
      qualifyDocumentIssueTarget("PACKING_LABEL", target, {
        targetTypeCode: "HANDLING_UNIT",
        targetId: target.targetId,
        hasContent: false,
      }),
    ).toBeNull();
  });

  it("확정 시각이 있는 CONFIRMED 검사 결과만 nullable LOT 그대로 허용한다", () => {
    const target = prepared("INSPECTION_RESULT");
    expect(
      qualifyDocumentIssueTarget("CERTIFICATE_OF_ANALYSIS", target, {
        targetTypeCode: "INSPECTION_RESULT",
        targetId: target.targetId,
        lotId: null,
        statusCode: "CONFIRMED",
        confirmedAt: new Date(),
      }),
    ).toBeNull();
    expectFailure(
      () =>
        qualifyDocumentIssueTarget("CERTIFICATE_OF_ANALYSIS", target, {
          targetTypeCode: "INSPECTION_RESULT",
          targetId: target.targetId,
          lotId: 31n,
          statusCode: "REGISTERED",
          confirmedAt: null,
        }),
      ERROR_CODE.STATE_LOCKED,
    );
  });

  it("개체 태그는 품질 원천 선행 전 이름 있는 정책으로 막는다", () => {
    const target = prepared("SERIAL_NUMBER");
    expectFailure(
      () =>
        qualifyDocumentIssueTarget("IDENTIFICATION_TAG", target, {
          targetTypeCode: "SERIAL_NUMBER",
          targetId: target.targetId,
          lotId: 31n,
        }),
      ERROR_CODE.STATE_LOCKED,
    );
  });

  it("TOOL_LABEL은 조율된 MOLD writer를 전제로 nullable LOT 정상 경로다", () => {
    const target = prepared("MOLD");
    expect(
      qualifyDocumentIssueTarget("TOOL_LABEL", target, {
        targetTypeCode: "MOLD",
        targetId: target.targetId,
      }),
    ).toBeNull();
  });

  it("요청 LOT이 원천과 다르면 422 PAIR이고, 생략하면 원천을 쓴다", () => {
    const target = prepared("LOT");
    const facts: DocumentIssueTargetFacts = {
      targetTypeCode: "LOT",
      targetId: target.targetId,
      lotTypeCode: "MATERIAL",
      statusCode: "NORMAL",
      completedAt: null,
    };
    expect(
      qualifyDocumentIssueTarget("MATERIAL_LOT_LABEL", target, facts),
    ).toBe(target.targetId);
    expectFailure(
      () =>
        qualifyDocumentIssueTarget(
          "MATERIAL_LOT_LABEL",
          { ...target, requestedLotId: 99n },
          facts,
        ),
      ERROR_CODE.PAIR,
      "targets[0].lotId",
    );
  });

  it("LOT 원천이 없는 대상에 lotId를 보내면 422 PAIR다", () => {
    const target = { ...prepared("LOCATION"), requestedLotId: 99n };
    expectFailure(
      () =>
        qualifyDocumentIssueTarget("LOCATION_LABEL", target, {
          targetTypeCode: "LOCATION",
          targetId: target.targetId,
        }),
      ERROR_CODE.PAIR,
      "targets[0].lotId",
    );
  });

  it("납품 라벨은 OQC 합격 배분의 LOT과만 짝짓는다", () => {
    const target = { ...prepared("SHIPMENT_LOT_ALLOCATION"), requestedLotId: 50n };
    const facts: DocumentIssueTargetFacts = {
      targetTypeCode: "SHIPMENT_LOT_ALLOCATION", targetId: target.targetId,
      lotId: 50n, plantId: 1n, oqcPassed: true, deliveryLabelNo: null,
    };
    expect(qualifyDocumentIssueTarget("DELIVERY_LABEL", target, facts)).toBe(50n);
    expectFailure(() => qualifyDocumentIssueTarget("DELIVERY_LABEL", target,
      { ...facts, oqcPassed: false }), ERROR_CODE.STATE_LOCKED, "targets[0].targetId");
    expectFailure(() => qualifyDocumentIssueTarget("DELIVERY_LABEL",
      { ...target, requestedLotId: 51n }, facts), ERROR_CODE.PAIR, "targets[0].lotId");
  });

  it("재발행이면 비공백 활성 사유가 필수이고 원문을 보존한다", () => {
    for (const reason of [undefined, null, "", "\t\n"])
      expectFailure(
        () => assertReissueReason(true, reason, false),
        ERROR_CODE.REQUIRED,
        "reissueReasonCode",
      );
    expectFailure(
      () => assertReissueReason(true, "STOPPED", false),
      ERROR_CODE.INVALID,
      "reissueReasonCode",
    );
    expect(assertReissueReason(true, " VALID ", true)).toBe(" VALID ");
  });

  it("전건 신규도 공급된 사유는 검증하지만 저장 판단은 호출자에게 남긴다", () => {
    expect(assertReissueReason(false, undefined, false)).toBeNull();
    expectFailure(
      () => assertReissueReason(false, "", false),
      ERROR_CODE.INVALID,
      "reissueReasonCode",
    );
    expect(assertReissueReason(false, "VALID", true)).toBe("VALID");
  });
});

function input(
  documentTypeCode: DocumentType,
  targetTypeCode: DocumentTargetType,
): DocumentIssueCreateInput {
  return { documentTypeCode, targets: [{ targetTypeCode, targetId: 7 }] };
}

function prepared(
  targetTypeCode: DocumentTargetType,
): PreparedDocumentIssueTarget {
  return { index: 0, targetTypeCode, targetId: 7n, requestedLotId: null };
}

function expectCode(code: string, field?: string, status = 422): object {
  return {
    status,
    errors: [
      expect.objectContaining({
        code,
        ...(field === undefined ? {} : { field }),
      }),
    ],
  };
}

function expectFailure(
  run: () => unknown,
  code: string,
  field?: string,
  status = 422,
): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject(expectCode(code, field, status));
}

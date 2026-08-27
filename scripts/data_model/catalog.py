"""Logical naming and catalog helpers for OMF-MES model artifacts."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any


SCHEMA_TITLES = {
    "app": "공통 애플리케이션",
    "audit": "감사",
    "integration": "연계",
    "inventory": "재고",
    "logistics": "물류",
    "maintenance": "설비보전",
    "mdm": "기준정보",
    "planning": "계획",
    "production": "생산실행",
    "quality": "품질",
    "trace": "추적성",
}

TOKEN_KO = {
    "acknowledgement": "확인응답",
    "adjustment": "조정",
    "allocation": "배분",
    "analysis": "분석",
    "application": "적용",
    "approval": "승인",
    "asn": "입고예정",
    "assignment": "배정",
    "attachment": "첨부",
    "audit": "감사",
    "balance": "잔량",
    "bom": "BOM",
    "breakdown": "고장",
    "business": "사업",
    "calendar": "달력",
    "calibration": "교정",
    "cancellation": "취소",
    "cause": "원인",
    "channel": "채널",
    "code": "코드",
    "collection": "수집",
    "component": "구성품",
    "concession": "특채",
    "consumption": "소비",
    "content": "내용",
    "counter": "채번카운터",
    "count": "실사",
    "credential": "자격증명",
    "data": "데이터",
    "day": "일자",
    "decision": "판정",
    "defect": "불량",
    "definition": "정의",
    "department": "부서",
    "dependency": "선후행",
    "disposition": "처리",
    "document": "문서",
    "downtime": "비가동",
    "equipment": "설비",
    "event": "이력",
    "exception": "예외",
    "external": "외부",
    "goods": "물품",
    "group": "그룹",
    "handover": "인계",
    "handling": "물류",
    "hold": "보류",
    "idempotency": "멱등",
    "impact": "영향",
    "inbound": "입고",
    "inspection": "검사",
    "integration": "연계",
    "interface": "인터페이스",
    "inventory": "재고",
    "issue": "출고",
    "item": "품목",
    "layout": "레이아웃",
    "lease": "작업잠금",
    "legal": "법인",
    "line": "상세",
    "localized": "다국어",
    "location": "로케이션",
    "loss": "손실",
    "lot": "LOT",
    "maintenance": "보전",
    "map": "매핑",
    "material": "자재",
    "measurement": "측정",
    "member": "구성원",
    "message": "메시지",
    "mold": "금형",
    "nonconformance": "부적합",
    "notice": "공지",
    "notification": "알림",
    "number": "번호",
    "numbering": "채번",
    "observation": "관측",
    "operation": "공정",
    "order": "지시",
    "outbound": "송신",
    "partner": "거래처",
    "permission": "권한",
    "picking": "피킹",
    "plan": "계획",
    "planned": "계획",
    "plant": "공장",
    "policy": "정책",
    "printer": "프린터",
    "process": "공정",
    "production": "생산",
    "provenance": "출처",
    "purchase": "구매",
    "putaway": "적치",
    "qualification": "자격",
    "receipt": "입고",
    "reconfiguration": "재구성",
    "record": "기록",
    "recycle": "재활용",
    "relation": "관계",
    "request": "요청",
    "reservation": "예약",
    "result": "실적",
    "return": "반납",
    "role": "역할",
    "route": "경로",
    "routing": "라우팅",
    "rule": "규칙",
    "sales": "판매",
    "serial": "시리얼",
    "session": "세션",
    "setting": "설정",
    "shift": "교대",
    "shipment": "출하",
    "shopfloor": "현장",
    "sorting": "선별",
    "spare": "예비",
    "status": "상태",
    "step": "단계",
    "stock": "재고이동",
    "stop": "정지",
    "subcontract": "외주",
    "subscription": "구독",
    "substitution": "대체",
    "summary": "요약",
    "terminal": "단말",
    "text": "문구",
    "tool": "툴",
    "transaction": "트랜잭션",
    "transfer": "이동",
    "type": "유형",
    "unit": "단위",
    "uom": "단위",
    "usage": "사용",
    "user": "사용자",
    "value": "값",
    "variance": "차이",
    "version": "버전",
    "warehouse": "창고",
    "work": "작업",
    "worker": "작업자",
}


def load_catalog(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as stream:
        catalog = json.load(stream)
    enrich_catalog(catalog)
    return catalog


def korean_title(table_name: str) -> str:
    words = table_name.split("_")
    translated = [TOKEN_KO.get(word, word.upper()) for word in words]
    title = " ".join(translated)
    return title.replace("품목 단위", "품목 단위").replace("물품 입고", "입고")


def lifecycle(table: dict[str, Any]) -> str:
    name = table["name"]
    if table.get("is_partition"):
        return "PARTITION"
    if table["schema"] == "mdm" or name in {
        "role",
        "role_permission",
        "operation_policy",
        "numbering_rule",
        "approval_route",
        "approval_route_step",
        "entity_type_registry",
    }:
        return "MASTER"
    if any(
        token in name
        for token in ("event", "log", "history", "observation", "provenance")
    ):
        return "EVENT"
    if name.endswith(
        ("_line", "_step", "_member", "_content", "_allocation", "_measurement")
    ):
        return "DETAIL"
    if table["schema"] in {"audit", "trace", "integration"}:
        return "EVENT"
    return "TRANSACTION"


def table_purpose(table: dict[str, Any]) -> str:
    if table.get("description"):
        return table["description"].strip()
    title = table["logical_name"]
    kind = table["lifecycle"]
    action = {
        "MASTER": "업무 기준과 유효 상태를 관리한다.",
        "EVENT": "발생 사실과 변경 이력을 불변 기록으로 보존한다.",
        "DETAIL": "상위 업무 객체의 세부 항목과 수량·판정 정보를 관리한다.",
        "PARTITION": "대용량 이력의 기본 파티션 데이터를 보관한다.",
        "TRANSACTION": "업무 진행 상태와 실행 결과를 관리한다.",
    }[kind]
    return f"{title}의 {action}"


def enrich_catalog(catalog: dict[str, Any]) -> None:
    for table in catalog["tables"]:
        table["logical_name"] = korean_title(table["name"])
        table["lifecycle"] = lifecycle(table)
        table["purpose"] = table_purpose(table)


def table_index(catalog: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {table["qualified_name"]: table for table in catalog["tables"]}


def catalog_summary(catalog: dict[str, Any]) -> dict[str, Any]:
    tables = catalog["tables"]
    return {
        "table_count": len(tables),
        "logical_table_count": sum(not table["is_partition"] for table in tables),
        "partition_count": sum(table["is_partition"] for table in tables),
        "column_count": sum(len(table["columns"]) for table in tables),
        "relationship_count": len(catalog["relationships"]),
        "schemas": dict(sorted(Counter(table["schema"] for table in tables).items())),
    }

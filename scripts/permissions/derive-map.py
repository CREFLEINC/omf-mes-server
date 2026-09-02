"""오퍼레이션 → 필요한 기능 권한을 설계 자료에서 도출한다.

근거 둘을 잇는다.
  요구서 §3   화면 → 엔드포인트   (design/wiki/api-contracts/06-API-요구서-*.md)
  권한목록    화면 코드 = 권한 코드 (「값이 화면 코드와 1:1」)

⛔ 손으로 고치지 않는다. 설계 저장소를 갱신한 뒤 이 스크립트를 다시 돌린다.
   설계 저장소는 사본(.design-reference/omf-mes)이라 경로를 인자로 받는다.
"""

from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

SCREEN = re.compile(r"^### 3-\d+\.\s*`([A-Z]-[0-9A-Z]{2}-\d{2})`")
ENDPOINT = re.compile(r"`(GET|POST|PUT|PATCH|DELETE)\s+(/[^`?]+?)(?:\?[^`]*)?`")
SECTION = re.compile(r"^## §3\..*?(?=^## §4\.|\Z)", re.M | re.S)


def derive(design_root: Path, contracts_dir: Path) -> dict[str, list[str]]:
    mapping: dict[str, set[str]] = defaultdict(set)
    for path in sorted((design_root / "design/wiki/api-contracts").glob("06-API-요구서-*.md")):
        section = SECTION.search(path.read_text(encoding="utf-8"))
        if not section:
            continue
        screen: str | None = None
        for line in section.group(0).splitlines():
            heading = SCREEN.match(line)
            if heading:
                screen = heading.group(1)
                continue
            if screen:
                for match in ENDPOINT.finditer(line):
                    mapping[f"{match.group(1)} {match.group(2)}"].add(screen)

    # 계약에 실재하는 오퍼레이션만 남긴다 — 요구서가 앞서 나간 경로가 섞인다.
    contract: set[str] = set()
    for path in sorted(contracts_dir.glob("*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        for route, item in document.get("paths", {}).items():
            for method in item:
                if method in ("get", "post", "put", "patch", "delete"):
                    contract.add(f"{method.upper()} {route}")

    return {key: sorted(value) for key, value in sorted(mapping.items()) if key in contract}


def main() -> int:
    design_root = Path(sys.argv[1] if len(sys.argv) > 1 else ".design-reference/omf-mes")
    if not design_root.exists():
        print(f"설계 저장소 사본이 없다: {design_root}", file=sys.stderr)
        return 1

    mapping = derive(design_root, Path("contracts"))
    print(json.dumps(mapping, ensure_ascii=False, indent=2))
    print(f"# 도출 {len(mapping)}건", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

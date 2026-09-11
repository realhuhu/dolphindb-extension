"""Reuse the official debugger's DolphinDB wire encoding without its VS Code host."""

import argparse
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def sync(check=False):
    upstream = ROOT / "upstream/vscode-extension"
    original = (upstream / "src/debugger/utils.ts").read_text(encoding="utf-8")
    code = original[original.index("/** 基本数据类型"):original.index("/** Normalize path")].rstrip()
    code = code.replace("item instanceof Array", "Array.isArray(item)").replace("value instanceof Array", "Array.isArray(value)")
    code = "\n".join(line.rstrip() for line in code.splitlines())
    header = (
        "// Generated from DolphinDB VS Code src/debugger/utils.ts (Apache-2.0).\n"
        "// Rebuild with scripts/sync_debugger.py; see debugger-provenance.json.\n"
        "import { DdbObj, DdbDict, DdbString, DdbVectorString, DdbVectorInt, DdbVectorAny, "
        "DdbInt, DdbBool, DdbForm, DdbType, DdbVoid } from 'dolphindb/browser.js';\n\n"
    )
    sources = ["utils.ts", "network.ts", "adapter.ts", "sources.ts"]
    provenance = {
        "repository": "https://github.com/dolphindb/vscode-extension",
        "commit": subprocess.check_output(["git", "-C", str(upstream), "rev-parse", "HEAD"], text=True).strip(),
        "license": "Apache-2.0",
        "sources": {f"src/debugger/{name}": hashlib.sha256(
            (upstream / "src/debugger" / name).read_text(encoding="utf-8").encode("utf-8")
        ).hexdigest() for name in sources},
        "extracted": ["basictype2ddbobj", "array2ddbvector", "json2ddbdict"],
        "adaptations": ["browser SDK import", "realm-independent Array.isArray", "authenticated Jupyter relay", "serial RPC with timeouts and cancellation",
                        "document-scoped sessions", "native Jupyter debugger panels and CodeMirror gutters"],
    }
    for name, content in {"debugger-codec.ts": header + code + "\n",
                          "debugger-provenance.json": json.dumps(provenance, indent=2) + "\n"}.items():
        path = ROOT / "frontend/upstream" / name
        if check:
            if not path.exists() or path.read_text(encoding="utf-8") != content:
                raise SystemExit(f"Out of sync: {path}")
        else:
            path.write_text(content, encoding="utf-8", newline="\n")
    print("Upstream debugger encoding matches." if check else "Extracted upstream debugger encoding.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    sync(parser.parse_args().check)

"""Extract upstream chart options; keep the Jupyter host UI independent of Ant Design."""

import argparse
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def sync(check=False):
    source = ROOT / "upstream/vscode-extension/src/dataview/obj.tsx"
    original = source.read_text(encoding="utf-8")
    code = original[original.index("function get_chart_option ("):original.index("function EChartsComponent (")].rstrip()
    code = code.replace("function get_chart_option", "export function get_chart_option")
    code = code.replace("'var(--vscode-editor-foreground, #000000)'", "config.color || '#000000'")
    code = code.replace("value.truncate(10)", "value.slice(0, 10) + '…'")
    code = code.replace("values.min()", "values.reduce((a, b) => Math.min(a, b), Infinity)")
    code = code.replace("values.max()", "values.reduce((a, b) => Math.max(a, b), -Infinity)")
    code = code.replace("const values = data.map(d => d.value)", "const values = data.map(d => d.value).filter(v => v !== null && Number.isFinite(v))")
    code = code.replace("const minValue =", "if (!values.length) return base\n            const minValue =")
    code = code.replace("(maxValue - minValue) / binCount", "(maxValue - minValue) / binCount || 1")
    code = code.replace("... data[0].vol ?", "... data[0]?.vol !== undefined ?")
    code = "\n".join(line.rstrip() for line in code.splitlines())
    header = ("// @ts-nocheck\n// Generated from DolphinDB VS Code src/dataview/obj.tsx (Apache-2.0).\n"
              "// Rebuild with scripts/sync_dataview.py; see dataview-provenance.json.\n"
              "import { DdbChartType } from 'dolphindb/browser.js';\n"
              "import type * as echarts from 'echarts';\n"
              "const unique = values => [...new Set(values)];\nconst t = text => text;\n"
              "type ChartConfig = any;\n\n")
    provenance = {"repository": "https://github.com/dolphindb/vscode-extension",
                  "commit": subprocess.check_output(["git", "-C", str(source.parents[2]), "rev-parse", "HEAD"], text=True).strip(),
                  "source": "src/dataview/obj.tsx", "sha256": hashlib.sha256(original.encode("utf-8")).hexdigest(),
                  "extracted": ["get_chart_option"],
                  "tableActions": {"source": "src/commands.ts", "functions": ["table_action", "get_clause"],
                                   "sha256": hashlib.sha256((ROOT / "upstream/vscode-extension/src/commands.ts").read_text(encoding="utf-8").encode("utf-8")).hexdigest(),
                                   "adaptation": "Jupyter cursor insertion and document-scoped schema reads"},
                  "adaptations": ["Jupyter theme color", "replace xshell prototype helpers", "empty/constant histogram data", "zero-volume/empty candlestick data"]}
    outputs = {"charts.ts": header + code + "\n", "dataview-provenance.json": json.dumps(provenance, indent=2) + "\n"}
    for name, content in outputs.items():
        path = ROOT / "frontend/upstream" / name
        if check:
            if not path.exists() or path.read_text(encoding="utf-8") != content:
                raise SystemExit(f"Out of sync: {path}")
        else:
            path.write_text(content, encoding="utf-8", newline="\n")
    print("Upstream chart options match." if check else "Extracted upstream chart options.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    sync(parser.parse_args().check)

import importlib.util
import json
from pathlib import Path


def test_dataview_provenance_is_independent_of_checkout_line_endings(tmp_path, monkeypatch):
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location("sync_dataview", root / "scripts/sync_dataview.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.setattr(module.subprocess, "check_output", lambda *args, **kwargs: "test-commit\n")
    (tmp_path / "frontend/upstream").mkdir(parents=True)
    files = ["src/dataview/obj.tsx", "src/commands.ts"]
    sources = {name: (root / "upstream/vscode-extension" / name).read_text(encoding="utf-8") for name in files}
    for name, source in sources.items():
        destination = tmp_path / "upstream/vscode-extension" / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(source.encode("utf-8"))
    module.sync()
    provenance = json.loads((tmp_path / "frontend/upstream/dataview-provenance.json").read_text(encoding="utf-8"))
    charts = (tmp_path / "frontend/upstream/charts.ts").read_bytes()
    for name, source in sources.items():
        (tmp_path / "upstream/vscode-extension" / name).write_bytes(source.replace("\n", "\r\n").encode("utf-8"))
    module.sync(check=True)
    module.sync()
    assert json.loads((tmp_path / "frontend/upstream/dataview-provenance.json").read_text(encoding="utf-8")) == provenance
    assert (tmp_path / "frontend/upstream/charts.ts").read_bytes() == charts

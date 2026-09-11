"""Check documentation links, settings, release versions and clean runnable examples."""

import ast
import json
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

import nbformat
from IPython.core.inputtransformer2 import TransformerManager
from packaging.version import Version

ROOT = Path(__file__).resolve().parents[1]
PROJECT_LINK = "https://github.com/realhuhu/dolphindb-extension/blob/main/"


def without_fences(markdown: str) -> str:
    return re.sub(r"(?ms)^```[^\n]*\n.*?^```\s*$", "", markdown)


def check_links(files: list[Path], errors: list[str]) -> int:
    count = 0
    for path in files:
        content = without_fences(path.read_text(encoding="utf-8"))
        for match in re.finditer(r"!?\[[^\]\n]*\]\((<[^>\n]+>|[^\s)]+)(?:\s+\"[^\"]*\")?\)", content):
            target = match[1].strip("<>")
            base = path.parent
            if target.startswith(PROJECT_LINK):
                target = target.removeprefix(PROJECT_LINK)
                base = ROOT
            url = urlsplit(target)
            if url.scheme or url.netloc:
                continue
            destination = (base / unquote(url.path)).resolve() if url.path else path
            if not destination.is_relative_to(ROOT) or not destination.exists():
                errors.append(f"{path.relative_to(ROOT)}: missing local link {target}")
            count += 1
    return count


def settings_leaves(node: dict, prefix: str = ""):
    for key, value in node.get("properties", {}).items():
        name = f"{prefix}.{key}" if prefix else key
        if "properties" in value:
            yield from settings_leaves(value, name)
        else:
            yield name, value


def check_settings(errors: list[str]) -> int:
    schema = json.loads((ROOT / "schema/settings.json").read_text(encoding="utf-8"))
    content = (ROOT / "docs/settings.md").read_text(encoding="utf-8")
    rows = re.findall(r"(?m)^\| `([^`]+)` \| `([^`]+)` \|", content)
    documented = dict(rows)
    if len(documented) != len(rows):
        errors.append("docs/settings.md: duplicated settings table keys")
    leaves = dict(settings_leaves(schema))
    for name, definition in leaves.items():
        expected = json.dumps(definition["default"], ensure_ascii=False)
        if documented.get(name) != expected:
            errors.append(f"docs/settings.md: {name} must document default {expected}")
    for name in documented.keys() - leaves.keys():
        errors.append(f"docs/settings.md: unknown setting {name}")
    return len(leaves)


def check_versions(errors: list[str]) -> None:
    project = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    version = re.search(r'(?m)^version = "([^"]+)"$', project)[1]
    parsed = Version(version)
    npm_version = parsed.base_version
    if parsed.pre:
        label = {"a": "alpha", "b": "beta", "rc": "rc"}[parsed.pre[0]]
        npm_version += f"-{label}.{parsed.pre[1]}"
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    lock = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
    for source, value in [
        ("package.json", package["version"]),
        ("package-lock.json", lock["version"]),
        ("package-lock.json packages root", lock["packages"][""]["version"]),
    ]:
        if value != npm_version:
            errors.append(f"{source}: expected version {npm_version}, got {value}")
    for name in ["README.md", "docs/README.md", "docs/installation.md"]:
        if version not in (ROOT / name).read_text(encoding="utf-8"):
            errors.append(f"{name}: missing current package version {version}")


def check_examples(errors: list[str]) -> int:
    count = 0
    transformer = TransformerManager()
    for path in sorted((ROOT / "docs/examples").glob("*.ipynb")):
        notebook = nbformat.read(path, as_version=4)
        nbformat.validate(notebook)
        for index, cell in enumerate(notebook.cells, start=1):
            if cell.cell_type != "code":
                continue
            location = f"{path.relative_to(ROOT)} cell {index}"
            if cell.outputs or cell.execution_count is not None:
                errors.append(f"{location}: remove saved outputs and execution count")
            try:
                ast.parse(transformer.transform_cell(cell.source))
            except SyntaxError as error:
                errors.append(f"{location}: invalid Python/magic syntax: {error}")
            count += 1
    if not count:
        errors.append("docs/examples: no runnable Notebook code cells found")
    return count


def main() -> int:
    errors: list[str] = []
    files = [ROOT / "README.md", ROOT / "CHANGELOG.md", *sorted((ROOT / "docs").rglob("*.md"))]
    links = check_links(files, errors)
    settings = check_settings(errors)
    check_versions(errors)
    cells = check_examples(errors)
    if errors:
        print("Documentation checks failed:\n" + "\n".join(f"- {error}" for error in errors))
        return 1
    print(f"Documentation OK: {len(files)} Markdown files, {links} local links, {settings} settings, "
          f"{cells} clean Notebook code cells, synchronized package versions.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

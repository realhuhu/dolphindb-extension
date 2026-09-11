# 构建检查与发布

[文档首页](README.md) · [项目首页](../README.md)

本页是维护者流程。补文档、修复代码和本地构建不代表已授权提交、推送或发布；这些动作在维护者明确批准当前版本后执行。
GitHub Actions 只做校验，不自动上传 PyPI。

## 准备版本

1. 完成代码和 [验证清单](development.md)，确认工作区只包含本次版本所需变更。
2. 同步 Python 与 npm 版本：例如 `0.1.0b1` 对应 `0.1.0-beta.1`；修改 `pyproject.toml`、`package.json`、`package-lock.json`、README 和文档版本说明。
3. 执行 `uv lock`，将 `CHANGELOG.md` 的 Unreleased 内容整理到版本和日期标题下。
4. 重新构建前端；Hatch 会复用已存在的预构建文件，不能省略此步。

```shell
npm ci
npm exec tsc
uv run --extra notebook jupyter-builder build .
npm test
uv run --extra notebook ruff check src scripts tests
uv run --extra notebook pytest -q
uv run --extra notebook python scripts/check_docs.py
uv run --extra notebook python scripts/sync_upstream.py --check
uv run --extra notebook python scripts/sync_language.py --check
uv run --extra notebook python scripts/sync_dataview.py --check
uv run --extra notebook python scripts/sync_debugger.py --check
```

## 检查待发布产物

使用新目录构建本次产物，避免混入旧版本。下面目录名在开始新版本时替换为对应版本：

```shell
uv build --no-sources --out-dir dist/candidate
uvx twine check --strict dist/candidate/*
```

检查 wheel 的 Python 版本、依赖和版本号；确认包含服务端启用配置、前端 `package.json`、入口 JavaScript、样式和 Settings schema。
源码分发包应包含 `docs/`、干净示例、源代码、测试和预构建前端，安装时不需要 Git submodule 或 Node.js。

用实际生成的完整路径分别验证 wheel 和源码分发包。路径只是占位示例，不要连尖括号一起执行：

```shell
uv run --isolated --no-project --with <wheel路径> python -I -c "import dolphindb_extension; print(dolphindb_extension.__version__)"
uv run --isolated --no-project --with <源码分发包路径> python -I -c "import dolphindb_extension; print(dolphindb_extension.__version__)"
```

还需在独立 Jupyter 环境检查 `jupyter labextension list` 与 `jupyter server extension list` 的发现结果。
验证 Notebook 时在内核中安装 `[notebook]` extra，按 [示例](examples/quickstart.ipynb) 检查原生与自定义输出。
确认分发包没有 `.qa/`、`.venv/`、`.env`、凭据文件、登录 token 或 Notebook 执行输出。

## 提交、推送和上传

获得维护者授权后，提交已经验证的变更，创建与 Python 版本匹配的 `v<版本>` Git 标签，并推送提交和标签。
只上传已检查的那个版本的 wheel / sdist；不要用包含多个历史版本的目录执行通配发布。

```shell
uv auth login https://upload.pypi.org --username __token__
uv publish dist/candidate/*
```

登录时在交互提示中输入 API token；不要把 token 放进文档、源码、命令参数或版本库。
PyPI 不能覆盖同一文件名的已上传产物。上传失败或结果不确定时先检查 PyPI 状态，避免重新构建同版本后反复上传。

完成后检查标签指向已验证提交、CI 结果、PyPI 元数据及从 PyPI 的独立安装。前端不是单独的 npm 发行包，而是 Python 包内的预构建 Jupyter 扩展。

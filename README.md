# dolphindb-extension

将 [DolphinDB VS Code 插件](https://github.com/dolphindb/vscode-extension) 的能力迁移到 Jupyter，
支持 DolphinDB 脚本开发和 Notebook 中的 DDB 代码执行。

**当前版本 `0.1.0a1` 仅包含使用 uv 初始化的 Python 包骨架。**
此版本用于建立项目和发布流程，尚未实现 Jupyter 扩展、连接管理或代码执行功能。
安装后不会出现侧边栏按钮、内核或 Notebook magic。

## 目标功能（待实现）

目标是覆盖原 VS Code 插件的全部功能，并增加 Notebook 集成；以下为主要迁移范围：

- [ ] 在 Jupyter 侧边栏配置、管理和切换 DolphinDB 连接。
- [ ] 创建、编辑 `.dos` 文件，并像选择 Python 内核一样选择执行连接。
- [ ] 执行文件、选中代码或当前语句，显示运行状态并支持取消执行。
- [ ] 在 Notebook 中编写和执行 DDB 代码，提供类似 SQL 的使用体验。
- [ ] 语法高亮、代码补全、内置函数文档和参数提示。
- [ ] 显示执行结果、`print()` 输出和错误信息。
- [ ] 浏览数据库、表和会话变量，展示表、向量及矩阵，并导出 CSV。
- [ ] 调试等其余能力按上游功能清单逐项迁移和验收。

计划面向 JupyterLab 4 和 Jupyter Notebook 7；前端扩展、服务端连接执行层及
Notebook 集成会在后续开发阶段加入。

## 安装骨架版本

需要 Python 3.10 或更高版本。

```shell
pip install dolphindb-extension==0.1.0a1
```

包的 Python 导入名称为 `dolphindb_extension`：

```python
from dolphindb_extension import __version__

print(__version__)
```

## 本地开发

使用 [uv](https://docs.astral.sh/uv/) 管理 Python 环境、锁文件和构建。
开发环境固定为 Python 3.12，运行时最低支持 Python 3.10。

```shell
git clone https://github.com/realhuhu/dolphindb-extension.git
cd dolphindb-extension
uv sync --locked
uv run python -c "import dolphindb_extension; print(dolphindb_extension.__version__)"
uv build --no-sources
uvx twine check --strict dist/*
```

源码位于 `src/dolphindb_extension/`，构建配置位于 `pyproject.toml`，
wheel 和源码分发包输出到 `dist/`。当前包没有运行时依赖。
GitHub Actions 会检查锁文件、构建产物和独立安装后的导入。

## 发布

更新 `pyproject.toml` 中的版本和 `CHANGELOG.md`，运行 `uv lock`，并在干净的
`dist/` 目录中重新构建和检查产物。提交代码并创建对应版本的 Git 标签后发布。

```shell
uv auth login https://upload.pypi.org --username __token__
uv publish
```

登录时在交互提示中输入 PyPI API token。凭据保存在 uv 的本机凭据存储中，
不应写入源码、提交记录或构建产物。

## 许可证

采用 [Apache License 2.0](LICENSE)。本项目以 DolphinDB VS Code 插件为迁移参考；
初始版本尚未包含迁移后的上游实现。

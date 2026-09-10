# dolphindb-extension

将 [DolphinDB VS Code 插件](https://github.com/dolphindb/vscode-extension) 的能力迁移到 Jupyter，
支持 DolphinDB 脚本开发和 Notebook 中的 DDB 代码执行。

**`0.1.0a2` 提供可视化连接管理。** 在 Jupyter 侧边栏中新增、编辑、删除、测试和切换
DolphinDB 连接，查看当前连接、节点名称和服务器版本。`.dos` 执行和 Notebook DDB
代码执行仍在后续开发范围内。

## 可视化配置连接

1. 安装插件后重启 Jupyter。在 JupyterLab 中点击左侧数据库形状的 **DolphinDB 连接**
   按钮；在 Notebook 7 中打开一个 Notebook，通过 **View → Activate Command Palette**
   搜索并运行 `DolphinDB: 管理连接`，面板会显示在右侧。此命令也可用于 JupyterLab。
2. 点击 **新增连接**，填写连接名称、服务器 IP / 域名、端口、用户名和密码。
   可设置 1–60 秒连接超时；服务器开启 SSL 时，勾选 **使用 SSL 加密连接**。
3. 点击 **测试连接** 验证登录和节点信息，点击 **保存连接** 保存配置。
4. 在列表中点击 **连接** 或 **切换连接**。只有新连接成功后才断开旧连接，
   切换失败时原连接保持可用。当前连接区提供 **断开连接** 按钮。
5. 使用 **编辑** 更新配置，密码留空会保留已有密码，也可明确清除。
   **删除** 会移除配置、已保存的密码并断开对应连接，不修改数据库中的数据。

连接地址由 **Jupyter 服务所在机器** 访问，并通过经过 Jupyter 身份验证的 WebSocket
转发至 DolphinDB。服务器需支持 WebSocket 接口（与原 VS Code 插件相同）。
刷新页面后保留配置和上次选择，但不会自动登录服务器。

普通连接配置保存在 Jupyter 数据目录的 `dolphindb-extension/connections.json` 中。
密码默认只存在 Jupyter 服务内存中，重启服务后需重新输入。勾选 **记住密码** 时使用
服务器的系统凭据库（keyring）；无可用凭据库的无头 Linux 环境仍可使用会话密码。
密码不写入 JSON 配置、Notebook 或浏览器本地存储；只有建立连接时会经身份验证的接口
临时传给浏览器内的 DolphinDB SDK。编辑已有连接的地址、账号或密码会断开该连接。

可通过 `--DolphinDBExtensionApp.data_dir=/path/to/profiles` 指定配置目录。
JupyterHub 应使用每个用户独立的服务和数据目录。

## 目标功能（待实现）

目标是覆盖原 VS Code 插件的全部功能，并增加 Notebook 集成；以下为主要迁移范围：

- [x] 在 Jupyter 侧边栏配置、管理和切换 DolphinDB 连接。
- [ ] 创建、编辑 `.dos` 文件，并像选择 Python 内核一样选择执行连接。
- [ ] 执行文件、选中代码或当前语句，显示运行状态并支持取消执行。
- [ ] 在 Notebook 中编写和执行 DDB 代码，提供类似 SQL 的使用体验。
- [ ] 语法高亮、代码补全、内置函数文档和参数提示。
- [ ] 显示执行结果、`print()` 输出和错误信息。
- [ ] 浏览数据库、表和会话变量，展示表、向量及矩阵，并导出 CSV。
- [ ] 调试等其余能力按上游功能清单逐项迁移和验收。

面向 JupyterLab 4 和 Jupyter Notebook 7；Notebook 代码执行集成会在后续阶段加入。

## 安装

需要 Python 3.10 或更高版本，以及 JupyterLab 4 / Notebook 7。
Python 包已包含预构建前端，安装使用时无需 Node.js。

```shell
pip install dolphindb-extension==0.1.0a2
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
git clone --recurse-submodules https://github.com/realhuhu/dolphindb-extension.git
cd dolphindb-extension
uv sync --locked
npm ci
uv run python scripts/sync_upstream.py --check
npm exec tsc
uv run jupyter-builder build .
uv run pytest
uv build --no-sources
uvx twine check --strict dist/*
```

源码构建还需要 Node.js 22+ 和 npm。首次 `uv sync` 会自动构建前端；开发过程中修改
TypeScript 后运行 `npm exec tsc` 和 `uv run jupyter-builder build .`。
也可将 uv 环境激活后直接运行 `npm run build`。
构建后运行 `uv sync --reinstall-package dolphindb-extension`，重启 Jupyter 并刷新页面。

服务端位于 `src/dolphindb_extension/`，侧边栏位于 `frontend/`，样式位于 `style/`。
GitHub Actions 检查源码复用的一致性、服务端 API、认证、二进制转发、构建产物及独立安装。
使用 `uv run python scripts/dev_server.py` 可启动独立的本机测试环境（端口 8890），
配置、登录令牌和日志保存在被 Git 忽略的 `.qa/` 下，测试工作区与项目源码分离。

## 复用上游源码

`upstream/vscode-extension` 是固定提交的 Git submodule。连接初始化、登录状态、节点信息、
集群信息和版本查询等 9 个方法由 `scripts/sync_upstream.py` 从上游 `src/connector.ts`
提取，`src/commons.ts` 的共享定义原样复制。仅替换浏览器入口、移除 VS Code 界面副作用，
并补充严格类型；来源、提交及适配记录见 `frontend/upstream/provenance.json`。
通信协议直接使用上游锁定的 `dolphindb@3.1.41`，不另写协议或结果解析器。

更新上游时先更新 submodule，再运行 `uv run python scripts/sync_upstream.py`，
检查差异并重新构建。完整 VS Code 的 TreeView、编辑器等 API 由 Jupyter 适配；其他功能
将在后续迁移中继续复用上游模块。构建产物包含所需代码，安装时不需要下载 submodule。

## 发布

同步更新 `pyproject.toml` 与 `package.json` 中的版本（例如 `0.1.0a2` 对应
`0.1.0-alpha.2`）、`package-lock.json` 和 `CHANGELOG.md`，运行 `uv lock`，
重新构建前端，再在干净的 `dist/` 目录中构建和检查产物。提交代码并创建对应版本的 Git 标签后发布。

```shell
uv auth login https://upload.pypi.org --username __token__
uv publish
```

登录时在交互提示中输入 PyPI API token。凭据保存在 uv 的本机凭据存储中，
不应写入源码、提交记录或构建产物。

## 许可证

采用 [Apache License 2.0](LICENSE)。复用的 DolphinDB VS Code 源码保留上游许可，
详见 [NOTICE](NOTICE)；第三方依赖遵循各自许可证。

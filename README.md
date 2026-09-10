# dolphindb-extension

将 [DolphinDB VS Code 插件](https://github.com/dolphindb/vscode-extension) 的能力迁移到 Jupyter，
支持 DolphinDB 脚本开发和 Notebook 中的 DDB 代码执行。

**`0.1.0a2` 提供可视化连接管理。** 在 Jupyter 侧边栏中新增、编辑、删除、测试和切换
DolphinDB 连接，查看当前连接、节点名称和服务器版本。
**当前未发布开发版**还提供 Settings Editor 和下述 DOS 编辑、执行及独立会话功能。
Notebook DDB 单元格执行仍在后续开发范围内。

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
连接侧栏保留上次选择，作为 DOS 的默认连接；尚未运行的文件也可单独选择其他连接。
刷新页面后已创建的 DOS 会话会恢复，连接侧栏本身不会重新建立全局连接。

当前开发版的普通连接配置保存在 Jupyter 配置目录的 `dolphindb-extension/connections.json`
中，可运行 `jupyter --config-dir` 查看根目录；Windows 上通常为
`%USERPROFILE%\.jupyter\dolphindb-extension\connections.json`。
首次使用新默认目录时，会从旧 Jupyter 数据目录复制已有配置，保留原文件和已保存密码的
凭据标识；新目录已有配置时不会覆盖。显式设置的配置目录继续使用原路径。
已发布的 `0.1.0a2` 使用 Jupyter 数据目录。

密码默认只存在 Jupyter 服务内存中，重启服务后需重新输入。勾选 **记住密码** 时使用
服务器的系统凭据库（keyring）；无可用凭据库的无头 Linux 环境仍可使用会话密码。
密码不写入 JSON 配置、Notebook 或浏览器本地存储；只有建立连接时会经身份验证的接口
临时传给浏览器内的 DolphinDB SDK。编辑已有连接的地址、账号或密码会断开侧栏的测试连接，
已运行 DOS 的连接快照及会话保持不变。

可通过 `--DolphinDBExtensionApp.connections_dir=/path/to/profiles` 指定配置目录。
旧参数 `DolphinDBExtensionApp.data_dir` 继续兼容；两个参数同时设置时，新参数优先。
JupyterHub 应使用每个用户独立的服务和数据目录。

## Settings Editor（当前开发版）

在 JupyterLab 的 **Settings → Settings Editor** 中搜索 **DolphinDB**，或点击连接侧栏
顶部的齿轮按钮。命令面板也提供 `DolphinDB: 设置`。
通过该入口打开设置时会收起左侧面板，为表单留出空间；点击数据库图标可再次展开连接侧栏。

| 设置分组 | 可配置项 | 生效方式 |
| --- | --- | --- |
| 新增连接默认值 | 端口、用户名、连接超时、SSL | 用于随后打开的新增连接表单 |
| 侧栏显示 | 添加顺序 / 名称 / 地址排序、显示连接详情、始终显示搜索框 | 保存后即时更新 |

已有连接和正在编辑的表单保留各自配置。默认值不包含密码；连接列表及密码仍通过侧栏管理。
设置由 Jupyter 的 `ISettingRegistry` 保存，支持 Settings Editor 的恢复默认值、JSON 编辑，
以及管理员的 `overrides.json`。Notebook 7 读取同一设置服务；如其界面没有 Settings Editor，
请在使用同一设置目录的 JupyterLab 中修改后刷新 Notebook。

用户设置文件位于 JupyterLab 的用户设置目录中：
`dolphindb-extension/settings.jupyterlab-settings`。默认根目录通常为
`<jupyter_config_dir>/lab/user-settings`，也可由 `JUPYTERLAB_SETTINGS_DIR` 或服务配置指定。
测试启动脚本使用独立的 `.qa/settings/`，避免修改日常使用的 JupyterLab 设置。

JSON 用户覆盖示例（未列出的字段继续使用默认值）：

```json
{
  "connectionDefaults": { "timeout": 20 },
  "sidebar": { "sortOrder": "name", "alwaysShowSearch": true }
}
```

`schema/settings.json` 定义分组、说明、默认值和校验范围；`frontend/settings.ts` 提供统一的
类型、默认值解析和变更信号。后续执行、编辑器或结果展示插件可依赖 `IExtensionSettings`
服务，新增配置时按功能增加 schema 分组和对应类型，再订阅 `changed` 更新界面。
保持已有字段及插件 ID `dolphindb-extension:settings` 稳定，以保留用户配置。

## DOS 文件与独立会话（当前开发版）

在 JupyterLab Launcher 中点击 **新建 DOS 文件**，或在命令面板搜索同名命令；
文件浏览器右键也提供创建入口。`.dos` 使用 Jupyter 原生文本编辑器，支持保存、
重命名、撤销及语法高亮。

| 操作 | 入口 / 快捷键 |
| --- | --- |
| 运行整个文件 | 工具栏「运行文件」 / Ctrl + Shift + Enter |
| 运行选区，没有选区时运行当前行 | 「运行选中/当前行」 / Ctrl + Enter |
| 运行当前行并移至下一行 | Shift + Enter |
| 代码提示 | Ctrl + Space；函数、关键字、常量、脚本和会话变量、数据库表、内存表列名 |
| 函数文档和签名 | 鼠标悬浮函数名；补全列表中的函数文档 |
| 批量运行 | 工具栏或命令面板「批量运行 DOS 文件」，勾选文件后依次执行 |
| 中断代码 | 工具栏「中断」；使用上游 getConsoleJobs / cancelConsoleJob 流程 |

批量运行列出已打开以及文件浏览器选中的 DOS 文件，执行开始时读取代码快照，
每个文件使用自己的连接和会话；遇到错误停止后续文件。命令面板的
「DolphinDB: 停止后续批量运行」可取消剩余文件，当前代码需通过「中断」停止。
中断沿用 SDK 的 urgent 通道，由 DolphinDB 在循环或子任务边界响应；单次 `sleep()` 等
操作可能需要等其返回。详见 [DolphinDB 作业管理](https://docs.dolphindb.com/zh/tutorials/job_management_tutorial.html)。

首次运行前，工具栏右侧的连接选择器可自由切换，默认采用连接侧栏中上次选择的连接
（尚无默认选择时采用第一个配置）。Database 面板预览该连接可见的数据库和表，变量面板为空。
**第一次提交用户代码后，文件的连接固定**，包括代码报错的情况。连接失败时不会锁定文件。
后续执行复用该文件的 DolphinDB 会话；A 文件定义的普通变量不会出现在 B 文件中。
用户显式创建的共享表、DFS 表等仍遵循 DolphinDB 自身的共享规则。

数据库和变量面板随当前 DOS 文件切换；表可预览前 100 行。文件底部显示表格、普通结果、
print 输出和错误行号。变量刷新沿用上游对可变对象的保护，只读取标量和 pair 的值，
其他变量显示类型和大小，避免让向量或表失去 ownership。

在 **正在运行的内核和终端 → DolphinDB DOS 会话** 中，可查看各文件的连接及运行状态、
重新打开文件、关闭单个或所有 DOS 会话。关闭编辑器和刷新页面不会关闭服务端会话；
文件重命名后仍使用原会话。关闭会话后变量释放，该文件下次运行可重新选择连接。
网络连接真正断开时显示「已断开」，不会自动重建会话或重试代码；重启 Jupyter 会结束所有会话。

会话由 Jupyter Server 内存管理，原始结果通过官方 SDK 解析，不需要额外 Node.js 运行时。
每个会话最多保留最近 20 次执行及约 8 MiB 编码输出用于页面恢复，超限会提示省略。
服务端校验 Jupyter 身份和 `dolphindb-extension:dos-sessions` 权限；不同登录身份不能接管
对方会话，同一个 DOS 会话同时只允许一个页面连接。JupyterHub 使用用户独立的 Jupyter 服务。

## 迁移进度

目标是覆盖原 VS Code 插件的全部功能，并增加 Notebook 集成；以下为主要迁移范围：

- [x] 在 Jupyter 侧边栏配置、管理和切换 DolphinDB 连接。
- [x] 创建、编辑 `.dos` 文件，并像选择 Python 内核一样选择执行连接。
- [x] 执行文件、选中代码或当前行，批量运行、显示运行状态并支持中断。
- [x] 每个 DOS 独立会话、首次执行后固定连接，并接入 Jupyter 正在运行面板。
- [ ] 在 Notebook 中编写和执行 DDB 代码，提供类似 SQL 的使用体验。
- [x] 语法高亮、代码补全、内置函数文档和签名提示。
- [x] 显示执行结果、`print()` 输出和错误信息。
- [x] 浏览数据库、表和各文件的会话变量，预览表格。
- [ ] 更完整的 LSP 诊断、模块跳转、向量/矩阵交互视图及 CSV 导出。
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
npm test
uv run pytest
uv build --no-sources
uvx twine check --strict dist/*
```

源码构建和前端测试需要 Node.js 22.18+ 和 npm。首次 `uv sync` 会自动构建前端；开发过程中修改
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
`src/commands.ts` 的实际执行表达式（包括 `line://` 行号与 print 监听）和 4 个数据库
辅助函数也经该脚本提取，见 `frontend/upstream/execution.ts`。
补全和悬浮说明直接使用上游同款 `DocsProvider`、`docs.zh.json` 和语言关键字表。
通信和数据类型解析直接使用上游锁定的 `dolphindb@3.1.41`。服务端仅识别连接、打印和结果
的消息边界以保留会话及输出，不实现另一套 DolphinDB 数据类型编解码器。

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

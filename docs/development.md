# 本地开发、复用上游与验证

[文档首页](README.md) · [项目首页](../README.md)

使用 [uv](https://docs.astral.sh/uv/) 管理 Python 环境、锁文件和构建。
开发环境固定为 Python 3.12，运行时最低支持 Python 3.10。

```shell
git clone --recurse-submodules https://github.com/realhuhu/dolphindb-extension.git
cd dolphindb-extension
npm ci
uv sync --locked --extra notebook
uv run --extra notebook python scripts/sync_upstream.py --check
uv run --extra notebook python scripts/sync_language.py --check
uv run --extra notebook python scripts/sync_dataview.py --check
uv run --extra notebook python scripts/sync_debugger.py --check
npm exec tsc
uv run --extra notebook jupyter-builder build .
npm test
uv run --extra notebook ruff check src scripts tests
uv run --extra notebook pytest
uv run --extra notebook python scripts/check_docs.py
uv build --no-sources
uvx twine check --strict dist/*
```

源码构建和前端测试需要 Node.js 22.18+ 和 npm。首次 `uv sync` 会自动构建前端；开发过程中修改
TypeScript 后运行 `npm exec tsc` 和 `uv run jupyter-builder build .`。
也可将 uv 环境激活后直接运行 `npm run build`。
构建后运行 `uv sync --extra notebook --reinstall-package dolphindb-extension`，重启 Jupyter 并刷新页面。

服务端位于 `src/dolphindb_extension/`，侧边栏位于 `frontend/`，样式位于 `style/`。
GitHub Actions 检查源码复用的一致性、服务端 API、认证、二进制转发、构建产物及独立安装。
文档检查校验本地链接、全部设置键及默认值、版本号和示例 Notebook 的语法与无输出状态。
使用 `uv run --extra notebook python scripts/dev_server.py` 可启动独立的本机测试环境（端口 8890），
配置、登录令牌和日志保存在被 Git 忽略的 `.qa/` 下，测试工作区与项目源码分离。

## 上游源码复用

`upstream/vscode-extension` 是固定提交的 Git submodule。连接初始化、登录状态、节点信息、
集群信息和版本查询等 9 个方法由 `scripts/sync_upstream.py` 从上游 `src/connector.ts`
提取，`src/commons.ts` 的共享定义原样复制。仅替换浏览器入口、移除 VS Code 界面副作用，
并补充严格类型；来源、提交及适配记录见 `frontend/upstream/provenance.json`。
`src/commands.ts` 的实际执行表达式（包括 `line://` 行号与 print 监听）和 4 个数据库
辅助函数也经该脚本提取，见 `frontend/upstream/execution.ts`。
`scripts/sync_language.py` 提取上游语言服务的符号分析、补全、SQL 上下文、定义、悬浮与诊断
算法，记录固定提交与每个源文件的 SHA-256，见 `frontend/upstream/language/provenance.json`。
适配层用 Jupyter Contents 和各文档/内核的会话元数据替换 VS Code 的全局服务，使用
CodeMirror 和 Jupyter 编辑器扩展注册接口展示提示，无需启动 Node 语言服务器。
内置文档和签名直接使用上游同款 `DocsProvider`、`docs.zh.json` / `docs.en.json` 和语言关键字表。
`scripts/sync_dataview.py` 提取 `src/dataview/obj.tsx` 的 `get_chart_option`，保留原图表系列构造，
替换主题颜色和浏览器辅助函数，并修正空数据、常量直方图和零成交量 K 线边界。
来源及适配记录见 `frontend/upstream/dataview-provenance.json`。浏览器分页沿用上游查询方式，
表操作模板适配自 `src/commands.ts` 的 `table_action` / `get_clause`，UI 使用 Jupyter 原生组件。
`scripts/sync_debugger.py` 提取调试协议的二进制编解码函数，记录源码哈希和适配范围，
见 `frontend/upstream/debugger-provenance.json`；调试面板复用 Jupyter 的调用栈、断点和变量组件。
通信和数据类型解析直接使用上游锁定的 `dolphindb@3.1.41`。服务端仅识别连接、打印和结果
的消息边界以保留会话及输出，不实现另一套 DolphinDB 数据类型编解码器。

更新上游时先更新 submodule，再运行 `uv run python scripts/sync_upstream.py`、
`uv run python scripts/sync_language.py`、`uv run python scripts/sync_dataview.py` 和
`uv run python scripts/sync_debugger.py`，
检查差异并重新构建。完整 VS Code 的 TreeView、编辑器等 API 由 Jupyter 适配；其他功能
将在后续迁移中继续复用上游模块。构建产物包含所需代码，安装时不需要下载 submodule。

## 修改约定

- 会话和异步请求以原文档、内核、连接及执行版本为归属；旧请求不能覆盖新会话。
- 普通 Python 输出沿用 IPython；只在显式 `ddb_show` 或单元格最终直接调用 DDB magic 时输出自定义 MIME。
- 优先使用 Jupyter 的工具栏、对话框、折叠面板、编辑器与 Running 服务；Lumino 快捷键和上下文菜单每次注册一个 CSS 选择器，不能带逗号。
- 生成文件只通过对应 `sync_*.py` 更新，适配修复记录在 provenance 中；不要只修改生成结果。
- 增加配置时同步 schema、前端解析、后端适用的配置校验、测试和 [设置参考](settings.md)。
- 可复现示例放入 `docs/examples/`；Notebook 不保存输出、凭据或机器专属连接。

## 可选的真实 DolphinDB 回归

普通 `npm test` 和 `pytest` 无需数据库，真实数据库检查默认跳过。使用专用测试服务器时，在进程环境中设置：

| 环境变量 | 用途 |
| --- | --- |
| `DDB_TEST_HOST` | JS / Python 数据浏览集成测试地址 |
| `DDB_DEBUG_TEST_HOST` | WebSocket 调试集成测试地址 |
| `DDB_TEST_PORT` | 服务端口，默认 8848 |
| `DDB_TEST_USER`、`DDB_TEST_PASSWORD` | 测试凭据 |

随后运行 `npm test` 和 `uv run --extra notebook pytest -q`。数据浏览测试创建带 UUID 的临时 DFS 数据库，在 `finally` 中清理；调试测试只执行其自身的脚本和会话。服务器需有创建测试数据库及调试权限。不要把凭据写入测试文件或命令历史。

## 手动 UI 验收

| 范围 | 关键操作与预期 |
| --- | --- |
| 连接 | 默认与手动选择；编辑同 ID 的地址或密码后 DOS / Notebook 未运行预览更新、旧实时浏览页失效；已固定会话保留 |
| DOS | 文件、选区、当前行和批量运行；报错、中断、关闭、重命名及刷新恢复 |
| Notebook | 按 [展示规则](notebooks.md) 验证原生/自定义输出；重启并运行全部；普通 Python 不依赖 DDB |
| 多视图 | 新建同 Notebook 视图，各自 F12；关闭任意一个后另一视图可继续补全；滚动使单元格重新渲染 |
| 数据 | 数字、负数、Decimal、INT64、数字索引排序；分页、列分页、嵌套对象和缓存过期 |
| UI 状态 | 手动收起面板后执行/切换不会自动展开；折叠输出不改变滚动位置；明暗主题 |
| 调试 | 断点、暂停、逐过程、进入/跳出、继续和停止；模块窗口 F9/F5 使用所属会话 |

协议与模块入口见 [架构说明](architecture.md)，构建产物与发布验收见 [发布说明](release.md)。

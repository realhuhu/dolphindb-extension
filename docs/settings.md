# Settings Editor 配置参考

[文档首页](README.md) · [项目首页](../README.md)

在 JupyterLab 的 **Settings → Settings Editor** 中搜索 **DolphinDB**，或点击连接侧栏
顶部的齿轮按钮。命令面板也提供 `DolphinDB: 设置`。
通过该入口打开设置时会收起左侧面板，为表单留出空间；点击连接侧栏图标可再次展开面板。

| 设置分组 | 可配置项 | 生效方式 |
| --- | --- | --- |
| 新增连接默认值 | 端口、用户名、连接超时、SSL | 用于随后打开的新增连接表单 |
| 侧栏显示 | 排序、地址与详情显隐、搜索框、首次自动打开数据库与变量面板、窄窗口收起左侧栏 | 显隐即时更新；自动打开仅用于尚未保存面板布局的首次文档，手动收起后保持收起，刷新后遵循 Jupyter 布局 |
| 代码提示与模块 | 模块目录、文档语言、自动补全、悬浮文档、自动参数提示、代码诊断 | 已打开的编辑器同步开关；关闭自动参数提示仍可手动调用 |
| 数字显示 | 实际精度，或 0–20 位小数 | 浏览器、结果表格和变量预览即时更新 |
| 数据浏览器 | 默认每页 100 行、50 列，可设置 1–1000 行、1–200 列 | 用于新浏览器和新结果；已打开浏览器保留自己的分页状态 |
| 预览 | 表预览行数、变量与表结构悬浮开关、悬浮延迟 | 后续预览使用新值；关闭开关会撤销当前悬浮框和待显示请求 |
| 执行结果 | 自动滚动、新记录默认展开 | DOS 结果同步更新；保留记录手动折叠和文档内全部折叠的选择 |
| 运行 | 批量运行遇错停止或继续 | 使用开始批量运行时的设置，弹窗会说明当前策略 |
| 高级 | 变量预览字节上限、结果缓存数量与预算、DOS 历史数量与帧预算、Notebook 元数据超时 | 预览及缓存用于后续访问；历史在下次运行或重新打开会话时应用 |

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
  "sidebar": { "sortOrder": "name", "showConnectionAddress": false, "alwaysShowSearch": true },
  "dataBrowser": { "pageSize": 50, "columnPageSize": 20 },
  "preview": { "tableRows": 200, "hoverDelay": 500 },
  "advanced": { "cacheEntries": 30, "metadataTimeout": 15 }
}
```

`schema/settings.json` 定义分组、说明、默认值和校验范围；`frontend/settings.ts` 提供统一的
类型、默认值解析和变更信号。后续执行、编辑器或结果展示插件可依赖 `IExtensionSettings`
服务，新增配置时按功能增加 schema 分组和对应类型，再订阅 `changed` 更新界面。
保持已有字段及插件 ID `dolphindb-extension:settings` 稳定，以保留用户配置。

## 全部设置键、默认值与范围

以下键对应 Settings Editor 的 JSON 形式；值未覆盖时使用默认值。密码和连接列表不属于这些设置。

### 数字显示（`display`）

| 设置键 | 默认值 | 可用值 | 说明 |
| --- | --- | --- | --- |
| `display.decimals` | `null` | `null`、`0`、`1`、`2`、`3`、`4`、`5`、`6`、`7`、`8`、`9`、`10`、`11`、`12`、`13`、`14`、`15`、`16`、`17`、`18`、`19`、`20` | 应用于 DOS 结果、DDB 自定义输出、数据浏览器、图表与变量预览，不改变 Python 原生输出。实际精度保留原有位数；固定小数位数只影响显示。 |

### 数据浏览器（`dataBrowser`）

| 设置键 | 默认值 | 可用值 | 说明 |
| --- | --- | --- | --- |
| `dataBrowser.pageSize` | `100` | 1–1000 | 默认每页行数 |
| `dataBrowser.columnPageSize` | `50` | 1–200 | 不包含索引列。宽表和矩阵按此数量分页。 |

### 预览（`preview`）

| 设置键 | 默认值 | 可用值 | 说明 |
| --- | --- | --- | --- |
| `preview.tableRows` | `100` | 1–1000 | 点击表名右侧眼睛按钮时读取的前 N 行；不影响完整数据浏览器。 |
| `preview.variableHover` | `true` | `true` / `false` | 悬浮预览变量 |
| `preview.tableHover` | `true` | `true` / `false` | 悬浮预览表结构 |
| `preview.hoverDelay` | `350` | 0–2000 | 悬浮预览延迟（毫秒） |

### 执行结果（`output`）

| 设置键 | 默认值 | 可用值 | 说明 |
| --- | --- | --- | --- |
| `output.autoScroll` | `true` | `true` / `false` | 仅作用于 DOS 执行结果；手动折叠不会触发滚动。 |
| `output.defaultExpanded` | `true` | `true` / `false` | 仅设置未手动调整的记录。文档内的全部展开、全部折叠操作优先。 |

### 运行（`execution`）

| 设置键 | 默认值 | 可用值 | 说明 |
| --- | --- | --- | --- |
| `execution.stopOnError` | `true` | `true` / `false` | 关闭后，出错文件仍保留错误结果，继续运行后续文件。使用开始批量运行时的设置。 |

### 高级（`advanced`）

| 设置键 | 默认值 | 可用值 | 说明 |
| --- | --- | --- | --- |
| `advanced.variablePreviewBytes` | `10240` | 1024–1048576 | 超出时仅显示元信息，可手动在完整数据浏览器打开。 |
| `advanced.cacheEntries` | `20` | 1–200 | 每个浏览器页面或 Python 内核最多保留的结果对象数。 |
| `advanced.cacheMegabytes` | `64` | 1–1024 | 按对象估算内存淘汰旧结果，始终保留最新对象。后续缓存访问时应用。 |
| `advanced.historyEntries` | `20` | 1–200 | 下次运行或重新打开会话时应用，不改变 Notebook 自身的输出历史。 |
| `advanced.historyMegabytes` | `8` | 1–64 | 限制服务端恢复历史所保存的帧数据；下次运行或重新打开会话时应用。 |
| `advanced.metadataTimeout` | `4` | 1–120 | 用于浏览、预览和元数据查询；不包括等待其他单元格执行的时间，不中断用户脚本。 |

### 代码提示与模块（`language`）

| 设置键 | 默认值 | 可用值 | 说明 |
| --- | --- | --- | --- |
| `language.moduleRoot` | `""` | 字符串 | 相对 Jupyter 文件根目录的路径；留空时索引当前文件所在目录及子目录中的 DOS 模块。 |
| `language.documentationLanguage` | `"zh"` | `"zh"`、`"en"` | 函数文档语言 |
| `language.automaticCompletion` | `true` | `true` / `false` | 输入时显示提示；关闭后仍可使用 Ctrl+Space。 |
| `language.hoverDocumentation` | `true` | `true` / `false` | 悬浮显示代码文档 |
| `language.signatureHelp` | `true` | `true` / `false` | 关闭后仍可用 Ctrl+Shift+Space 手动调用。 |
| `language.diagnostics` | `true` | `true` / `false` | 显示代码诊断 |

### 新增连接默认值（`connectionDefaults`）

| 设置键 | 默认值 | 可用值 | 说明 |
| --- | --- | --- | --- |
| `connectionDefaults.port` | `8848` | 1–65535 | DolphinDB 服务器的 WebSocket 端口。 |
| `connectionDefaults.username` | `"admin"` | 字符串，最多 128 字符 | 留空表示匿名连接。每个连接仍可单独设置用户名。 |
| `connectionDefaults.timeout` | `10` | 1–60 | 测试或建立连接的等待时间，范围为 1–60 秒。 |
| `connectionDefaults.ssl` | `false` | `true` / `false` | 在新增连接表单中默认勾选 SSL。服务器需要支持加密 WebSocket。 |

### 侧栏显示（`sidebar`）

| 设置键 | 默认值 | 可用值 | 说明 |
| --- | --- | --- | --- |
| `sidebar.showConnectionAddress` | `true` | `true` / `false` | 关闭后，连接列表只显示名称，编辑连接时仍显示地址。 |
| `sidebar.autoOpenWorkspace` | `true` | `true` / `false` | 仅在尚未保存面板布局时自动显示一次；之后遵循 Jupyter 保存的布局。手动收起或切换侧栏后，切换文档和执行代码只更新内容，可用工具栏按钮重新打开。 |
| `sidebar.collapseLeftOnNarrow` | `true` | `true` / `false` | 窗口宽度小于 1100 像素时为编辑器留出空间。 |
| `sidebar.sortOrder` | `"saved"` | `"saved"`、`"name"`、`"host"` | 只调整侧栏显示顺序，保留已保存配置的顺序。 |
| `sidebar.showConnectionDetails` | `true` | `true` / `false` | 在连接卡片中显示用户名及 SSL 状态。 |
| `sidebar.alwaysShowSearch` | `false` | `true` / `false` | 默认仅在已保存的连接超过 3 个时显示搜索框。 |

`display.decimals: null` 表示实际精度；不会改变 Python / pandas 原生显示或原始数值。行列分页不计入自动添加的索引列。预算中的 MiB 为 1,048,576 字节，结果缓存始终保留最新对象，因此单个最新对象可能超过预算。

当前全部配置定义以 [settings.json](../schema/settings.json) 为准。新增键时同步更新本页和 [开发说明](development.md) 中的验证步骤。

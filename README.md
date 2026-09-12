# dolphindb-extension

在 JupyterLab 和 Jupyter Notebook 7 中使用 DolphinDB：可视化连接管理、DOS 文件执行与调试、Notebook magics，以及数据浏览器。
核心连接、语言服务、语法和调试协议复用 [DolphinDB 官方 VS Code 插件](https://github.com/dolphindb/vscode-extension)，界面与会话按 Jupyter 方式集成。

当前包版本为 **0.1.0b2（Beta）**。本仓库文档对应当前源码；版本变更见 [CHANGELOG](https://github.com/realhuhu/dolphindb-extension/blob/main/CHANGELOG.md)。
已实现能力与剩余差异见 [迁移清单](https://github.com/realhuhu/dolphindb-extension/blob/main/docs/migration.md)。

## 安装与开始使用

需要 Python 3.10+、JupyterLab 4.2+ 或 Notebook 7.2+，以及可访问的 DolphinDB Server。

```shell
python -m pip install "jupyterlab>=4.2,<5" "dolphindb-extension[notebook]==0.1.0b2"
python -m jupyterlab
```

1. 在左侧 **DolphinDB 连接** 面板新增连接，测试并保存，按需设为默认连接。
2. 新建或打开 `.dos` 文件，在工具栏选择连接，运行文件、选区或当前行。
3. 在 Python Notebook 中选择连接，使用 `%ddb` / `%%ddb`；插件会自动加载内核扩展。
4. 在 **Settings → Settings Editor → DolphinDB** 中配置数字精度、分页、预览、补全及其他选项。

安装或升级后重启 Jupyter Server 和 Python 内核、刷新浏览器。Server 和内核分属不同环境时，两边分别安装相应包。
仅使用 DOS 可以省略 `[notebook]`。预构建包不需要 Node.js 或手动 `jupyter lab build`。
详见 [安装与部署](https://github.com/realhuhu/dolphindb-extension/blob/main/docs/installation.md)。

## 功能

- **连接与会话**：侧栏配置和持久化；每个 DOS 独立会话，首次执行后固定连接；Notebook 以 Python 内核为会话单位；在 Jupyter Running 面板管理。
- **DOS 编辑与执行**：文件、选区、当前行、批量运行；增量输出、历史折叠、会话恢复；复用 VS Code 的高亮、补全、文档、参数提示和定义跳转。
- **Notebook**：`%ddb`、`%%ddb`、Python 赋值返回 SDK 原始对象，显式 `ddb_show`；普通 Python 输出遵循 Jupyter 原生行为。
- **数据库与变量**：可折叠面板、变量分组/数量/内存、悬浮预览；表名插入 `loadTable(...)`，眼睛按钮预览数据；完整结构查看和表操作语句生成。
- **数据浏览**：行列分页、当前页排序、嵌套对象、矩阵/张量、图表与曲面、数字显示设置。
- **DOS 调试**：独立 D+虫子侧栏、断点、继续/暂停/单步、调用栈、模块源码及调试变量；仅支持 DOS。

## Notebook 输出示例

赋值后得到普通 Python 对象：

```python
prices = %ddb table(1..3 as id, 10.5 11.2 12.3 as price)
prices  # pandas 原生显示
```

最后一个表达式直接来自 DDB magic 时，自动使用自定义组件：

```python
print("查询结果")
%ddb sum(1..5)
```

显式展示任意 Python 对象，包括 DolphinDB 的返回值：

```python
from dolphindb_extension import ddb_show

ddb_show(prices)
```

`%%ddb` 运行整个单元格；`%%ddb -o result` 将结果存入 Python 变量并关闭该次自动展示。
完整规则见 [Notebook 使用说明](https://github.com/realhuhu/dolphindb-extension/blob/main/docs/notebooks.md)。
可运行示例：[quickstart.dos](https://github.com/realhuhu/dolphindb-extension/blob/main/docs/examples/quickstart.dos) · [quickstart.ipynb](https://github.com/realhuhu/dolphindb-extension/blob/main/docs/examples/quickstart.ipynb)。

## 文档

[文档首页](https://github.com/realhuhu/dolphindb-extension/blob/main/docs/README.md) 包含完整使用说明、架构、故障排查与开发发布流程。

| 使用 | 配置与维护 |
| --- | --- |
| [连接管理](https://github.com/realhuhu/dolphindb-extension/blob/main/docs/connections.md) | [全部设置](https://github.com/realhuhu/dolphindb-extension/blob/main/docs/settings.md) |
| [DOS 文件与会话](https://github.com/realhuhu/dolphindb-extension/blob/main/docs/dos.md) | [故障排查](https://github.com/realhuhu/dolphindb-extension/blob/main/docs/troubleshooting.md) |
| [代码提示与模块](https://github.com/realhuhu/dolphindb-extension/blob/main/docs/language.md) | [架构](https://github.com/realhuhu/dolphindb-extension/blob/main/docs/architecture.md) |
| [数据浏览与结构](https://github.com/realhuhu/dolphindb-extension/blob/main/docs/data-browser.md) | [本地开发与测试](https://github.com/realhuhu/dolphindb-extension/blob/main/docs/development.md) |
| [DOS 调试](https://github.com/realhuhu/dolphindb-extension/blob/main/docs/debugging.md) | [构建检查与发布](https://github.com/realhuhu/dolphindb-extension/blob/main/docs/release.md) |

开发使用 uv、Node.js 22.18+ 和 npm；克隆时使用 `git clone --recurse-submodules`，按照开发文档进行构建与验证。
本项目以 [Apache-2.0](https://github.com/realhuhu/dolphindb-extension/blob/main/LICENSE) 发布，上游及第三方归属见 [NOTICE](https://github.com/realhuhu/dolphindb-extension/blob/main/NOTICE)。

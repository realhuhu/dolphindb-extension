# Notebook magics 与 Python 返回值

[文档首页](README.md) · [项目首页](../README.md)

在 **Python 内核所在环境**安装扩展的 `notebook` extra（包含官方 DolphinDB Python SDK
和 IPython）；本仓库开发环境使用 `uv sync --extra notebook`。Jupyter 服务与内核使用不同环境时，
两边都需安装扩展插件，内核环境还需安装该 extra。

打开 Notebook 后，插件会自动注册 `%ddb` / `%%ddb`，工具栏提供 **DDB 单元格**、连接选择器和
**关闭会话**。点击 **DDB 单元格**会插入代码单元格，以 `%%ddb` 开头，支持 DolphinDB
语法高亮；使用 Notebook 自带的 Shift + Enter 或运行按钮执行。
使用 **重启内核并运行全部**时，会先恢复 DDB 连接配置，再按 Notebook 原有顺序提交代码。
扩展通过 Jupyter 的 `INotebookCellExecutor` 服务保证自动加载和连接配置消息先于用户单元格，
然后调用 Jupyter 原生执行逻辑。执行适配器不读取或解析单元格源码；`%ddb` / `%%ddb`、赋值和错误由
IPython 处理。未配置 DDB 或缺少内核扩展时，普通 Python 与其他 magic 仍可运行，DDB 错误显示在执行它的单元格中。
元数据查询与单元格共用内核执行队列，不会在后台子内核并发访问同一 DDB 会话。
查询排队等待长时间单元格时不计入元数据执行超时；断线重连后自动刷新数据库与变量。
若同时安装了其他替换此服务的扩展，
需要选择其中一个执行器插件。

此分层参考 [JupySQL 的 magic 注册和参数处理](https://github.com/ploomber/jupysql/blob/e4b695ac8cf40849bd4ce98388432a1875ad1828/src/sql/magic.py)、
[JupySQL 表格的数据排序与 comm 通信](https://github.com/ploomber/jupysql/blob/e4b695ac8cf40849bd4ce98388432a1875ad1828/src/sql/widgets/table_widget/table_widget.py)，
以及 [jupysql-plugin 的 Jupyter 编辑器扩展](https://github.com/ploomber/jupysql-plugin/blob/c3af36708261761b36e591a0913dd9f794ca3702/src/editor/index.ts)。
`%%ddb -o` / `--out` 使用 IPython 的 `magic_arguments`，可通过 `%ddb?` 查看参数帮助；DolphinDB 语义和会话仍由官方 SDK 与原 VS Code 算法提供。

单行代码可直接显示结果，也可赋给 Python 变量：

```python
aaa = %ddb 1 + 1
print(aaa)  # 2

prices = %ddb table(1..3 as id, 10.5 11.2 12.3 as price)
prices["price"].mean()  # 返回的 prices 是 pandas.DataFrame
```

`%%ddb` 必须位于单元格第一行，其后内容原样作为 DolphinDB 脚本执行：

```text
%%ddb
t = table(1..3 as id, 10.5 11.2 12.3 as price)
print("DolphinDB ready")
select * from t
```

多行代码的最终返回值可通过 `-o` / `--out` 保存到 Python 命名空间：

```text
%%ddb -o aaa
select id, price from t where price > 11
```

随后在普通 Python 单元格使用 `aaa`。这些返回值直接来自官方
[`Session.run`](https://docs.dolphindb.com/en/pydoc/BasicOperations/Session/OtherParams.html)，
保留标量、NumPy 数组、pandas DataFrame、日期时间等 SDK 原生类型，不经过 JSON 或字符串转换。
代码中的 `$`、花括号、引号不会被 IPython 变量插值修改。`print()` 经 SDK 的会话消息回调
显示在当前单元格中，执行错误通过 Notebook 标准错误输出显示。

首次运行前默认使用侧栏选择的连接，也可通过 Notebook 工具栏单独切换。第一次执行建立该
Python 内核的 DolphinDB 会话并固定连接，后续 `%ddb` 和 `%%ddb` 共用会话变量；代码报错也保留会话。
关闭 Notebook 页面或刷新浏览器后，Python 内核和 DDB 会话仍可复用。执行 `%ddb_close` 或点击
**关闭会话**释放 DDB 会话后可重新选连接；已有 Python 返回值变量仍保留在内核中。
右侧数据库与变量面板在首次运行前预览所选连接的数据库；执行后自动显示该 Python 内核的 DDB
会话变量，并在执行结束后刷新。表名点击插入 `loadTable(...)`，眼睛按钮按配置预览数据（默认前 100 行），预览不固定连接。
关闭或重启 Python 内核会结束其 DDB 会话，也可以在 **正在运行的内核和终端 → DolphinDB 会话** 中只关闭 DDB 会话。
会话列表通过 Jupyter comm 查询已有会话，关闭 Notebook 页面或刷新后仍能发现；未运行 DDB 的 Notebook 不会列入。
如果两个 Notebook 显式共用同一个 Python 内核，它们也共用该 DDB 会话；DOS 文件会话保持独立。

Notebook 由 Python 内核通过原生 TCP / SSL 连接 DolphinDB，内核所在机器需要能访问配置的地址；
连接及执行超时遵循官方 Python SDK 默认值，侧栏的 WebSocket 连接超时不用于限制查询执行时间。
密码通过经过身份验证的 Jupyter API 和内核 comm 临时传递，不写入单元格、Notebook 元数据、
输出或执行历史。仅存在 Jupyter 服务内存中的密码也可使用。

在独立 IPython 环境或需要手动加载时，可以运行：

```python
%load_ext dolphindb_extension
%ddb_connect "连接名称"
aaa = %ddb 1 + 1
%ddb_close
```

手动选择读取 Jupyter 配置目录中的已保存连接和系统凭据库；可用 `DOLPHINDB_CONNECTIONS_DIR`
环境变量指定自定义连接目录。服务内存中的临时密码需通过 Notebook 工具栏传入。
`%ddb_connect` 不带参数时显示当前连接和状态，不显示密码。

## 结果展示规则

以下代码分别放在单独单元格中。`%ddb` 接收其所在行后面的 DolphinDB 表达式；`%%ddb` 必须是单元格第一行。

| 单元格形式 | Python 返回值 | 输出方式 |
| --- | --- | --- |
| `%ddb 1 + 1` | SDK 原始结果 | 最后一个表达式直接来自 DDB，使用自定义组件 |
| `%%ddb` 后接脚本 | 脚本的最终 SDK 结果 | 自动使用自定义组件；`None` 不产生结果组件 |
| 先写普通 Python，最后一行 `%ddb 1 + 1` | SDK 原始结果 | 最后一个表达式直接来自 DDB，使用自定义组件 |
| `a = %ddb 1 + 1` | 原始结果存入 `a` | 赋值不产生结果组件 |
| `a = %ddb 1 + 1`，下一行 `a` | 原始 `a` | Python / pandas 原生显示 |
| `%%ddb -o a` 后接脚本 | 原始结果存入 `a` | 不自动展示；后续 `a` 使用原生显示 |
| `ddb_show(a)` 或 `%ddb_show a` | 不改变 `a` | 显式使用自定义组件，可用于任意 Python 对象 |

```python
a = %ddb table(1..3 as id, 10.5 11.2 12.3 as price)
a  # 最后输出是 Python 名称：保持 pandas 原生显示
```

```python
from dolphindb_extension import ddb_show
ddb_show(a)  # 显式打开自定义数据浏览组件
```

普通 Python 表达式、`display(a)`、其他 magic 和它们的输出遵循 IPython 的原生行为；扩展不安装全局对象格式化器。`%ddb` 在中间语句中执行时，仍遵循 IPython 的表达式输出规则，不强行显示每一条返回值。

## 示例 Notebook

下载并在 Jupyter 中打开 [quickstart.ipynb](examples/quickstart.ipynb)。它覆盖普通 Python、DDB 单行赋值、多行运行、原生与显式自定义展示、带数字索引的 DataFrame、嵌套对象和张量。示例没有保存任何输出、连接地址或密码。

同一 Notebook 的 **New View for Notebook** 视图共享模型和内核，补全与 F12 导航跟随发起请求的编辑器。关闭某个视图不会移除其他视图的语言绑定。不同 Notebook 若主动选择同一个 Python 内核，也共用该内核的 Python 变量和 DDB 会话。

`%ddb_connect`、`%ddb_close` 和 `ddb_show` 不是普通 Python 解释器的独立连接 API；在 `.py` 程序中直接使用官方 DolphinDB Python SDK。

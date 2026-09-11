# 与 VS Code 的对应关系

[文档首页](README.md) · [项目首页](../README.md)

迁移目标是覆盖 DolphinDB VS Code 插件的能力。当前参照仓库的 Git submodule 固定提交
`bd726b584540d09a8f23b423b040c9f5ce728d61`，不是跟随上游最新版自动更新。
各提取文件的版本和 SHA-256 位于 [provenance](../frontend/upstream/provenance.json) 及语言、图表、调试各自的 provenance 文件。

## 已提供

| 原能力 | Jupyter 中的实现 |
| --- | --- |
| 连接配置、登录、测试和切换 | 原生连接侧栏、系统凭据库、默认配置与每文档连接选择 |
| 文件、选区、当前行和批量执行 | DOS 工具栏、快捷键、顺序批处理、输出和中断 |
| 语法与语言辅助 | 同源 TextMate 语法及 DocsProvider；作用域、片段、SQL / 模块提示、文档、签名、F12 |
| 数据库和变量树 | 当前文件/内核的数据库、变量、类型分组、数量、大小及悬浮预览 |
| 数据视图 | 表、向量、数对、集合、字典、矩阵、数组向量、嵌套对象、行列分页及张量切片 |
| 图表 | 上游图表构造适配 ECharts，三维曲面使用 Plotly，图像下载和主题支持 |
| schema 与表操作 | 全部返回的 schema 属性、字段表及分区信息；生成 select/update/delete/truncate/loadTable/schema 文本 |
| 数字显示 | Settings Editor 中统一选择实际精度或小数位数；保留原始排序值 |
| 调试 | 独立 DOS 面板、断点、异常暂停、单步、栈帧、变量预览、模块只读源码和 Running 管理 |

## Jupyter 适配差异

- 每个 DOS 文件第一次提交代码后固定自己的会话，不使用 VS Code 式全局执行会话。
- Python Notebook 使用每内核的 DDB 会话；`%ddb`、`%%ddb`、原生 Python 赋值及 `ddb_show` 是新增集成。
- 数据树点击表名插入 `loadTable(...)`，眼睛按钮预览数据，悬浮展示结构；变量点击插入名称。
- 设置、工具栏、弹窗、折叠、代码编辑器和 Running 采用 Jupyter 组件及布局。
- DOS 历史、数据浏览缓存和预览有明确预算；刷新恢复不等于持久化完整计算结果。
- Notebook 保持普通 Python 输出规则，仅 DDB 最终直接输出及显式展示使用自定义组件。

## 尚未迁移或不提供

| 能力 | 当前边界 |
| --- | --- |
| 文件 / 目录上传到 DolphinDB | 没有原 VS Code `upload_file` 的图形命令；Jupyter 文件浏览器的上传只上传到 Jupyter |
| 模块上传与加密 | 没有 `upload_module`、自动上传后加载或 `.dom` 加密入口；模块运行前需部署到服务器 |
| DolphinDB 单元测试命令 | 没有 VS Code 上传并执行 `test(...)` 的专用测试入口；可自行执行已部署的测试脚本 |
| 一键 CSV 导出 | 数据浏览器没有 CSV 导出按钮；Notebook 可对原生 DataFrame 使用 pandas 导出 |
| VS Code 独立 DolphinDB 终端 | 当前通过 DOS 结果区或 Notebook 执行，不提供独立的交互式终端 |
| 条件断点、监视表达式和修改调试变量 | 当前采用的服务端调试协议没有相应 RPC，本插件不模拟这些能力 |
| 完整语法 / 类型检查 | 目前诊断重点是上游提供的缺失模块检查，不替代服务端执行校验 |

向量、矩阵和图表浏览已实现；CSV 导出尚未实现，这两项不再合并为一个迁移状态。
完整能力以 [用户文档](README.md) 和 [测试范围](development.md) 为准。

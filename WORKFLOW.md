# qqfriend 省额度工作流

本项目以后按“分层模型派单”执行任务。目标是减少高配模型用量，让低风险苦力活交给便宜/快速模型，中风险小功能交给中等模型，高配模型只做架构、救火和最终审查。

核心原则：

- 一个任务只改一类问题。
- 不把完整项目、完整聊天记录、完整 `package-lock` diff 反复塞给高配模型。
- 不贴真实 `.env`、真实 key、聊天记忆或用户隐私数据。
- 高配模型只看关键 diff、失败日志和最终风险点。
- 所有模型调用、认证头、storage、reply 主流程相关修改都按高风险处理。

## 模型分工

### A 档：便宜模型 / 快速模型

适合做低风险、机械性、文档类任务：

- README / TOOLS / CHANGELOG / MEMORY / WORKFLOW 同步
- 命令列表整理
- 中英文帮助文本
- 版本号替换
- 简单 grep 搜索
- 列出修改文件
- 生成测试用例清单
- 清 unused import
- `prefer-const`
- 简单格式修复

禁止 A 档单独修改：

- `bridge/model-mimo.mjs`
- `bridge/model-ds.mjs`
- `bridge/clients/llm-client.mjs`
- `bridge/storage.mjs`
- `bridge/reply.mjs` 主流程
- 认证头、key、`buildBearerAuth`、`maskSecret`
- 关系分数计算
- 上下文系统

A 档输出要求：

- 只能做低风险 patch。
- 必须说明修改文件。
- 如改代码，运行 `npm.cmd run lint` 和 `npm.cmd test`。
- 如果失败，停止并输出失败原因，不继续扩大范围。

### B 档：中等模型

适合做中风险、纯函数、小功能和测试：

- 新增简单纯函数
- 补单元测试
- 命令解析
- help/status/version/changelog 文本构造
- relationship summary 文案测试
- `splitLongText` 这类工具函数
- `cleanThinking` 测试

可以改：

- `bridge/admin-commands.mjs`
- `bridge/help.mjs`
- `bridge/version.mjs`
- `bridge/relationship-commands.mjs`
- `test/*.test.mjs`
- `README.md`
- `TOOLS.md`
- `CHANGELOG.md`

谨慎改：

- `bridge/reply.mjs`
- `bridge/napcat.mjs`
- `bridge/thinking.mjs`

禁止 B 档单独改：

- `bridge/model-mimo.mjs`
- `bridge/model-ds.mjs`
- `bridge/clients/llm-client.mjs`
- `bridge/storage.mjs`
- 核心上下文主流程

B 档完成后，高配模型只做简短 review。

### C 档：GPT-5.5 超高

只用于高风险任务：

- 认证 / API 401 / key 安全
- 思维链泄露
- 回答被截断
- NapCat 发送层 bug
- 模型 fallback 逻辑
- storage 数据兼容
- relationship 评分设计
- context-builder 架构
- `reply.mjs` 主流程接入
- 发布前最终审查

使用原则：

- 不让高配模型写大段文档。
- 不让高配模型清 unused import。
- 不让高配模型做版本号替换。
- 不让高配模型跑机械检查。
- 高配模型只看关键 diff、失败日志、最终风险点。

## 任务路由规则

收到任务后先分类，再决定模型档位。

低风险关键词：

- 文档
- 说明
- CHANGELOG
- README
- 帮助文本
- 命令列表
- 翻译
- 版本号
- 格式
- unused import

派给：A 档。

中风险关键词：

- 新增命令
- 解析命令
- 补测试
- 纯函数
- status
- version
- changelog
- relationship summary
- splitLongText

派给：B 档。完成后 C 档只看摘要和关键 diff。

高风险关键词：

- 401
- Authorization
- Bearer
- key
- reasoning_content
- 思维链泄露
- 截断
- sendMsg
- NapCat
- fallback
- storage
- reply.mjs
- model-mimo
- model-ds
- llm-client
- 上下文
- 权限绕过

派给：C 档。

## 省额度执行流程

### Phase 0：便宜模型扫描

先让 A 档只做定位，不改代码：

1. 列出相关文件。
2. grep 关键词。
3. 找出疑似位置。
4. 输出简短报告。
5. 不贴完整项目。

示例：

```text
请只搜索，不修改。
找出所有 version / changelog / 更新日志 命令相关位置。
输出文件名、函数名、行附近摘要。
不要改代码。
```

### Phase 1：中等模型小改

让 B 档做小 patch：

1. 只改指定文件。
2. 不碰核心模型调用。
3. 不碰 storage。
4. 不碰认证头。
5. 补测试。
6. 跑 `npm.cmd run lint` 和 `npm.cmd test`。

### Phase 2：高配模型审查

C 档只看结果，不重新吃完整项目：

1. 修改摘要。
2. `git diff --stat`。
3. 关键 diff。
4. `npm.cmd run lint` 结果。
5. `npm.cmd test` 结果。
6. 必要时看 `npm.cmd start` 或 `/health` 结果。

失败日志只贴关键 100 行。

## Codex / GPT 省额度细则

Codex 里也按分层思想执行，但要注意：如果当前界面不能真正切换模型，就用“少上下文、少重跑、少高风险分析”的方式省额度。

Codex 默认做法：

1. 先用 `rg` / `git diff --stat` / 小范围文件读取定位问题。
2. 只读取相关文件，不一次性塞完整项目。
3. 只在需要时读取 docx / README / CHANGELOG，不重复贴全文。
4. 修改前先判断风险档位。
5. 低风险文档任务不启动 bot。
6. 小改只跑 `npm.cmd run lint` 和 `npm.cmd test`。
7. 只有运行时行为、启动流程、NapCat 接入、权限或模型调用变化时，才跑 `npm.cmd start`。
8. 高风险审查只看关键 diff、关键日志和失败命令，不看完整仓库。

给 GPT / 高配模型的最小输入包：

```text
任务类型：
风险档位：
修改文件：
git diff --stat：
关键 diff：
lint 结果：
test 结果：
start/health 结果（如有）：
剩余风险：
```

不要给高配模型：

- 完整 `node_modules`
- 完整 `package-lock.json` diff
- 完整聊天记录
- 真实 `.env`
- 真实 key
- 大段无关日志
- 已经通过的完整测试输出

需要高配模型时，优先问：

```text
只审查以下 diff 是否有安全、认证、模型 fallback、权限或数据兼容风险。
不要重写文档，不要扩大改动范围。
```

一句话：Codex 负责读仓库和落小 patch，高配 GPT 只负责关键判断。

## 固定模板

### 低风险任务模板

```text
使用便宜模型执行。

任务类型：low-risk cleanup / docs / tests

只允许修改：
- README.md
- TOOLS.md
- CHANGELOG.md
- MEMORY.md
- WORKFLOW.md
- test/*.test.mjs
- bridge/help.mjs
- bridge/version.mjs

禁止修改：
- bridge/model-mimo.mjs
- bridge/model-ds.mjs
- bridge/clients/llm-client.mjs
- bridge/storage.mjs
- bridge/reply.mjs 主流程
- buildBearerAuth / maskSecret

修改后运行：
npm.cmd run lint
npm.cmd test

如果失败，停止并输出失败原因，不要扩大修改范围。
```

### 中风险任务模板

```text
使用中等模型执行。

任务类型：medium-risk feature / parser / pure-function

要求：
1. 先列出要改的文件
2. 每次只做一个功能
3. 必须补测试
4. 不改模型调用
5. 不改认证头
6. 不改 storage
7. 不启用未授权功能

修改后运行：
npm.cmd run lint
npm.cmd test

输出：
- 修改文件
- 新增测试
- 验收结果
- 剩余风险
```

### 高风险任务模板

```text
使用 GPT-5.5 超高执行。

任务类型：high-risk bugfix / architecture / security

允许分析：
- reply.mjs 主流程
- napcat.mjs 发送层
- thinking.mjs 思维链清洗
- model-mimo.mjs
- model-ds.mjs
- llm-client.mjs
- storage 数据兼容

要求：
1. 先复现或定位
2. 给最小修复方案
3. 不大重构
4. 不删除 fallback
5. 不泄漏 key
6. 不把 reasoning_content 发给用户
7. 不删除测试
8. 不关闭 ESLint

验收：
npm.cmd ci
npm.cmd run lint
npm.cmd test
npm.cmd start
```

## qqfriend 当前推荐分工

A 档可以做：

- README / TOOLS / CHANGELOG 更新
- 帮助文本润色
- 中英文文案
- 更新日志命令文本
- 版本号同步
- `.env.example` 示例
- 测试标题整理

B 档可以做：

- `@夜星 更新` / `changelog` 命令
- help 文本测试
- admin-commands 纯解析测试
- relationship summary 文案测试
- splitLongText 工具函数测试
- cleanThinking 测试

C 档才做：

- 思维链泄露修复
- 回答截断修复
- sendMsg 分段发送
- reasoning_content 禁止外发
- 模型 max_tokens 调整
- DeepSeek / MiMo fallback
- storage 结构升级
- 关系分数算法大改
- 上下文系统接入

## 强制省额度规则

1. 不把完整工作流反复发给高配模型。
2. 不让高配模型改文档。
3. 不让高配模型做 grep。
4. 不让高配模型做版本号替换。
5. 高配模型只看关键 diff 和失败日志。
6. 一个任务只改一类问题。
7. 失败日志只贴关键 100 行。
8. 不贴完整 `node_modules` / `package-lock` diff。
9. 不贴完整聊天记录。
10. 不贴真实 `.env`。

## 推荐日常流程

1. A 档：搜索相关文件，列出修改点。
2. B 档：做具体 patch，补测试。
3. 本地 / Codex：跑 `npm.cmd run lint`、`npm.cmd test`、必要时 `npm.cmd start`。
4. C 档：只看失败日志或最终 diff，做审查。

一句话原则：

```text
便宜模型做苦力；
中等模型写小功能；
GPT-5.5 超高只当架构师、救火队和最终审查员。
```

# 夜星桥接器更新日志

## v1.4.2-summary-recovery - 2026-08-26 - 群日报正文恢复
- 修复日报在深度思考档位下只返回 `reasoning_content`、最终正文为空的问题：主模型输出预算由 2048 提升到 8192，为内部分析和 450-800 字最终日报同时预留空间。
- 日报备用插槽改为固定省额度恢复通道，即使管理界面把任务设为深度思考，备用模型仍会显式关闭思考，并用 3072 输出额度优先生成可发送正文。
- 任务模型网关新增受控的单次思考档位覆盖，只供具体恢复链使用；普通群聊、私聊、图片、关系和其他任务继续遵循管理界面保存的路由配置。
- 本地兜底日报改为结构化事实摘要：展示主要主题、讨论时段、相关消息数、参与人数、媒体记录和参与概况，不再向群里发送“模型暂未生成正文”等后台故障占位文案。
- `reasoning_content`、`reasoning`、`analysis` 和 `thinking` 继续只统计长度，不会作为日报正文或任何 QQ 回复外发。
- 回归测试新增“线上任务设为 deep 时备用恢复仍为 disabled”以及“主模型推理耗尽后正确切换备用正文”场景；`npm run lint` 0 errors / 0 warnings，`npm test` 606/606 pass。

## v1.4.1-runtime-resilience - 2026-08-20 - 消息链路与时钟韧性修复
- 修复 Linux 开机校时回拨后全局事件窗口冻结的问题：日志风暴、消息限流、冷却、缓存、watchdog 和请求耗时改用单调时钟，墙钟只保留给真实日历时间。
- 消息准入拆成高阈值入口保护与按群/私聊范围隔离的普通、优先通道；黑名单、自身消息和非白名单群在占用正常群额度前即被拒绝，`@机器人` 与管理员流量不会被普通刷屏挤掉。
- 新增结构化管线状态：记录收取、接纳、处理、失败、外发、按原因丢弃、时钟跳变和最近事件时间；`/health` 保持进程存活语义，新增 `/ready` 反映 OneBot 链路与队列是否真的可用。
- OneBot 反向 WebSocket 新增连接代次保护、ping/pong 半开检测、新连接替换旧连接、最大 1000 项有界队列以及按群/私聊范围串行处理；不同群可并行，同群消息保持顺序。
- 消息 `message_id` 在 HTTP 与 WebSocket 共用 10 分钟幂等窗口，重复投递不会重复调用模型或重复发送；旧连接迟到事件和队列溢出均有独立计数。
- 日报已发送标记改为原子 JSON；真正外发前写入尝试状态，成功后提交已发送状态，确认失败才释放重试。进程若在发送结果不明时崩溃，自动任务会停止补发，避免同一日报出现第二条。
- Bridge 开机后会等待 OneBot 就绪再补跑“昨天”的日报，继续与用户 cron、`flock` 和逐群锁共用幂等保护，不会在白天误生成当天日报。
- 修复侧车白名单“存在但为空”被错误回退的问题；空的日报、资源、词云或表情群文件现在会真正关闭对应功能，文件缺失时才继承主群白名单。
- JM、普通资源、词云与表情临时文件新增启动加每小时周期清理；活动任务受进程内保护，重启后未到期目录会在到期后的下一轮清扫中删除。
- 用户记忆和群聊记录防抖窗口由 30 秒缩短到 5 秒；加载时会修正因错误墙钟写入的远未来聊天时间，受控退出继续先排空 OneBot 队列再原子落盘。
- 画像生成只有成功后才写入 6 小时/30 条节流标记，并合并同一用户的并发刷新；模型失败不会让画像更新静默停摆。
- API 传输层只对网络异常、429 与 5xx 做一次短延迟重试，401/403 等配置错误不重试；SSRF 防护在每次重定向外增加 DNS 解析地址检查，拒绝解析到本机、内网和链路本地地址的域名。
- Linux 新增 `install-time-order.sh` 与 Docker systemd drop-in，使用 `Wants/After=chrony-wait.service` 等待校时但不硬依赖网络；运行检查同时验证 `qqfriend.env` 权限、Docker 时钟顺序、`/health` 和 `/ready`。
- Linux 增加 `Dockerfile.overlay` 离线源码覆盖路径：仅在依赖锁未变化且本机已有已验收 Bridge 镜像时使用，Docker Hub 暂时不可达也能更新应用层；标准全量构建仍是发布基线。
- 验收：`npm run lint` 0 errors / 0 warnings，`npm test` 604/604 pass；新增时钟回拨、跨入口幂等、WS 换代/心跳/队列、QQ 登录就绪、空配置语义、日报崩溃状态、启动补发、API 重试、DNS SSRF 与离线覆盖构建测试。

## v1.4.0-linux-preview - 2026-08-19 - 独立 Linux 服务器预览版
- 新增独立 `agent/linux-server-preview` 交付线，Linux 代码、配置与运行状态不覆盖当前 Windows 安装，也不会在开发和验证阶段重启 Windows Bot。
- 新增 `deploy/linux/`：提供固定 Node 22.23.2 的 Bridge 镜像、固定 `mlikiowa/napcat-docker:v4.18.13` 的 Compose、低权限 systemd 单元、日报 timer、初始化脚本、预检脚本与中文部署说明；首次启动前会生成仅绑定 `127.0.0.1` 的 NapCat WebUI 配置和独立随机令牌。
- Bridge 增加 `QQBOT_LISTEN_HOST`、`QQBOT_LISTEN_PORT`、`QQBOT_NAPCAT_API`、`QQBOT_NAPCAT_WS_API` 与 `QQBOT_NAPCAT_TOKEN` 等跨平台配置；Windows 默认值和原有单机路径保持不变。
- NapCat HTTP 请求统一支持 Bearer 鉴权，收藏表情接口也走同一安全头；令牌不写日志、不进入管理快照、不进入发布包。
- 新增 NapCat `upload_file_stream` 客户端：文件先计算 SHA-256，再按 64 KiB 至 1 MiB 有界分块顺序上传；完成后只把 NapCat 返回的容器内路径交给群文件或私聊文件接口。
- Linux 默认强制流式文件上传，WS 失败时不会把 Bridge 的 `/tmp` 路径错误回退给 NapCat；Windows 未配置 WS 时继续使用现有本地路径模式。
- 复用 Windows 控制台的 HTML/CSS/JS，新增浏览器 Host：状态、日志、配置、API、梗库、表情、诊断和备份继续使用原 `/admin/*` API；背景图保存在浏览器 IndexedDB。
- 浏览器控制台与管理 API 仅允许环回请求并带 CSP、固定静态文件白名单和可选管理令牌；远程访问通过 SSH 端口转发，不开放公网管理端口。
- Linux 配置、运行数据、日志、临时目录和安全备份分别映射到独立数据卷；`TMPDIR` 指向持久临时卷，JM 压缩包继续在一天后清理，普通资源转发完成后立即删除。
- 修正容器只读根目录兼容：控制台配置写入 `/config`，管理员审计写入 `/logs`，用户画像写入 `/data`；重启容器后画像不会因落在临时目录而丢失。
- 新增 `.dockerignore` 与发布清单约束，Linux 包仍排除 `.env*`、API Key、QQ 登录数据、聊天记忆、日志、备份、个人文档、WebView2 数据和本机绝对路径。
- 发布包补齐启动器源码以保证解压后可自测，仍排除 `bin`、`obj` 与 WebView2 用户数据；Linux 原生运行时默认选择系统标准的 `python3`。
- 发布 ZIP 统一写入 Unix 安全权限：普通文件 `0644`、部署脚本 `0755`，并在生成后复验；Docker 构建支持仅在构建期使用可选 PyPI 镜像。
- 新增 `npm run smoke:linux`，会用临时测试配置启动环回 Bridge，验证 `/health`、`/admin/status`、`/console/` 和 CSP 后自动退出。
- Compose 改用隔离容器网络，避免 NapCat 的 Xvfb 显示号与 Linux 桌面冲突；宿主机端口仍全部只绑定 `127.0.0.1`，Bridge 通过容器服务名连接 NapCat。
- 容器化管理请求会识别 Docker 私有网关，但只有显式容器模式才启用；管理 API 对这类请求仍强制校验随机令牌，公网地址继续拒绝。
- 图片识别任务默认关闭内部长推理，把有限输出预算留给可发送的视觉正文；不支持图片的 MiMo 2.5 Pro 不再作为 Linux 视觉备用，表情分析不再因“主路只有推理、备用 404”整批失败。
- API 实例连接测试统一使用省额度推理策略，修复 DeepSeek 接口返回 HTTP 200 却因测试预算被内部推理耗尽而显示失败的问题；内部推理仍不会进入最终输出。
- 已在 Ubuntu 26.04 x86_64 实机完成 Docker 部署：Bridge 与 NapCat 镜像经过 SHA-256 校验后导入，NapCat 登录、OneBot HTTP/WS、反向 WebSocket、浏览器控制台和管理鉴权均通过，Windows 生产安装未被覆盖。
- Docker 部署新增无需 root 和宿主机 Node.js 的用户 crontab，每天北京时间 00:05 调用容器内日报入口；`flock` 防止任务重叠，并继续复用逐群发送锁防止重复日报。该方式会在每次任务启动时读取当前 Docker 用户组，避免常驻 user-systemd 缓存旧组权限。
- 修复 Linux 镜像内置 7za 只有读取权限、JM 下载完成后无法生成 ZIP 的问题；镜像构建会补执行权限并当场试运行，自检与控制台也改为验证 7za 实际可执行，不再把“路径存在”误报为正常。
- Linux Compose 补齐 NapCat 快速登录账号与密码回退变量；登录态过期时可使用服务器私有 `.env` 中的密码 MD5 自动恢复，并明确凭据不得进入 GitHub 或发布包。
- Linux 部署脚本统一锁定 LF 行尾并加入回归测试，避免从 Windows 交付后因 `bash\r` 导致初始化或运行自检无法执行。
- 验收：`npm run lint` 0 errors / 0 warnings、`npm test` 578/578 pass、Linux 浏览器烟雾、JM Python 依赖、真实 MiMo/DeepSeek 文本连接与 MiMo 图片输入检查通过；Bridge `/health` 为 ok，两只容器重启计数均为 0。

## v1.3.9-module-resilience - 2026-08-13 - 模块韧性与真实健康状态
- 表情分析改用统一预览读取链路：QQ 临时图片地址会先续签，主视觉模型返回空正文或不安全内容时会切换视觉备用模型，不会把内部推理当作标签写入目录。
- 群采集候选连续 6 次因下载失效或安全拦截无法分析时自动退役；退役项不再占用采集上限和待分析队列，历史残留会在启动时迁移并按保留策略清理。
- NapCat 群聊、私聊和图文发送增加有界重试；长消息某一段持续失败后停止发送后续分段，避免前半段缺失却继续发送尾部内容。
- 随机插话在主模型无可用正文时会尝试任务路由中配置的备用模型；两路均不可用才回到本地静默策略，普通群聊的 DeepSeek 保护性备用保持不变。
- JM Python 依赖增加锁定清单并完成运行环境安装；控制台展示实际 Python、jmcomic 与 7-Zip 健康状态，探针在启动时后台运行，不再阻塞消息事件循环。
- 管理状态与模块目录统一返回 `ready / degraded / disabled` 实时状态，控制台顶部和模块列表会直接提示需要处理的功能，不再一律显示“全部正常”。
- 日报调度收敛为 OpenClaw 单一入口，Windows 重复任务已停用；发送级并发锁继续保留，避免同一日报被两个调度器重复触发。
- 梗库原子写入遗留的 24 小时以上临时文件会在启动时清理；运行数据、聊天记录、API Key 和私有配置仍不会进入发布包或 GitHub。
- 发布包中的 `.qqfriend` 改为公开结构清单白名单；API 路由备份和任何未来新增的运行态文件默认拒绝打包，避免文件名变体绕过过滤。
- 验收：`npm ci`、`npm run check:runtime`、`npm run check:jm` 与 `npm run release:check` 通过，`npm run lint` 0 errors / 0 warnings，`npm test` 555/555 pass，依赖审计 0 vulnerabilities，控制台构建 0 warnings / 0 errors；实机重启后 `/health` 与模块健康状态均正常。

## v1.3.8-github-card - 2026-08-13 - GitHub 卡片排版优化
- GitHub 仓库补齐 About 简介与技术标签，README 重做为中文项目首页，先展示能力、链路、快速启动和安全边界，不再把排障与历史说明堆在首屏。
- GitHub 仓库预览重排为“仓库名与简介、核心数据、补充信息”三层，减少原先逐项罗列字段带来的杂乱感。
- 仓库简介限制为 120 字；没有简介时直接省略占位文案，避免无意义信息挤占群聊空间。
- 主题最多展示 3 个并改用 `#topic` 标签；模板仓库与 Fork 属性并入许可证和更新时间所在的补充信息行。
- 只有“已归档”或“已停用”会另起状态提醒，正常仓库不再显示多余状态行。
- GitHub 官方 API、15 分钟缓存、安全图片代理、失败回退、B站专用解析和链接去重策略均保持不变。
- 验收：`npm ci` 通过，`npm run lint` 0 errors / 0 warnings，`npm test` 545/545 pass，`npm run release:check` pass，生产依赖审计 0 vulnerabilities，`/health` 返回 ok，NapCat WebSocket 已连接。

## v1.3.7-github-preview - 2026-08-10 - GitHub 仓库专用预览
- 新增独立 `bridge/services/link-preview/github.mjs`，识别 GitHub 公开仓库主页以及仓库内的代码、Issue、PR、Release 等子页面，并统一归一到仓库级元数据。
- 通过 GitHub 官方 `GET /repos/{owner}/{repo}` 读取公开仓库，无需新增 Token 或密钥配置；只保留公开简介、语言、Stars、Forks、许可证、主题、更新时间和仓库状态。
- GitHub 首页、搜索、Topics、Marketplace、登录页和非 GitHub 主域不会被误判成仓库链接；私有仓库元数据不会进入预览结果。
- 仓库元数据加入 15 分钟、最多 100 项的内存缓存；同仓库不同子页面复用缓存，并继续受群级 30 分钟链接去重约束。
- GitHub API 限流、返回异常、仓库不存在或响应格式不符时自动退回通用网页预览，不影响消息发送链路。
- 仓库社交封面使用 GitHub 官方图片地址，仍由共享安全重定向和内存图片代理处理；不写本地图片，失败时发送纯文字卡片。
- 统一链接状态新增 `githubHits`，桌面控制台可单独查看 GitHub 专用解析命中数；B站专用解析及原有智能预览规则保持不变。
- 新增 GitHub URL 边界、导航页排除、公开字段格式化、私有数据隔离、缓存、专用路由与通用回退测试。
- 验收：`npm ci` 通过，`npm run lint` 0 errors / 0 warnings，`npm test` 543/543 pass，`npm run release:check` pass，控制台构建 0 warnings / 0 errors，生产依赖审计 0 vulnerabilities。

## v1.3.6-smart-link-preview - 2026-08-10 - 智能链接预览
- 自动链接预览新增独立策略层：只处理单个公开网页；@机器人、多链接、长消息、文件直链、QQ 媒体地址、长群和不安全地址均安静跳过。
- 同一群对等价链接执行 30 分钟内存去重；`utm_*`、`spm`、`from`、`ref`、分享标识和时间戳等跟踪参数不会绕过去重。
- 自动预览只在网页标题、摘要或图片确实补充原消息时发送；反爬页、错误页和原文已写明同一标题的低价值页面不再回声式插话。
- 被 @ 的含链接消息只进入正常命令或 AI 回复链路，不再额外发自动卡片；所有含链接消息即使预览失败或被策略跳过，也会阻止随机插话。
- 通用页面读取只接受 HTML、纯文本或 XHTML，并按每次重定向重新执行公网地址检查；元数据以最终地址为基准，跨站 canonical 不再覆盖实际来源。
- 预览文案改为中文并固定显示实际域名；页面自报站点名称只能作为补充，不能隐藏真正来源。
- 预览图通过安全图片代理下载到内存并转换为 `base64://` 后交给 NapCat，不保存本地文件；超限、非图片或下载失败时退回纯文字预览。
- `sendMsgWithImage` 默认改为普通图片，只有显式传入 `flash: true` 才发送闪照，修复链接封面、B 站封面和词云被误标为闪照的问题。
- 控制台链接预览状态新增智能模式、跳过次数和重复拦截次数，与真实抓取错误分开显示。
- 新增智能策略、跟踪参数去重、自动路由、图片内存代理、最终跳转、MIME 拦截与普通/闪照发送测试。
- 验收：`npm ci` 通过，`npm run lint` 0 errors / 0 warnings，`npm test` 536/536 pass，`npm run release:check` pass，控制台构建 0 warnings / 0 errors，生产依赖审计 0 vulnerabilities。

## v1.3.5-summary-analysis - 2026-08-06 - 证据化群日报
- 群日报默认路由调整为 DeepSeek V4 Flash 主分析、MiMo 备用、本地事实摘要最终保障；群聊主回复路由保持不变。
- DeepSeek V4 Flash 日报默认关闭隐藏长推理，将 2048 token 预算留给最终正文并保留 120 秒超时窗口；实测避免 220 条记录时因推理耗尽预算而误触发备用模型，内部推理仍永不进入最终消息。
- DeepSeek 官方接口接入可控 thinking 档位，控制台的“省额度 / 智能 / 深度”现在会真实映射到请求；日报默认使用省额度档，其他任务仍按各自配置运行。
- 日报 provider 调用改为通用主/备用插槽，日志和管理员预览会显示真正产出正文的模型，不再以函数名猜测供应商。
- 新增独立证据预处理模块：保留原始消息总量，同时从语义分析中排除机器人消息、管理员/功能命令、纯符号占位和 20 分钟内的标准化复读。
- 结构化摘要新增有效证据数、过滤原因、复读事件和带参与人数的讨论时段线索；活跃参与统计改用过滤后的有效发言。
- 日报提示词改为“经过、结果、状态”事实框架，强制区分已确认、待继续和闲聊无结论，不再强制凑名场面、活跃之星和氛围评价。
- QQ 号、长编号、IP/端口、链接和凭据会在进入模型前替换为占位符；没有文字证据的图片内容、群体共识和人物心理不得猜测。
- 模型输出统一移除 Markdown 标题、粗体和行内代码装饰；本地低数据/双模型失败摘要只呈现可核对事实，不补写结论。
- 内部过滤数量、复读处理和证据编号不再放进模型摘要线索，输出层还会兜底移除误写的处理说明；粗口与玩笑式“结案”只能中性转述，不能冒充现实结果。
- 旧版根目录 `api-providers.json` 运行配置加入 Git 忽略规则，继续由发布检查明确拦截，避免本机路由信息误入仓库。
- 历史日志回放：2026-08-05 的 220 条群消息被整理为 146 条有效证据，DeepSeek V4 Flash 在约 8 秒内直接完成正文，未调用 MiMo 备用，也未向群内发送测试消息。
- 验收：`npm ci` 通过，`npm run lint` 0 errors / 0 warnings，`npm test` 523/523 pass，`npm run release:check` pass，控制台构建 0 warnings / 0 errors，生产依赖审计 0 vulnerabilities。

## v1.3.4-reasoning-control - 2026-08-01 - 思考强度与结果隔离
- 修复控制台批量表情预览：过期的 QQ 临时图片地址会通过 NapCat `get_rkey` 在内存中续签，再由仅限本机的 `/admin/stickers/image` 安全转发；不保存图片文件，也不向前端暴露续签凭据。
- 表情目录区分“已分析”和“可发送”：群聊采集候选不再误算为可发送表情，控制台默认只展示真正可用的目录项，并可单独查看候选记录。
- 缩略图改为懒加载并提供统一失败占位；并发预览共享一次续签请求，单张失败会强制刷新一次凭据，不影响其他图片和 Bridge 主链路。
- 验收：`npm ci` 通过，`npm run lint` 0 errors / 0 warnings，`npm test` 518/518 pass，`npm run release:check` pass，控制台构建 0 warnings / 0 errors，生产依赖审计 0 vulnerabilities。
- API 中心新增“省额度 / 智能 / 深度”三档快捷控制，并允许群聊、私聊、文件、日报、关系短评、表情选择、识图、画像和搜索总结分别设置。
- “智能”档使用本地确定性规则判断短聊和复杂任务，不额外调用一次模型；MiMo Chat 最终映射为真实的 `thinking.type=disabled/enabled`。
- API 路由配置升级到 schema v2，旧配置自动补齐任务默认档位；保存后从下一次模型请求热生效，DeepSeek 群聊兜底仍受保护。
- DeepSeek 官方路由保持供应商默认行为，不注入未经确认的 MiMo 思考参数；Responses 协议使用标准 reasoning effort 映射。
- 前端原“思考模式”能力标记更名为“支持推理”，与实际运行档位分离；不支持可控档位的主力 API 会显示为跟随模型。
- 输出管线扩展拦截 `reasoning_content`、`reasoning`、`analysis` 和 `thinking`；只允许最终正文进入发送层，内部推理只记录长度且不会写入 QQ 消息。
- 新增配置迁移、自动档判断、协议映射、DeepSeek 不注入、替代推理字段隔离和前端控件测试。
- 新增强制 GitHub 发布门禁：每次更新必须经过验收、隐私扫描、显式暂存、提交、推送和远端 commit 核验；未推送不得标记完成。
- 公开源码移除真实 QQ 标识和本机绝对路径，运行值迁至已忽略的 `.env_*`；发布过滤新增 WebView2、构建目录、备份、API 路由运行态和 `*.tmp.<PID>` 防护。
- 词云“昨天”统一按 `Asia/Shanghai` 划分日期，避免 Linux/UTC CI 与本机时区不同导致跨日误判。
- 群聊命令收拢到单一 `action-dispatcher`：机器人提及只解析一次，JM、资源转发、链接预览、词云和注册表命令继续保持原权限与白名单行为。
- 回复引用和图片上下文改为按需解析；命令、重复消息和未触发插话的普通消息不再提前请求 NapCat 上下文。
- 群聊主模型与 DeepSeek 兜底由 `model-router` 统一编排；随机插话仍只允许 MiMo 与本地短句，不会新增 DeepSeek 消耗。
- 识图和文字回复共用唯一输出清洗器，模型私有推理字段仍只记录长度，不能进入最终发送文本。
- 短期线程与用户历史、群背景按消息 ID 去重，已完成回合不再重复注入提示词；其他旧背景仍按原预算保留。
- API 路由配置和密钥侧车增加文件戳缓存，前端保存时立即失效，外部改文件也会自动刷新；Key 仍不进入快照或日志。

## v1.3.3-meme-web-update - 2026-07-31 - 联网梗库与人工可控治理
- 梗库升级为 v3：旧版群聊碎片自动学习和中文词典同步不再参与运行；迁移前保留备份，候选区清空，旧自动词条进入隔离状态。
- 新增公开热点采集层，支持 DailyHot 兼容接口、微博/B 站/知乎公开端点和可选 RSSHub；单个来源故障只记录状态，不会改动正式梗库。
- 新增独立证据检索、词条相关性与门槛校验：默认至少 3 条实际提到候选词的证据、2 个不同域名，证据不足的热点不会进入模型审核，也不会写入词条。
- MiMo 只依据已取得的来源证据整理含义、用法与示例，并必须返回跨域证据序号；主模型请求或 JSON 解析失败时由 DeepSeek 兜底，模型凭空补出的候选或无引用结论会被丢弃。
- 联网词条保存来源平台、标题、链接、查证时间和到期状态；过期词条降为 stale，人工词条与内置基础词条不受自动过期影响。
- 群聊观察只为已知词条增加聚合使用次数，不再从群聊短句、复读或未知文本生成候选，不保存群聊原文和 QQ 号。
- 控制台“联网梗库”支持一键更新、查证当前词、编辑含义/用法/示例/来源/群范围、锁定人工字段、查看并恢复历史，以及回滚最近一次联网批次。
- 人工锁定字段在后续联网更新中保持不变；每次保存、删除、恢复和联网批次均保留可撤销快照，更新任务带进程锁、跨进程锁和失败隔离。
- 配置新增联网更新开关、周期、条数、来源地址、证据门槛与过期天数；真实 API Key、群聊文本和 QQ 标识不会进入管理快照或发布包。
- 验收：`npm run lint` 0 errors / 0 warnings；`npm test` 495/495 pass。

## v1.3.2-adaptation-cleanup - 2026-07-30 - 运行链路与适配清理
- watchdog 按运行目录检查 NapCat/QQ 进程树，OneBot 暂未就绪时不再重复启动；运行时选择优先完整官方注入目录。
- 控制台新增“停止全部”，按路径停止 Bridge、watchdog、NapCat 和对应 QQ 子进程，不影响其他 QQ 安装。
- `npm test` 改为独立临时数据区并注入固定假 key，不再读写生产聊天记录、梗库、表情目录、API 配置或日志。
- 每日群报按 `summaryGroupWhitelist` 逐群串行生成，每群独立防重复、独立输出文件，单群无消息或已发送不影响其他群。
- 回复诊断与真实群聊路由对齐，正确识别 JM、资源转发、链接预览、词云和注册表命令。
- 群表情采集移到重复消息和命令路由之后；被 @ 的图片只走主动识图，不再同时占用后台采集视觉调用。
- 表情采集与回复共用白名单回退规则；NapCat `sub_type` 和显式闪照标记进入统一图片结构。
- QQ 云收藏增加机器人所有权标记：复用既有个人收藏时只移除本地采集记录，不会删除用户原收藏。
- JM 运行状态识别内置 `7zip-bin`；发送者 QQ 文案改为“带随机盐的伪匿名摘要，仅用于去重”。
- 验收：`npm run lint` 0 errors / 0 warnings，`npm test` 482/482 pass。

## v1.3.1-group-sticker-capture - 2026-07-30 - NapCat 升级与群聊表情采集
- NapCat 以并行目录升级到 `v4.18.13`，Node 启动器、watchdog 和 Windows 控制台统一识别新版官方注入参数；旧 `NapCat.44498.Shell` 原样保留用于回滚。
- 修复“进程和端口存在即算上线”的假健康状态：只有 `get_login_info` 返回真实 `user_id` 才允许启动 Bridge。
- 实机通过 QQ 云收藏闭环：`add_custom_face` 添加、`fetch_custom_face_detail` 读取详情、`delete_custom_face` 删除均成功，测试项目与临时文件均已清理。
- 新增群聊表情候选队列，只有表情白名单群的普通图片会进入；闪照、自身消息、重复 URL、非公开地址和超限图片均会被挡住。
- 新增图片分类、64 位感知哈希近似去重和匿名发送者复用计数；发送者 QQ 只保存带随机盐的伪匿名摘要用于去重，不进入管理员快照。
- 采集默认 `observe`，可在控制台切换 `off / observe / auto`；自动模式支持每日上限、目录上限、可信度阈值和不同发送者人数阈值。
- 自动收录只写 QQ 云收藏，本地仅创建严格生命周期的上传临时文件，成功或失败后都会立即删除，异常残留会在下次启动时清理。
- 控制台“表情”页新增采集能力、队列、配额、来源筛选和采集项移除；个人 QQ 收藏没有删除入口，防止误删用户收藏。
- 新增运行时发现、官方注入、采集门禁、自动晋级、队列容量、隐私快照、临时清理和云能力测试。

## v1.3.0-sticker-replies - 2026-07-30 - QQ 收藏表情语境回复
- 新增 `bridge/features/stickers/` 独立模块，收藏同步、目录存储、图片分析、候选召回、发送策略与 NapCat 发送适配彼此分层。
- 通过 NapCat `fetch_custom_face` 同步 QQ 收藏表情；只保存 CDN 引用、不可逆感知哈希和简短语义标签，不把表情图片写入本地。
- 新增感知哈希去重、增量视觉标注和失败退避；相同图片复用已有描述，避免重复消耗视觉额度。
- 回复路径改为“文字成功发送后再尝试表情”，表情同步、选择或发送失败均被隔离，不影响现有群聊和私聊文字回复。
- 表情选择先按当前消息、夜星文字回复和最近上下文做本地语义召回，再由 `sticker_select` 小任务从最多 8 个候选中决定；MiMo 失败时保留 DeepSeek 兜底。
- 群聊使用独立白名单、普通/强语境概率和冷却；私聊可单独开关，随机插话概率自动降低，严肃、报错和系统场景默认跳过。
- Windows 控制台新增“表情”页，可同步收藏、分析待处理项、编辑含义和标签、停用单张表情、设置群范围并预演选择结果。
- 管理 API 新增 `/admin/stickers`；返回值遮蔽表情发送 key，发布脚本排除 `.qqfriend/stickers/` 运行目录。
- 验收：`npm ci` 通过，`npm run lint` 0 errors / 0 warnings，`npm test` 460/460 pass，`npm run release:check` pass，Bridge 与控制台正常启动。

## v1.2.9-api-quick-swap - 2026-07-28 - API 快拆与多协议路由
- 新增 `bridge/api-providers/` 统一模型网关，支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 和 Gemini 原生四种协议。
- 内置 MiMo、DeepSeek、OpenAI、Anthropic、Gemini、豆包、OpenRouter、通义、Kimi、智谱、硅基流动、Groq、Together、xAI、Azure、Ollama、LM Studio、vLLM 等 23 个无密钥预设。
- 群聊、随机插话、私聊、文件分析、群日报、关系短评、视觉、画像和搜索总结可分别配置主模型与兜底模型。
- 现有 MiMo 主模型和 DeepSeek 兜底是默认路由；DeepSeek 群聊兜底受到保护，不能被误删或留空。
- API Key 写入 `.env_api_<供应商ID>` 本机侧车文件；管理快照、前端、日志和发布包都不会返回或携带明文密钥。
- 新增配置原子保存、上一版快照和一键回滚；切换失败不会要求手工改代码恢复。
- 公网端点默认必须使用 HTTPS，重定向被拒绝；localhost 和本地模型需要显式勾选允许本地连接。
- Windows 控制台新增“API”页，可创建、编辑、测试、删除供应商并设置任务路由，附带未知接口判断指南。
- 新增与修改现在是两个硬隔离状态；新增时若实例 ID 重名会直接拒绝，不再静默覆盖已有模型。
- 聊天、识图、画像、日报和搜索总结均已接入统一路由；人格、关系分数、白名单和输出安全链路保持不变。

## v1.2.8-interjection-profile-hotfix - 2026-07-27 - 群插话画像纠偏
- 群聊中的“哈哈、笑死、草、梗、整活”只再影响群氛围和玩笑尺度，不再自动把整个群标记为高插话容忍度。
- 插话容忍度只响应明确的“可以多插话、多聊两句、别插话、别瞎回、少说两句”等意图表达。
- 明确设置的高/低容忍度保留 7 天，到期自动恢复正常；普通聊天不会延长该偏好的期限。
- 旧版没有明确意图来源的 `high` 值读取时统一按 `normal` 处理，避免历史误判继续放大插话概率。
- 本轮仅修复群插话画像推断；发送失败冷却、视觉失败硬拦截、短句分类和本地兜底策略保持不变，等待后续确认。

## v1.2.8-capability-center - 2026-07-26 - 能力中心与功能发现
- 新增 `bridge/capabilities/catalog.mjs`，统一描述聊天、识图、日报、词云、链接预览、JM、资源转发、关系、画像、回复风格、梗库、状态、更新与管理员能力。
- `@夜星 帮助` 改为六类能力入口；新增 `@夜星 帮助 1～6`、`@夜星 你能干嘛`、`@夜星 JM怎么用`、`@夜星 能识图吗` 等查询，私聊仍可省略 `@`。
- 能力回复会按当前群、私聊账号、资源白名单、功能白名单、模型配置和梗库运行模式显示可用、受限、不可用或预留状态。
- 普通用户帮助隐藏管理员能力；本地控制台和管理员可查看管理入口，`export-relationships` 继续明确标记为预留且不会生成文件。
- 新增保守的命令纠错：只对接近已知功能的短命令给出建议，不自动执行，也不拦截普通长句聊天。
- 管理 API 新增只读 `/admin/capabilities`；Windows 控制台新增“能力”页，支持搜索、分类筛选、状态筛选和用法示例。
- 原 JM、日报、关系、模型调用、白名单门控和群聊必须 `@夜星` 的行为保持不变。

## v1.2.7-meme-governance - 2026-07-26 - 梗库治理与低误命中迁移
- 梗库持久化升级为 v2：拆分正式词条、候选、隔离区、删除墓碑、群作用域、人工字段保护、聚合证据和词典同步状态。
- 取消连续汉字 2 到 4 字滑窗挖词；候选改为分词、重复短语和英文标识提取，并过滤命令、链接、占位消息、求助、报错与技术场景。
- 自动候选必须满足频次、不同用户、不同上下文门槛，再由 MiMo 进行语义审核、DeepSeek 兜底；模型不可用会延迟重试，不会误启用。
- 两字候选提高到 12 次、5 人、5 种上下文；自动词条保存来源群作用域，不会跨群或进入私聊。
- 删除任意来源词条会同步清候选并写墓碑；内置种子、聊天学习和中文梗词典均尊重墓碑，只有前端人工保存才能恢复。
- 旧版自动词条迁移时统一进入隔离区；旧用户 QQ 与原始上下文转换为不可逆哈希，迁移前保存 `.v1-backup.json`。
- 梗库写入改为临时文件原子替换并保留 last-good；主文件损坏时保存 corrupt 快照并自动恢复，避免静默清空后覆盖。
- 中文梗词典新增 ETag、Last-Modified、内容哈希和 24 小时到期同步；本地人工修改字段在后续同步中保持不变，短词模糊查询不再乱命中。
- 梗提示最多注入 2 条、500 字，优先级从 75 降到 55；`off`、`shadow`、`steady` 三种模式正式生效。
- 控制台新增真实候选总数、启用/隔离/停用、删除防复活数、来源范围、聚合证据、同步时间、模式切换与隔离恢复操作。
- 新增 `npm run meme:audit -- --strict` 历史回放；当前 3960 条普通群消息总体命中 0.78%，自动两字词命中 0%。
- 发布排除扩展到梗库主文件、last-good、迁移备份、corrupt 快照和图片语境数据，不携带运行时聊天学习内容。

## v1.2.6-context-aware - 2026-07-24 - 短句、图片与表情包语境融合
- 猫娘表现改为场景化概率触发：普通聊天偶尔加入一次“喵”、耳朵或尾巴动作；被逗弄或挑衅时有概率短促哈气，严肃求助场景自动禁用哈气。
- 提示词拆分为身份、正常聊天、随机插话和图片语境模块；夜星人设改为轻度风格，明确“先回答内容，再表现人设”。
- 随机插话必须抓住事实、情绪、疑问、笑点、图片动作或话题延续中的具体回应点；接不上、指代不明或只能泛泛附和时输出空回复。
- 随机插话新增当前群受限前情：文字最多取 4 条，图片最多取 6 条；自动排除当前消息、机器人回复、管理员/功能命令、无意义图片占位和重复文本。
- 被回复消息正式进入随机短句和图片上下文，表情包会结合前文判断赞同、反驳、震惊、调侃、自嘲、安慰或接梗含义。
- MiMo Vision 改为只提取主体、可见文字、表情动作、可能梗和不确定项，不再单独决定回复；图片 OCR 和聊天背景均标记为不可信资料，不能覆盖系统规则。
- 图片描述在 MiMo 与 DeepSeek 间复用：MiMo 聊天失败时 DeepSeek 可根据客观视觉摘要和当前群前情兜底；视觉失败则明确禁止编造画面。
- 新增 64 位图片感知指纹缓存，相同或近似表情包可复用客观描述；只保存指纹、短描述、时间和命中次数，不保存图片文件或群聊原文，敏感 OCR 不入库。
- 随机插话保持 `thinking=disabled`、禁用工具，输出额度由 384 降为 192；完整 `reasoning_content` 继续只记录长度、不允许外发。
- 本地万能短句不再用于图片和具体问句，避免视觉失败或问题场景下答非所问；日志新增 MiMo、DeepSeek、本地保底路由标识。
- 控制台配置总览新增“图片语境”状态，仅显示启用状态、缓存数量、复用次数和“不存图片”边界。
- 发布脚本新增运行数据排除规则，`.qqfriend/memes.json` 与 `.qqfriend/image-memes.json` 不会进入发布包。
- 验收：`npm run lint` 0 errors / 0 warnings，`npm test` 422/422 pass，`npm run release:check` pass。

## v1.2.5-cognition-core - 2026-07-16 - 短期认知线程与上下文治理
- 新增 `bridge/cognition/`：直接对话按“用户 + 群”保存最多 8 个已完成回合，90 分钟自动过期；“还是不行”“继续”“刚才那个”等承接句会恢复上一轮话题和处理结果。
- 私聊短期线程只保存在进程内存，最多保留 6 小时，不写入 `user_memory.json`；`忘记我` 会同步清理群聊认知线程和私聊临时线程。
- 机器人回复只有在 NapCat 明确确认发送成功后才进入聊天历史和认知线程；发送失败、空回复和随机插话不会形成错误的“已完成回合”。
- 上下文加入优先级与硬预算：引用消息、被提及用户、主动回复偏好、短期线程和长期摘要优先；旧历史和群背景在超限时自动裁剪，私聊与随机插话使用更小预算。
- 历史检索按消息 ID 和时间窗口排除当前输入，避免同一条消息重复进入模型上下文；相关记忆默认只检索当前群，不跨群拼接原始聊天。
- MiMo 主提示词新增承接语义约束，明确当前输入优先、记忆仅作辅助；DeepSeek fallback 保持启用。
- 管理状态新增 cognition 运行指标，可查看有效群聊线程、私聊临时线程和已完成回合数量，不暴露聊天正文。
- 日报发送接入统一结果判定，发送失败不会写入 `.sent` 标记，后续可以安全重试。
- 控制台首页由固定窄版扩展为宽屏密集布局，面板按内容高度排列，不再让短诊断面板被左侧配置列表拉出大块空白。
- 首页新增短期上下文状态卡，显示有效群聊/私聊线程、群聊已完成回合和私聊是否落盘，不展示聊天原文。
- Web 操作新增按钮处理中状态、顶部任务进度、成功/失败反馈、状态卡更新动画、15 秒自动刷新和请求超时提示；顶部原生“刷新控制台”现在也会同步刷新 Web 首页。
- 快速诊断优先显示“能否回复、@是否识别、识别命令和处理方式”，详细 JSON 仅作为后续信息保留。
- 控制台重组为“总览、配置、梗库、诊断、维护”五个工作区，移除重复原生运行顶栏；十四个原生工程页收进常用入口和“更多工具”。
- 配置页新增白名单与机器人名称表单，原始 JSON 降为高级入口；保存前确认、未保存状态和重启提示均可见。
- 自动刷新现在只读取运行状态，不再每 15 秒重复拉取配置和日志；完整刷新改为并发请求，原生高级页改为首次打开时按需加载。
- 梗库新增未保存提示、切换保护、删除确认和清空候选确认；诊断错误回到诊断区，完整 JSON 默认折叠。
- 前端宿主通信拆为独立 `host-client.js`，新增请求响应、错误回传、主动快照、超时和工作区结构测试；完整套件为 409/409 pass。
- 控制台升级为 Fluent 单层工作台：主页取消原生与 Web 双层导航，改用固定左侧导航和紧凑顶部状态栏；原生导航只在进入高级工程页时出现。
- 日常入口扩展为“总览、服务、配置、梗库、诊断、日志、维护与外观”，运行控制和维护操作不再混在首页大标题区域。
- 白名单和机器人名称改为可增删标签，保存栏固定显示未保存状态；“保存并重启”会在写入非密钥配置后自动重启 Bridge。
- 日志增加级别、模块、关键字和跟随最新筛选；诊断支持群聊与私聊场景，并把结果渲染为人类可读检查项。
- 外观新增跟随系统/浅色/深色、舒适/紧凑密度和模糊强度；Mica 风格用于长期底层，Acrylic 风格只保留给浮层和临时反馈。
- 启动器新增 NapCat 与 Bridge 进程级防重复：API 尚未就绪但进程已经存在时只等待现有实例，不再重复拉起 QQ 或触发 `EADDRINUSE`。
- Bridge 启动前会检查已有入口进程和管理端口；端口被其他进程占用、进程存在但 `/health` 不通时返回明确原因，不再把失败误报成启动完成。
- 本地 NapCat、Bridge 和 Admin API 检查绕过系统代理，并在日志中保留 HTTP 状态、超时或连接异常类型，方便区分登录未完成与服务故障。
- “停止 Bridge”新增二次确认；主动停止、外部恢复和意外断线使用独立状态，侧栏、服务页、指标和操作结果不再互相矛盾。
- Node 入口查找与停止只匹配 `node.exe`，避免控制脚本误识别自身；watchdog 也使用全部 PID 去重。

### v1.2.4-meme-knowledge - 2026-07-05 - 自动梗库与上下文理解
- 新增 `bridge/knowledge/memes/` 梗库模块：内置基础梗种子，并从群聊高频表达中自动学习候选词，达到出现次数、多人使用、上下文稳定度阈值后自动启用，不需要逐条人工审核。
- 梗库默认用于“理解当前发言”，不会要求模型主动复读梗；只有用户明显在玩梗时才允许轻量接住，求助、报错和正事仍优先直接回答问题。
- 新增 `梗库`、`梗库 搜 关键词` 查询入口；管理员可用 `梗库 禁用 关键词` / `梗库 启用 关键词` 一句话反悔。
- 新增 `/admin/memes` 本地管理接口和 WebView 首页“梗库批改”面板，可在前端新增/修改词条、别名、触发词、含义、用法、置信度、等级以及启用状态。
- 前端梗库面板新增“连接中文梗词典”，接入 `WenKanghwdd/china-meme-dictionary` 的 `data/memes.json`，首轮自动筛选：强梗进正式词条，泛社会概念进候选区，普通日常词跳过。
- 前端梗库面板新增“查词库用法”：选中已有词条或候选词后，可从中文梗词典查询含义、用法、拼音别名和触发词建议，只回填表单，不自动保存。
- 新增群聊复读去重闸门：同群第三次重复文本、同一用户短时间连续重复会跳过入库、画像更新、梗库学习和随机插话，避免复读机污染关系、日报和梗库数据；@ 命令、图片和文件不拦。
- 每日群报新增运行锁和已发送标记，同一天同一群被计划任务、手动脚本或外部进程重复触发时只发送一次，后续触发会记录跳过原因。
- 新增 `QQBOT_MEME_MODE` 配置说明，默认 `steady`；梗库运行时数据保存在 `.qqfriend/memes.json`，只保存紧凑词条和短上下文。
- 模块清单、帮助菜单、上下文组装和群聊观察链路已接入；新增 `test/meme-knowledge.test.mjs`、`test/admin-memes.test.mjs`、`test/duplicate-message.test.mjs` 与 `test/group-summary-guard.test.mjs`，全量测试更新为 `390/390 pass`。

### v1.2.4-admin-help-cleanup - 2026-07-05 - 管理员命令文案去代码化
- 管理员帮助去掉 `<qq>`、`csv|json|md` 等代码感占位符，改成“QQ号”“暂未启用”等中文说明。
- `runtime` 回复改成中文状态面板，不再外发 `status: ok / uptime:` 这类日志式键值。
- `memory status` 与 `memory summary` 改成面向用户的自然语言摘要，不再把 `preferredTone=...; confidence=...` 这类内部画像字段发到群里。
- 内部上下文继续保留机器可读画像摘要，避免影响模型上下文和个性化逻辑。

### v1.2.4-feature-wordcloud - 2026-07-05 - 功能模块入口与群词云
- 新增 `bridge/features/` 功能入口，群聊命令链路可按模块接入新能力，当前先接入词云。
- 新增 `@夜星 词云`、`@夜星 今日词云`、`@夜星 昨日词云`、`@夜星 词云 7天` / `wordcloud 7d`，只输出聚合热词和词云图，不展示聊天原文。
- 新增 `QQBOT_FEATURE_GROUPS` / `.env_feature_groups` 功能白名单，默认跟随群白名单；控制台状态、模块清单和帮助菜单同步显示。
- 词云图片渲染失败时会自动降级为文字热词列表，避免依赖缺失导致命令无回复。

### v1.2.4-launcher-glass-background - 2026-07-04 - 真实背景毛玻璃与启动器顶部美化
- 主页背景支持三种模式：内置背景、当前 Windows 桌面壁纸、自选本地图片。
- 背景设置保存到启动器目录 `launcher-background.json`；未选择时保持内置背景，不影响 bot 配置和 `.env`。
- Web 毛玻璃层改为透出当前背景图/壁纸，卡片、按钮、输入框、配置项和标签统一半透明与模糊效果。
- 启动器顶部 WinForms 工具栏改为扁平化按钮，启动/重启/停止使用不同状态色；页签改为自绘胶囊样式。
- 桌面 `QQFriend一键启动.exe` 已重新发布；`dotnet build -c Release` 0 warning / 0 error，`npm run lint` 通过。

### v1.2.4-launcher-web-home - 2026-07-04 - 傻瓜式 WebView2 主页与玻璃拟态控制台
- Windows 控制台新增 WebView2「主页」作为第一屏，保留原有总览、日志、命令、模块、配置、诊断、备份、审计等高级页签。
- 主页提供启动全部、健康检查、重启 Bridge、停止 Bridge、创建备份、打开日志、快速诊断和状态刷新。
- 主页卡片化展示 Bridge 状态、群/用户记忆数量、内存、运行时长、消息风暴保护、白名单、管理员、模块和模型 Key 配置状态。
- 新增 `launcher/QQFriendLauncher/Web/` 前端资源，发布时自动复制到桌面控制台目录；界面使用半透明玻璃、高斯模糊和响应式布局。
- `BridgeAdminClient` 新增原始 JSON 状态/日志读取方法，供 Web 主页结构化渲染，不暴露密钥。
- WebView2 包仅保留 WinForms/Core 引用，移除未使用 WPF 引用，`.NET` 发布构建保持 0 warning / 0 error。
- 验收：`npm run lint` 0 errors，`npm test` 350/350 pass，`npm run release:check` pass，`dotnet build -c Release` 0 warning / 0 error，桌面 `QQFriend一键启动.exe` 已更新。


### v1.2.4-config-console-hotfix - 2026-07-04 - 配置页不可用与 EPIPE 假死修复
- 修复 Bridge stdout/stderr 管道断开后的 `EPIPE` 风暴：日志模块改为安全写控制台，父进程关闭输出管道时继续写文件日志，不再递归触发 uncaughtException。
- HTTP server 监听失败时明确记录 `HTTP server error`，遇到 `EADDRINUSE` 直接退出，避免 watchdog 留下半启动进程。
- `/admin/config` 的 `files` 字段新增 `source`、`status`、`writable` 和 `fileStatusLegend`，明确 `exists=false` 是“保存时创建边车文件”，不是配置不可用。
- 新增 `test/logger-epipe.test.mjs`，覆盖 stdout/stderr EPIPE 时 logger 不抛异常。
- 现场处理：停止占用 16789 的卡死 Bridge，重新拉起健康 Bridge，`/health` 与 `/admin/config` 已恢复。

### v1.2.4-launcher-phase9 - 2026-07-04 - 管理中心骨架收束
- 新增管理操作审计：`/admin/audit` 读取 `logs/admin-audit.log`，自动记录本地 Admin API 路由访问，只保存 method、path、query key 和 remote，不保存请求体、key 或聊天原文。
- 新增插件中心骨架：`/admin/plugins` 从模块 manifest 生成只读插件清单，展示 category、risk、commands、diagnostics 和 privacy；启停/安装/卸载保持禁用。
- 新增命令生成 API：`/admin/command-scaffold` 支持 dry-run 预览和 `write=true` 生成命令模块/测试模板，但不自动修改 manifest、dispatcher、模型调用、storage 或 auth。
- 新增安全备份：`/admin/backups` 支持创建非隐私快照、列出备份、生成恢复预案；默认排除 `.env_*`、日志、聊天记忆、个人文档和临时文件，恢复只输出手动预案，不自动覆盖文件。
- Windows 控制台新增 `插件`、`命令生成`、`备份`、`审计` Tab，形成“总览-日志-命令-模块-工作流-插件-生成-备份-审计-诊断-自描述”的管理中心骨架。

### v1.2.4-launcher-phase8 - 2026-07-04 - 工作流中心与自描述中文修复
- 新增 `/admin/workflows`：独立输出启动、发布前检查、回复诊断、配置编辑、命令新增和自描述刷新流程。
- Windows 控制台新增 `工作流` Tab，展示每个流程的 surface、步骤和验收点，方便后续做任务中心或插件向导。
- `bridge/self-description.mjs` 的工作流与诊断文案改为干净中文，并增加 `count` 字段，生成的 `.qqfriend/workflows.json` 与 `diagnostics.json` 更适合交接读取。
- 新增 `test/admin-workflows.test.mjs`，覆盖工作流目录和 `/admin/workflows` 路由。
- 仍然只做展示和交接，不在 Admin API 中远程执行 npm、启动命令或写密钥文件。

### v1.2.4-launcher-phase7 - 2026-07-03 - 项目自描述与 Agent 交接文件
- 新增 `bridge/self-description.mjs`：汇总架构、模块、命令、工作流和诊断入口，生成给 Codex/OpenClaw/控制台读取的项目自描述。
- 新增 `npm run self:describe`，会写出 `.qqfriend/architecture.json`、`modules.json`、`commands.json`、`workflows.json`、`diagnostics.json` 和 `index.json`。
- 新增 `/admin/self-description`，本地管理 API 可直接返回项目能力地图，方便后续前端、脚手架和交接审计复用。
- Windows 控制台新增 `自描述` Tab，可查看当前 Bridge 暴露的项目交接 JSON。
- 发布规则纳入 `.qqfriend` 目录，但仍不包含 `.env_*`、密钥、日志、个人文档或聊天记忆原文。

### v1.2.4-launcher-phase6 - 2026-07-03 - 模块 Manifest 与插件页雏形
- 新增 `bridge/modules/manifest.mjs`：为命令、JM、每日群报、关系、记忆、资源转发和输出安全建立统一模块清单。
- 新增 `/admin/modules`：输出模块入口、命令、可编辑配置、健康检查、诊断入口、测试文件、风险等级和隐私边界。
- Windows 控制台新增 `模块` Tab，可查看现有能力模块地图，为后续插件中心和模块迁移打底。
- 模块清单只展示配置摘要，不展示 JM 解压密码、7z 真实路径或模型密钥值。

### v1.2.4-launcher-phase5 - 2026-07-03 - 回复诊断中心
- 新增 `/admin/diagnose/reply`：对群聊/私聊事件做 dry-run 诊断，输出解析结果、白名单/黑名单 gate、@ 状态、命令识别、随机插话判定和预计回复动作。
- 诊断接口不会发送消息、不会写 storage、不会调用 MiMo/DeepSeek，只用于排查“为什么不回”“为什么触发命令”“是否没识别 @”。
- Windows 控制台新增 `诊断` Tab：可粘贴简化事件或 OneBot 风格 JSON，运行后查看结构化诊断结果。
- 诊断模块复用现有 `parseIncomingEvent`、命令规范化、白名单配置和插话策略，避免维护第二套判断逻辑。

### v1.2.4-launcher-phase4 - 2026-07-03 - 控制台配置中心
- 新增 `/admin/config`：本地控制台可读取和保存非密钥配置，包括 bot 名称、群白名单、日报群、资源/JM 群、长回复群、私聊白名单、黑名单和管理员 QQ。
- 配置保存只写 `.env_bot_names`、`.env_groups`、`.env_summary_groups`、`.env_resource_groups`、`.env_long_groups`、`.env_friends`、`.env_bot_blacklist`、`.env_admins`，不会写入模型密钥。
- `bridge/config.mjs` 支持读取上述旁路配置文件；文件不存在时继续使用当前默认值，避免破坏已有部署。
- Windows 控制台新增 `配置` Tab，可查看和编辑 `/admin/config` JSON；保存后提示需要重启 Bridge 才会生效。
- `.env.example` 补充控制台可编辑配置示例；发布规则仍排除 `.env_*`，不把真实配置打进包。

### v1.2.4-launcher-phase3 - 2026-07-03 - 控制台总览、日志与命令页
- Windows 启动器升级为只读控制台：新增 `总览`、`日志`、`命令`、`启动输出` Tab，保留一键启动、健康检查、重启 Bridge、停止全部和打开日志。
- `总览` 页接入 `/admin/status`，展示 Bridge 版本、进程、存储、白名单、管理员、模块和模型凭据配置状态，只显示是否配置，不展示真实值。
- `日志` 页接入 `/admin/logs`，支持关键词过滤和打开日志目录；后端仍限制读取 `logs/*.log` 并做敏感凭据脱敏。
- `命令` 页接入 `/admin/commands`，从命令 manifest 读取别名、权限、帮助行、reserved 状态和 pattern 状态。
- 启动器模块边界保持：`BridgeAdminClient` 负责只读 API，`LauncherRuntimeService` 负责启停流程，`LauncherForm` 负责界面刷新。

## v1.2.4-command-profile - 2026-06-26 - 命令个性化、隐私清理、命令模块化与历代更新查询
- 新增 `我的档案`：展示用户主动称呼、回复偏好、常聊主题、群内互动摘要和画像置信度；只展示摘要，不贴聊天原文。
- 新增 `设置称呼 <名字>`：保存用户主动设置的称呼，优先用于后续个性化回复。
- 新增 `回复风格` 系列：支持长度、语气、幽默、表达、例子、表情和正式度组合设置，例如 `@夜星 回复风格 简短 技术 少吐槽 给步骤`。
- 新增 `回复风格 帮助 / 推荐 / 预览 / 重置`，推荐只基于摘要和主题，不展示历史原文。
- 新增 `隐私` 与 `忘记我`：说明隐私边界，并允许用户清理画像、偏好、关系缓存和个人聊天记忆。
- 用户主动设置会进入分层上下文，但只影响表达方式，不允许绕过安全规则；群聊仍不会公开他人的私聊内容。
- 新增历代更新查询：`更新列表`、`更新 v1.2.3`、`更新 最近3版`、`更新 jm`、`更新 隐私`。
- 帮助菜单同步加入个性化、隐私和历代更新入口。
- 命令系统模块化：新增 `bridge/commands/`，拆出命令标准化、权限判断、命令 registry、runtime、普通命令、管理员命令和关系命令处理器。
- 命令清单声明式：新增 `bridge/commands/manifest.mjs`，统一维护命令别名、权限、帮助行和预留状态，帮助菜单与 registry 开始共用同一份元数据。
- `bridge/admin-commands.mjs` 保留为兼容门面，旧模块 import 不需要同步大改，降低接入风险。
- 回复主链路模块化：`reply.mjs` 收缩为薄事件路由，群聊处理拆到 `bridge/reply-group.mjs`，私聊处理拆到 `bridge/reply-private.mjs`，AI 回复与画像节流拆到 `bridge/reply-ai.mjs`。
- 上下文旧门面瘦身：`context.mjs` 改为兼容转导，消息格式化拆到 `bridge/context/messages.mjs`，历史读取拆到 `bridge/context/history.mjs`，更新日志读取拆到 `bridge/context/changelog.mjs`。
- 模型调用门面预留：新增 `bridge/model-router.mjs`，回复主链路改为通过 `callPrimaryChat` / `callFallbackChat` 调用 MiMo 与 DeepSeek，为后续任务分级、省额度和 DS 兜底统一调度预留入口。
- 模型任务分级接入：`model-router` 新增 `GROUP_SUMMARY` 与 `RELATIONSHIP_COMMENT` 任务策略，日报和关系短评默认模型调用改走统一 raw/text provider，保留 MiMo 主调与 DeepSeek 兜底。
- 命令脚手架预留：新增 `npm run command:scaffold -- <id>`，可 dry-run 或 `--write` 生成命令模块草稿、测试骨架和 manifest 片段，方便 Codex/OpenClaw 后续加命令时不漏测试与帮助入口。
- 上下文入口整理：新增 `bridge/context/` 与 `buildReplyContextPacket()`，统一输出 `mode/messages/currentInput/mood/memory/metadata/budget`。
- `reply.mjs` 已切到新的上下文 packet 入口，当前仍保留旧 `context-retriever.mjs` 兼容层，模型调用逻辑不变。
- 新增命令模块、命令 manifest、回复模块边界、上下文模块边界、模型 router 边界、命令脚手架与上下文 packet 回归测试，测试数量更新为 `319/319 pass`。
- JM 运行时修复：不再默认依赖 Windows Temp 里的 `jmcomic-crawler-python-audit` 源码，残缺 `QQBOT_JMCOMIC_SRC` 不会挡住 pip 版 `jmcomic`。
- JM 自检：新增 `npm run check:jm` / `check:jm:install`，检查 `jmcomic` 导入、FS 解压密码和 7-Zip 可用性，`release:check` 已纳入。
- JM 错误细分：新增 `missing_jmcomic_source`、`missing_python_dependency`、`jmcomic_import_failed`，群内提示更明确，日志保留安全摘要。
- JM 镜像域名兜底：新增 `QQBOT_JM_DOMAINS`，未配置时继续使用 `jmcomic` 内置 API 域名池和自动更新逻辑。
- 验收：`npm run lint` 0 errors / 0 warnings，`npm test` 319/319 pass，`npm run release:check` pass。

## v1.2.3-context-memory - 2026-06-23 - 分层上下文、关系印象卡与 JM 转发热修
- 新增 `bridge/memory-profile.mjs`：用户画像、群画像、用户群内画像支持过期时间、置信度和敏感内容过滤。
- 新增 `bridge/context-retriever.mjs`：主动回复使用当前输入、被回复消息、相关记忆、群聊背景和画像摘要的分层上下文。
- 相关记忆检索优先取和当前消息相关的历史，减少盲塞最近聊天导致的误解。
- 自动插话继续保持轻量，只参考当前输入、图片理解和群插话容忍度，不加载用户长历史，不走 DeepSeek 长回复兜底。
- 管理员新增 `memory status`、`memory summary <qq>`、`memory clear user <qq>`、`memory clear group`。
- 主动 `@夜星` 回复继续保留 MiMo 主回复与 DeepSeek 兜底。
- 继续禁止 reasoning_content、思维链、分析过程和敏感凭据外发。
- 每日群报修复：`daily_summary.mjs` 与手动 `summary:date` 统一走 MiMo `max_completion_tokens`、输出清洗、DeepSeek 兜底和 `sendMsg` 分段发送，并补回 `QQFriendDailySummary` 计划任务。
- 每日群报默认日期修正：北京时间 00:00-05:59 执行时默认总结昨天，避免刚过零点误发当天凌晨小报。
- 帮助菜单优化：普通帮助拆成 `帮助1/help1` 常用短菜单与 `帮助2/help2` 进阶说明，默认 `help/帮助` 显示第一页。
- 好感度升级：默认关系卡加入全局/本群熟悉度、最近热度、常聊主题、回复偏好、群内互动风格和关系标签，并缓存 MiMo/DeepSeek 夜星短评。
- JM 转发热修：`@夜星 jm <代码>` 下载后打包为带密码 zip，默认解压密码 `FS`，使用内置 `7zip-bin`/7za，避免本机未安装 7-Zip 时失败。
- JM 依赖自愈：下载脚本缺少 `curl_cffi`、`commonX`、`PyYAML`、`pycryptodome` 等 Python 依赖时自动安装并重试一次；可用 `QQBOT_JM_AUTO_INSTALL=0` 关闭。
- JM 临时文件策略保持上传后约 1 天清理，避免 NapCat 尚未读完文件就被删除。
- 验收：`npm ci` 通过，`npm run lint` 0 errors / 0 warnings，`npm test` 265/265 pass，`npm run release:check` pass。

## v1.2.2-interjection - 2026-06-22 - 自动回复与 MiMo thinking 热修
- MiMo 聊天接口保留 `mimo-v2.5`，请求体改用 `max_completion_tokens`。
- 随机插话模式显式传 `thinking: { type: "disabled" }`，减少 `reasoning_content_only` 导致的沉默。
- 随机插话预算 `256 -> 384`，回复上限 `80 -> 160` 字。
- 自动回复概率提高：普通 6%、图片 25%、情绪 38%、玩笑 32%、问句 30%、提到夜星但未 @ 60%、冲突类 18%。
- 冷却放宽：群冷却 60 秒，用户冷却 120 秒，群内间隔 3 条消息。
- 帮助与版本命令同步说明自动回复策略，并继续声明不会外发 reasoning_content、思维链和敏感凭据。

## v1.2.1-relationship — 2026-06-19 — 关系系统正式启用
- 🔒 output hotfix：最终回复只使用 `content`，`reasoning_content` 永不外发，仅记录长度
- 🧼 输出清洗：新增 `sanitizeAssistantReply` / `isUnsafeReasoningText`，拦截显式思考、分析、推理前缀
- ✂️ 长文本分段：群聊/私聊超过 900 字自动拆分，图片消息长文字也拆段发送
- 📦 发布包清理：新增 `npm run package:release`，白名单打包并排除 `.env_admins`、真实 key、docx、日志和记忆库
- 🩺 运维保活：新增 `npm run watchdog`，定时检查 NapCat OneBot 与 bridge，掉线后自动拉起
- 🩹 随机插话热修：模型输出被安全过滤时，改用本地安全短句兜底，避免自动回复触发后完全无声
- 🪪 上下文身份边界加固：当前输入、被回复消息、群聊背景分块，明确 speaker/uid，要求直接回复当前发言人
- 🌊 随机插话改为独立短回复通道：非 @ 不带工具、不拉长历史、不 fallback 长回复，异常或疑似分析直接静默
- 🧠 思维泄漏过滤增强：覆盖“从之前对话看 / 这个语境 / 在群里 / 搜索结果分析”等分析式回复
- 🧭 工作流：新增省额度分层模型派单方案，明确 A/B/C 档任务边界与高配模型审查规则
- 🧮 关系计算正式启用：computeRelationship 从聊天记录计算 familiarity/affinity/trustScore
- 📊 关系等级：0-19刚认识 / 20-39有点眼熟 / 40-59常见群友 / 60-79熟人 / 80-100老熟人
- 💬 @夜星 好感度：从 reserved 占位改为返回真实关系摘要
- 📝 @夜星 更新 / 更新日志 / changelog：返回当前版本、更新点、仍预留功能与验收状态
- 🔒 安全：明确好感度=互动熟悉度、不泄露聊天原文、不跨群暴露
- 📈 测试 116→174：新增计算逻辑、命令接入测试、更新日志命令测试、随机插话分流、身份边界、安全兜底、长文本分段与泄漏回归测试
- 🚫 export-relationships 保持 reserved

## v1.2.0-reserved — 2026-06-19 — 关系特征预留
- 🧩 **v1.2.0 关系扩展预留**：新增关系 schema、导出占位、命令占位、上下文和 style-router 预留位置，默认不启用真实导出/查询。
- 🚧 **命令仅 reserved**：`/好感度`、`/关系`、`/export-relationships` 当前不会主动接入聊天主流程，下一轮才正式启用。
- 🩹 **hotfix-cleanup**：抽出 `bridge/clients/auth.mjs`，`daily_summary.mjs` 不再把脱敏前缀拼进真实 Authorization。
- 🧭 **lint 覆盖扩大**：`npm run lint` 覆盖 `bridge/`、`test/`、`scripts/` 和根目录 `.mjs`，并补齐 Node globals。
- 🧪 **CI runtime 模式**：新增 `check:runtime:ci` / `--allow-missing-env`，干净发布包不需要携带真实 `.env`。
- 🩺 **新增 runtime-check**：检查 `.env_mimo` / `.env_ds`、Bearer 请求头格式、脱敏误用、代理变量和 `/health`，不请求真实模型 API。
- 🧹 **lint warning 9→0**：拆分 `safeFetch`、`getFiles`、`fetchPageMeta`、`fetchBilibiliInfo`、`handleMiniApp`、`handleToolCalls`、`tryMiMo`、`handleGroupMessage`、HTTP 路由处理。
- 🧪 **测试 86→108**：补充 safeFetch SSRF/大小限制、网页 meta、B 站解析 fallback、MiMo malformed tool_call、关系预留命令/导出等 mock 测试，108/108 pass。
- 📚 **运维文档补齐**：新增 README，更新 HEARTBEAT / TOOLS，写明启动、测试、health、401、代理、打包与 zip 目录结构检查。
- 🔒 **认证边界保持**：真实请求继续使用 `Bearer ${apiKey}`，脱敏仅用于日志，不进入真实 Authorization。

## v1.1.1 — 2026-06-18 21:30 — 🧹 清 warning + 拆函数 + 补测试
- 🧹 **lint warning 37→9**：移除 20+ 未用 import，prefer-const 修复
- 🔧 **拆分 fetchFileContent**：validateFileUrl / detectFileType / fetchWithTimeout / trimFileContent
- 🔧 **拆分 tryMiMo**：resolveVisionContext / callMiMoApi / parseMiMoResponse / handleToolCalls
- 🧪 **测试 33→69**（全部 mock，69/69 pass）
- 📦 **标准化打包**：tar -a -cf 保留目录结构
- 🗑️ **移除 docx 依赖**：-22 packages

## v1.1.0 — 2026-06-18 11:00 — 🔍 四段安全审查 + 全线修复
- 🧹 **模块化重构补完**：修复 7 处缺失 import（model-ds/profiel/reply 多个模块拆分后引用断链）
- 🌊 **日志风暴保护修复**：冷却结束后自动重置，不再是"一次性"保护
- 🛡️ **SSRF 防护**：fetchFileContent 拒绝内网地址（127/10/192.168/172.x），防止文件消息打内网
- 📏 **OOM 防护**：图片下载限制 10MB、HTML 抓取限制 2MB、HTTP 请求体限制 1MB
- 🔒 **CORS 收紧**：从 `*` 全开改为仅允许 localhost，恶意网页无法操控机器人
- 💾 **存档异常可见**：flush 失败不再静默吞错，改为输出日志
- 🔗 **循环依赖打破**：getLatestChangelog 从 startup.mjs 迁至 context.mjs
- 🐛 **profile 画像修复**：补全 miMoContent import，画像生成不再静默降级
- 🔤 **URL 编码防御**：fetchReplyData 参数 encodeURIComponent
- 🗑️ **清理死代码**：移除 .history 遗留字段、删除 crossGroupCtx 未使用导出
- ⚡ **统一 API Key 前缀**：所有 MiMo/DS 调用统一用 `***` 前缀
- 📝 **搜索触发词收紧**：移除"最新""当前""现在怎么样"等日常高频误触发词
- 🖼️ **Vision 思维链过滤**：MiMo 图片理解增加 cleanThinking 检查，防止思维链泄露到群聊
- 🔧 **var→const** + generateProfile 错误日志
- 🏗️ **路径兼容**：config + daily_summary 改用 fileURLToPath 替代硬编码 C: 盘符

## v17 — 2026-06-15 23:40 — 🛡️ Anti-Storm
- 🛡️ **Anti-Storm 防护模块**：防止日志暴增/磁盘写死/事件循环堵塞
- 📝 **异步缓冲日志流**：用 WriteStream 替代 appendFileSync，批量刷盘，不堵事件循环
- 📏 **日志大小上限**：单日日志超过 50MB 自动截断，只记告警摘要
- 🌊 **日志风暴检测**：每秒超过 200 条日志自动冷却 60 秒
- ⏱ **存档防抖**：saveUsers/saveGroupChats 改为 30 秒异步批量写入，不再每条消息都写 ~2MB 文件
- 🚦 **事件限流**：每秒最多处理 20 个事件，超出丢弃并摘要
- 🔥 **重连冷却**：WebSocket 断开后 5 秒内拒绝新连接，防止重连死循环
- 💾 **退出前强制存档**：SIGINT/SIGTERM 时 flush 脏数据
- 🔧 致命异常 1 分钟内超过 10 个自动抑制详情，防止刷屏

## v16 — 2026-06-13 22:17
- 🐛 **修复 MiMo tool_call 泄露**：cleanThinking 新增 `<tool_call>` XML 过滤，防止模型把工具调用文本直接发到群聊
- ⏱ **sendMsg/sendPrivateMsg 加超时**：15s AbortSignal，防止 NapCat 卡住时永久挂起
- 🔍 **新增 Bing CN 搜索兜底**：Tavily 失败或未配置时自动走 cn.bing.com HTML 抓取（免费免 Key，国内可用）
- 🔍 **Tavily 超时降至 12s**：失败自动 fallback 到 Bing
- 📈 **随机插话 token 提升**：150→300，减少模型截断导致 tool_call 泄露

## v15 — 2026-06-12 00:34
- 🟣 **主力模型切换到 MiMo**：聊天从 Minimax M3 换成 Xiaomi MiMo V2 Flash
- 🔑 API Key 统一：移除 `.env_mm` / `.env_mm_vision`，改用 `.env_mimo`
- 👁️ 视觉模型也切 MiMo V2.5（兜底仍为豆包）
- 📝 画像生成改用 MiMo
- 🗑️ 移除所有 Minimax 依赖
- ⚡ 按量付费 ¥1-3/月，替代原来 ¥49/月订阅

## v14 — 2026-06-08
- 🔍 增加 Tavily 联网搜索（cn.bing.com HTML 抓取）
- 🧠 Minimax M3 工具调用支持（最多 3 轮 web_search）
- 📊 5 档加权上下文 + 跨群对话记忆
- 🖼️ M3 原生多模态看图 + 豆包视觉兜底
- 🎲 10% 随机插话
- 📝 日志铁律：只要跑就必须写日志

## v13 — 2026-06-05
- 🏗️ 从 napcat_bridge.js 重构为 napcat_bridge.mjs (ESM)
- 📦 WebSocket 支持：NapCat 直连桥接器
- 👥 用户画像系统：每 20 条 DeepSeek 提炼画像
- 🏷️ 关键词提取 + 用户记忆
- 🌐 群氛围感知

## v12 — 2026-06-01
- 🤖 初始版本上线
- 🔌 NapCat OneBot v11 集成
- 👥 QQ 群白名单 + 好友白名单
- 🔗 B站链接自动预览
- 📱 QQ 小程序卡片解析
- 💬 @ 回复 + 随机插话
# v1.2.4 launcher phase 2 - 2026-07-03
- 桌面整理：新增 `QQFriend控制台` 文件夹，归档启动器 exe、launcher 配置、报告文档、旧发布目录和历史 zip；桌面保留 `QQFriend控制台.lnk` 快捷方式。
- 新增只读本地管理 API：`/admin/status`、`/admin/commands`、`/admin/logs`，为控制台总览、命令页和日志页打底。
- 管理 API 默认仅允许 localhost / loopback 访问；支持可选 `QQFRIEND_ADMIN_TOKEN` 或 `Authorization: Bearer` 校验。
- `/admin/status` 只返回脱敏状态，模型 key 仅显示已配置/未配置；`/admin/logs` 只读 `logs/*.log`，限制 tail 大小并脱敏 token/key。
- 新增 `test/admin-api.test.mjs`，覆盖本机访问、可选 token、命令 catalog、状态脱敏、日志路径限制和日志脱敏。

# v1.2.4 launcher phase 1 - 2026-07-03
- 第一阶段启动器模块化：将 `Program.cs` 拆为 `App/`、`Config/`、`Processes/`、`Services/`，保留现有启动、停止、重启、健康检查、JM 自检和日报模块检查行为。
- 修复启动器 UI 中文乱码：按钮、窗口标题、状态提示、日志提示恢复为可读中文。
- 桌面 `QQFriend一键启动.exe` 已重新发布；`dotnet build` 0 errors / 0 warnings，`npm run lint`、`npm test`、`npm run release:check` 通过。

# v1.2.4 launcher supplement - 2026-07-02
- 新增 Windows 一键启动器：桌面 `QQFriend一键启动.exe` 可串起 NapCat、Bridge、watchdog、JM 自检、日报模块导入检查和 `/health` 检查。
- 启动器首次运行会在 exe 同目录生成 `launcher-config.json`，默认指向 `%USERPROFILE%\.openclaw\workspace\qqfriend`，不读取或打包真实 `.env` key。

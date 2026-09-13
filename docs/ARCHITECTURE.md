# FlyingMouse Format 架构说明

本文说明当前源码的运行机制。0.7.1 候选版本的 Git、产物、测试、安装与发布状态统一记录在 [修复与验收记录](REPAIR-0.7.1.md)；旧版验证结果不作为本次构建的证据。

## 运行结构

```text
Electron 主进程
  ├─ 单实例锁、独立临时目录、引擎路径配置
  ├─ 127.0.0.1 随机端口上的 Express 服务
  ├─ BrowserWindow → 本地页面 → 转换 API → 各转换模块
  ├─ Store Office Worker → 可写缓存 → Office 就绪状态
  └─ preload 受限 IPC → 保存对话框 → 校验后保存结果
```

窗口开启后启动 Store Office 准备工作，复制和验证在独立 Worker 中执行。转换文件留在本机；渲染进程启用 `contextIsolation` 和沙箱，关闭 `nodeIntegration`。修改状态的转换请求及 IPC 校验可信本地页面来源；下载只允许访问登记的结果及关联资源。

## 主要模块

| 模块 | 职责 |
| --- | --- |
| [electron-main.js](../electron-main.js)、[preload.js](../preload.js)、[electron-security.js](../electron-security.js) | 桌面生命周期、隔离边界、保存与诊断 |
| [server.js](../server.js)、[config.js](../config.js)、[utils.js](../utils.js) | 本地 API、引擎能力、格式与目标路由 |
| [office-readiness.js](../office-readiness.js)、[store-engine-worker.js](../store-engine-worker.js)、[store-engine-cache.js](../store-engine-cache.js) | Office 准备状态、后台复制、缓存完整性 |
| [pdf.js](../pdf.js)、[pdf-classifier.js](../pdf-classifier.js)、[ocr.js](../ocr.js) | PDF 分类、正文完整性、OCR 与降级输出 |
| [pdf-table-extractor.js](../pdf-table-extractor.js)、[pdf-table-runtime.js](../pdf-table-runtime.js) | 原生 PDF 的空间表格提取与工作簿生成 |
| [pdf-structure-engine.js](../pdf-structure-engine.js)、[pdf-structure-contract.js](../pdf-structure-contract.js)、[pdf-structure-score.js](../pdf-structure-score.js) | 高级结构引擎边界、结果校验与表格评分 |
| [pdf-office-docx.js](../pdf-office-docx.js)、[pdf-office-xlsx.js](../pdf-office-xlsx.js) | 结构化 Word/Excel、参考图与待核对内容 |
| [markdown-document.js](../markdown-document.js)、[markdown-math.js](../markdown-math.js)、[text-conversion.js](../text-conversion.js) | Markdown 文档树、数学公式及文本格式 |
| [subtitles.js](../subtitles.js)、[ofd-convert.js](../ofd-convert.js) | 字幕转换与 OFD 专用路径 |
| [settings-store.js](../settings-store.js)、[save-download.js](../save-download.js)、[save-converted-result.js](../save-converted-result.js) | 设置降级、结果完整性与关联资源保存 |
| [public/app.js](../public/app.js)、[public/conversion-preferences.js](../public/conversion-preferences.js)、[public/i18n.js](../public/i18n.js) | 队列交互、能力刷新、偏好与双语提示 |

新根模块必须登记到 `package.json` 的 `build.files` 白名单。源码可运行不代表模块已进入安装包。

## 本地接口与状态

| 接口 | 用途 |
| --- | --- |
| `GET /api/capabilities` | 引擎能力、Office 准备状态、格式分组及资源限制 |
| `POST /api/targets` | 根据扩展名与当前能力查询可选目标 |
| `POST /api/convert` | 单文件转换 |
| `POST /api/convert-images-to-pdf` | 图片队列合并 PDF |
| `POST /api/merge-pdfs` | PDF 合并 |
| `GET /downloads/:id` | 下载当前实例登记的结果 |

语言和各源格式的目标偏好保存在浏览器存储，默认保存目录写入 Electron `userData/settings.json`。存储失败时保留内存状态并提示；设置写盘支持 Store 重定向导致的跨卷 `EXDEV` 降级。每个实例拥有独立临时目录，运行期间登记的转换结果不按固定时长过期；退出清理与启动残留清理不等于删除用户已保存文件。

## Store Office 准备

Store 的安装目录只读，因此在加载服务配置前就确定每用户可写的 LibreOffice 路径。准备状态为 `pending`、`ready` 或 `failed`；Office 转换等待准备，图片、文本、字幕等独立路径可先工作。页面在准备期间刷新能力，失败显示原因和诊断入口。

缓存名称依据引擎内容标识确定。冷缓存先复制到 staging，校验构建期完整性清单并执行真实 CSV→PDF 冒烟，成功后再发布。内容标识、验证收据和文件快照一致的暖缓存可复用；旧包没有内容标识时仍需冒烟。损坏缓存重新构建，失败不会发布残缺目录或提前回收可用旧缓存。

## PDF 与 OCR 路由

- **原生 PDF→Word**：优先使用 docengine；检查 DOCX 容器、引用资源、可编辑内容及原生文字覆盖。失败时按错误类型尝试结构引擎或重建文字，降级结果附带版式提示。
- **扫描或混合 PDF→Word/Excel**：使用 PP-StructureV3 结构识别。部分引擎缺失、解析或正文覆盖错误允许 Word 回落 OCR 段落；Excel 没有可靠表格时明确失败。无效结构、资源超限和低质量表格不会作为成功结果输出。
- **原生 PDF→Excel**：使用 PDF.js 文字坐标、线条和空间关系形成表格模型，按表格分工作表并处理可判断的跨页续表；未成表内容的原始行工作表属于这条路径，不是扫描表格识别失败的兜底。
- **PDF→TXT/HTML/Markdown 及 Word 文字回落**：逐页检查正文，包括只有原生标题或印章、正文仍在图片中的页面；补充 OCR 并合并原生文字，保留原生标点，真正空白页跳过 OCR。Markdown 保留可判断的标题和简单表格，不保证原版式或插图还原。
- **图片 OCR**：Tesseract 先校正方向和倾斜，质量不足时尝试其他布局或旋转。质量过低失败，需复核的文字、金额和方向校正返回双语提示；多页 TIFF 逐页识别。图片→DOCX/Markdown 输出可编辑文字，不承诺重建原图版式。

结构表格按空间与文字对应分配 OCR 内容，置信度只评估有文字的单元格。空白格保持空白，Excel 不把空白格计入低置信度待核对项。网格覆盖、非空比例、候选冲突与质量门槛仍生效；详细常量以评分模块为准。

## 引擎与资源边界

FFmpeg 负责普通音视频及部分图片编码，Sharp 负责图片处理，LibreOffice 负责 Office，Poppler 负责 PDF 栅格化，Tesseract 负责轻量 OCR，Pandoc 负责 Markdown 文档生成，qpdf 负责 PDF 密码操作。OFD 走纯 JavaScript 转 PDF，再按需使用 PDF 转换链路。格式清单和实验性标记以 `config.js` 与能力接口为准；公开版只开放普通音频格式，旧版音乐平台特殊格式文档不表示当前支持。

通用图片尺寸、像素和批次字节策略使用 `Number.MAX_SAFE_INTEGER` 占位，仍验证输入有效性；这不代表内存、磁盘或原生解码器没有限制。高级结构识别有独立预算：最多 500 页，按 144 DPI 渲染时单边最多 16,384 像素、单页 5,000 万像素、累计 1 亿像素；输出总量和清单大小分别限制为 512 MiB。JavaScript 与原生入口预检保持一致，原生预检先于 Paddle 导入和模型初始化。

结构引擎可用性检查可执行文件及 11 组必需模型的非空图、权重和配置文件，并验证路径归属；仅存在模型目录不足以判定可用。原生退出码区分模型缺失、解析失败、结构无效和资源超限。Windows 原生引擎使用 UTF-8 进程代码页；不支持时在 ASCII 路径下暂存模型，必要时使用已存在且指向同一每用户目录的 NTFS 短路径，不创建公共模型缓存。

大引擎通过 `extraResources` 打包，不作为普通源码提交。完整版保留高级结构引擎；可选 Windows 轻量版只移除 `docstructure` 资源并写入 `engineProfile: "lite"`，保留普通 PDF、轻量 OCR、Office、音视频、字幕及图片文字输出。轻量版明确提示高级扫描表格需要完整版，Word 可按上述规则回落 OCR。Windows Tesseract WASM 去除重复副本，保留所需 SIMD/LSTM 变体；macOS 使用独立配置，本轮未验证。

## 平台与产品边界

标准 Windows 构建使用根项目 Electron 运行时。Win7 是独立 Legacy profile，使用自己的 Electron 22.3.27、Sharp 0.32.6、PDF.js 2.16.105 与锁文件；其构建脚本要求 Node 18–22，在隔离 staging 安装依赖，不修改根运行时。两个运行时的 PDF.js 均随包自包含并禁用动态求值。macOS 使用各架构原生引擎包，平台是否完成本轮验证以修复记录为准。

飞鼠格式与鼠鼠打印是独立应用；图标和鼠鼠界面资产按项目约定维护，不因转换引擎修改而重绘。

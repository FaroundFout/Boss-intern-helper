# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

BOSS直聘 AI 海投助手 — Tampermonkey 用户脚本，用于在 BOSS 直聘（zhipin.com）自动筛选职位、AI 智能匹配、批量沟通。基于 Yangshengzhou 开源项目改进，支持多 AI 提供商。

## 文件说明

- **`Boss_helper.js`** (v2.0.0.0, 约 7100 行) — 完整版，包含 AI 智能回复、批量打招呼、简历发送、聊天自动回复等全部功能。
- **`Boss_helper_enhanced.js`** (v2.1.0-slim, 约 3200 行) — 瘦身增强筛选版，保留职位筛选、AI 岗位判断、简历分析、批量沟通，移除聊天自动回复功能。

## 开发指南

这两个文件是独立的 Tampermonkey 用户脚本，无需构建工具。直接编辑 `.js` 文件，然后在 Tampermonkey 管理面板中导入/更新即可。

- **无构建步骤**：纯 JavaScript (ES6+)，无依赖（除运行时 CryptoJS CDN）。
- **无测试**：项目没有测试框架。
- **本地开发**：在 Tampermonkey 中加载本地文件，或使用 Tampermonkey 编辑器直接编辑已安装的脚本。
- **调试**：脚本运行在 `https://www.zhipin.com/web/*` 页面下，打开浏览器开发者工具的 Console 面板查看 `console.log` 输出。

## `Boss_helper_enhanced.js` 架构

核心仅依赖 `GM_xmlhttpRequest` 和 `CryptoJS`（CDN require）。

### 模块分层

1. **配置 `CONFIG`** — 全局常量（间隔时间、API 超时、存储键名）。`CONFIG.COLORS` 动态由主题注入。
2. **工具函数（顶层）** — `getStoredJSON`、`setLargeItem`、`parseKeywordList`、`parseSalaryBound`、`decodeBossSalaryText`、`normalizeSalaryText`、`getTextBySelectors` 等。BOSS 直聘使用自定义编码字符显示薪资（Unicode `0xe031`-`0xe03a` 映射数字 0-9），需要 `decodeBossSalaryText` 解码。
3. **`state`** — 全局运行时状态（运行/停止、当前索引、关键词列表、职位列表、UI 状态、AI 配置）。
4. **`elements`** — 所有 DOM 元素引用集中管理（面板、按钮、输入框等）。
5. **筛选函数（Filter）** — 页面职位卡片采集 `getJobCardsFromPage()`、字段提取 `collectJobCardFilterInfo()`、多维度过滤、实习薪资过滤等。
6. **`UI` 对象** — 面板创建、拖拽、主题切换（`PAGE_TYPES.JOB_LIST` / `PAGE_TYPES.CHAT`）、对话框（设置、AI 配置、简历管理）、迷你悬浮图标。
7. **`settings`** — 用户设置管理，与 `localStorage` 双向绑定。
8. **`Core` 对象** — 核心处理流程：`autoScrollJobList()` → `processJobList()` → 逐个职位沟通、翻页、城市切换。从职位卡片提取信息后调用 AI API 进行岗位匹配判断。
9. **入口 `init()`** — 仅在路径包含 `/jobs` 时初始化 UI，并通过 `MutationObserver` 监听 SPA 路由变化。

### AI 提供商配置

用户可自定义 OpenAI 兼容的 API 地址和密钥。内置预设支持：
- 讯飞星火：`https://spark-api-open.xf-yun.com/v1/chat/completions`
- 硅基流动：`https://api.siliconflow.cn/v1/chat/completions`
- 火山引擎：`https://ark.cn-beijing.volces.com/api/v3/chat/completions`
- OpenAI：`https://api.openai.com/v1/chat/completions`
- DeepSeek：`https://api.deepseek.com/v1/chat/completions`

### BOSS 直聘薪资解码

平台在职位卡片中使用私有 Unicode 字符（``-``）显示薪资数字。`decodeBossSalaryText()` 将它们转换为标准 ASCII 数字（0-9）。所有薪资处理必须先经过此函数解码。

## 注意事项

- `/jobs` 路径是职位列表页（批量投递），`/chat` 路径是聊天页（仅原版使用）。
- `localStorage` 有大小限制（通常 5-10MB），简历文本等大数据使用 `setLargeItem` 自动截断。
- 原版 `Boss_helper.js` 还依赖 `@connect jasun.xyz` 后端 API；增强版 `Boss_helper_enhanced.js` 没有此后端依赖。
- 脚本通过 `GM_xmlhttpRequest` 发起跨域 API 请求，必须在 Tampermonkey 脚本头部 `@connect` 声明目标域名。

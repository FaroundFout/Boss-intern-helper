// ==UserScript==
// @name         小臣版AI-boss海投助手-增强筛选版
// @namespace    https://github.com/DYxiaochen
// @version      2.1.0-slim
// @description  瘦身版BOSS直聘海投助手：保留职位筛选、AI岗位判断、简历分析和批量沟通
// @author       小臣 (基于Yangshengzhou开源项目)
// @match        https://www.zhipin.com/web/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @supportURL   https://github.com/DYxiaochen/AI-BossJob
// @homepageURL  https://github.com/DYxiaochen/AI-BossJob
// @license      AGPL-3.0-or-later
// @icon         https://gitee.com/Yangshengzhou/jobs_helper/raw/Boss/assets/icon.ico
// @connect      spark-api-open.xf-yun.com
// @connect      api.siliconflow.cn
// @connect      ark.cn-beijing.volces.com
// @connect      api.openai.com
// @connect      api.deepseek.com
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  /**
   * @typedef {Object} JobInfo
   * @property {string} jobId - 职位ID
   * @property {string} title - 职位标题
   * @property {string} company - 公司名称
   * @property {string} salary - 薪资范围
   * @property {string} location - 工作地点
   * @property {string} hrKey - HR标识
   */

  const CONFIG = {
    BASIC_INTERVAL: 1000,
    OPERATION_INTERVAL: 1200,

    MINI_ICON_SIZE: 40,

    API: {
      TIMEOUT: 10000,
    },

  };

  const DEFAULT_AI_API_URL = "https://spark-api-open.xf-yun.com/v1/chat/completions";

  const hasUserscriptStorage = () =>
    typeof GM_getValue === "function" && typeof GM_setValue === "function";

  const getStorageItem = (key) => {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      console.warn(`读取本地配置失败: ${key}`, error);
      return null;
    }
  };

  const setStorageItem = (key, value) => {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      console.error(`保存本地配置失败: ${key}`, error);
      return false;
    }
  };

  const removeStorageItem = (key) => {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.warn(`清理本地配置失败: ${key}`, error);
    }
  };

  const getSecureConfigItem = (key, defaultValue = "") => {
    if (hasUserscriptStorage()) {
      try {
        const storedValue = GM_getValue(key, null);
        if (storedValue !== null && storedValue !== undefined && storedValue !== "") {
          return String(storedValue);
        }
      } catch (error) {
        console.warn(`读取安全配置失败: ${key}`, error);
      }
    }

    const legacyValue = getStorageItem(key);
    if (legacyValue !== null && legacyValue !== "") {
      if (hasUserscriptStorage()) {
        try {
          GM_setValue(key, legacyValue);
          if (key === "aiApiKey") removeStorageItem(key);
        } catch (error) {
          console.warn(`迁移安全配置失败: ${key}`, error);
        }
      }
      return legacyValue;
    }

    return defaultValue;
  };

  const setSecureConfigItem = (key, value) => {
    const textValue = String(value ?? "");
    if (hasUserscriptStorage()) {
      try {
        GM_setValue(key, textValue);
        if (key === "aiApiKey") {
          removeStorageItem(key);
        } else {
          setStorageItem(key, textValue);
        }
        return true;
      } catch (error) {
        console.warn(`保存安全配置失败，回退到localStorage: ${key}`, error);
      }
    }

    return setStorageItem(key, textValue);
  };

  const getAiConfig = () => ({
    apiKey: getSecureConfigItem("aiApiKey", ""),
    apiUrl: getSecureConfigItem("aiApiUrl", DEFAULT_AI_API_URL),
    model: getSecureConfigItem("aiModel", "lite"),
  });

  const normalizeApiUrl = (value) => {
    const rawValue = String(value || "").trim();
    if (!rawValue) return "";

    try {
      const url = new URL(rawValue);
      if (!["http:", "https:"].includes(url.protocol)) return "";
      return url.href;
    } catch (_) {
      return "";
    }
  };

  const isSiliconFlowEndpoint = (value) => {
    try {
      return new URL(value).hostname.endsWith("siliconflow.cn");
    } catch (_) {
      return false;
    }
  };

  const parseJsonObjectFromText = (text) => {
    const rawText = String(text || "").trim();
    const unwrapped = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

    try {
      return JSON.parse(unwrapped);
    } catch (_) {
      const jsonText = unwrapped.match(/\{[\s\S]*\}/)?.[0];
      if (!jsonText) throw new Error("未找到可解析JSON");
      return JSON.parse(jsonText);
    }
  };

  const parseJsonSafely = (text, defaultValue = null) => {
    try {
      const rawText = String(text || "").trim();
      return rawText ? JSON.parse(rawText) : defaultValue;
    } catch (_) {
      return defaultValue;
    }
  };

  const DEFAULT_AI_ROLE_PROMPT = `你是一个稳健、偏求职机会增长导向的岗位匹配评估助手，只负责分析简历与岗位是否匹配，不负责代替求职者聊天回复。

你的目标：
基于用户提供的真实简历内容、AI简历分析结果、岗位标题、公司信息、薪资地点、岗位标签、职位描述和职位要求，判断该岗位是否值得投递。

核心原则：
1. 只基于输入内容判断，不编造候选人经历、技能、学历、项目或证书。
2. 采用稳健但不过度苛刻的匹配标准：岗位方向与候选人简历主线相关，或核心技能/项目经历有明确可迁移性时，可以建议投递。
3. 不要只因为岗位标题包含“后端”“Java”“开发”等字样就判断适合，必须结合职位描述和职位要求。
4. 如果候选人主方向是 Java 后端应用开发，则优先匹配 Java/Spring/Spring Boot/业务系统/Web后端/接口开发/数据库/缓存/中间件/微服务等应用后端岗位。
5. 如果岗位明显偏基础设施、基础软件、云原生底层、容器、虚拟化、DPU、编译器、分布式存储、网络、操作系统、AIOps、软硬件一体化、机器学习基础平台等方向，即使标题包含“后端”，也应倾向于不建议投递。
6. 如果岗位硬性要求的核心技能、学历/届别/身份或工作方向与简历明显冲突，才不建议投递；普通加分项缺失不应直接判为不投。
7. 如果信息不足但岗位方向与简历主线相关，允许以中等置信度建议投递；只有明显不匹配、硬门槛不符或风险很高时才返回不建议投递。
8. 输出必须遵循调用方要求的格式；当调用方要求 JSON 时，只返回可解析 JSON，不要返回 Markdown、解释文字或代码块。
9. 置信度评分不要过低：可投递的弱匹配通常给 55-70 分，中等匹配给 70-85 分，高匹配给 85 分以上；不适合岗位才给 50 分以下。
10. 必须关注岗位对毕业年份、毕业时间、应届届别、在校生身份、实习转正时间等要求；如果候选人的毕业年份或身份明显不符合，应倾向于不建议投递，并在理由中说明风险。`;

  const getAiRolePrompt = () => {
    const savedRole = getStorageItem("aiRole") || "";
    const isChatPrompt = /面对HR|20字内|聊天回复|个性化回复|自我介绍/.test(savedRole);
    const isLegacyDefaultPrompt =
      /不要暴露你是\s*AI|不要生成聊天话术|不要生成自我介绍/.test(
        savedRole
      ) && !/毕业年份|毕业时间|应届届别|在校生身份/.test(savedRole);
    return savedRole && !isChatPrompt && !isLegacyDefaultPrompt
      ? savedRole
      : DEFAULT_AI_ROLE_PROMPT;
  };

  const getStoredJSON = (key, defaultValue) => {
    try {
      const val = getStorageItem(key);
      return val ? JSON.parse(val) : defaultValue;
    } catch (e) {
      console.error(`Error parsing ${key}:`, e);
      return defaultValue;
    }
  };

  const getStoredStringArray = (key, defaultValue = []) => {
    const value = getStoredJSON(key, defaultValue);
    return Array.isArray(value)
      ? value.map((item) => String(item).trim()).filter(Boolean)
      : defaultValue;
  };

  const getStoredBoolean = (key, defaultValue = false) => {
    const value = getStoredJSON(key, defaultValue);
    return typeof value === "boolean" ? value : defaultValue;
  };

  const getStoredString = (key, defaultValue = "") => {
    const value = getStoredJSON(key, defaultValue);
    return typeof value === "string" ? value : defaultValue;
  };

  // 安全地存储大文本到localStorage（自动截断）
  const setLargeItem = (key, value, maxLength = 500000) => {
    try {
      let textToStore = String(value ?? "");
      
      // 如果文本太长，截断它
      if (textToStore && textToStore.length > maxLength) {
        console.warn(`文本太长(${textToStore.length}字符)，已截断到${maxLength}字符`);
        textToStore = textToStore.substring(0, maxLength) + "\n[内容已截断，仅保存前" + maxLength + "字符]";
      }
      
      const jsonString = JSON.stringify(textToStore);
      
      // 检查是否超过localStorage限制
      if (jsonString.length > 2000000) { // 约2MB
        console.warn(`存储数据太大(${jsonString.length}字节)，尝试进一步截断`);
        textToStore = textToStore.substring(0, Math.floor(maxLength / 2)) + "\n[内容已大幅截断以符合存储限制]";
      }
      
      return setStorageItem(key, JSON.stringify(textToStore));
    } catch (e) {
      const message = String(e?.message || "");
      if (e.name === 'QuotaExceededError' || message.includes('quota')) {
        console.error(`存储空间不足，无法保存${key}`);
        // 尝试保存截断版本
        try {
          const truncated = String(value).substring(0, 100000) + "\n[因存储限制已截断]";
          return setStorageItem(key, JSON.stringify(truncated)) ? 'truncated' : false;
        } catch (e2) {
          console.error(`即使截断后仍无法保存${key}`);
          return false;
        }
      }
      console.error(`Error saving ${key}:`, e);
      return false;
    }
  };

  const parseKeywordList = (value) =>
    (value || "")
      .trim()
      .toLowerCase()
      .split(/[，,]/)
      .map((keyword) => keyword.trim())
      .filter(Boolean);

  const parseSalaryBound = (value) => {
    const normalized = String(value ?? "").replace(/[^\d.]/g, "");
    if (!normalized) return null;

    const numberValue = Number(normalized);
    return Number.isFinite(numberValue) && numberValue >= 0
      ? numberValue
      : null;
  };

  const decodeBossSalaryText = (text) =>
    Array.from(String(text || ""))
      .map((char) => {
        const code = char.codePointAt(0);

        if (code >= 0xe031 && code <= 0xe03a) {
          return String(code - 0xe031);
        }

        return char;
      })
      .join("");

  const normalizeSalaryText = (text) =>
    decodeBossSalaryText(text)
      .replace(/[０-９]/g, (char) =>
        String.fromCharCode(char.charCodeAt(0) - 0xfee0)
      )
      .replace(/[－—–~～至]/g, "-")
      .replace(/\s+/g, "")
      .toLowerCase();

  const getTextBySelectors = (root, selectors) => {
    for (const selector of selectors) {
      const text = root.querySelector(selector)?.textContent?.trim();
      if (text) return text;
    }

    return "";
  };

  const normalizeFilterText = (value) =>
    String(value || "")
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (char) =>
        String.fromCharCode(char.charCodeAt(0) - 0xfee0)
      )
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

  const normalizeKeywordList = (keywords) =>
    (Array.isArray(keywords) ? keywords : [])
      .map((keyword) => normalizeFilterText(keyword))
      .filter(Boolean);

  const findMatchedKeyword = (text, keywords) => {
    const normalizedText = normalizeFilterText(text);
    return normalizeKeywordList(keywords).find((keyword) =>
      normalizedText.includes(keyword)
    );
  };

  const getJobCardTitleText = (card) =>
    getTextBySelectors(card, [
      ".job-name",
      ".job-title",
      ".job-info .name",
      ".job-primary .name",
      "[class*='job-name']",
      "[class*='job-title']",
    ]);

  const getJobCardLocationText = (card) =>
    getTextBySelectors(card, [
      ".job-address-desc",
      ".company-location",
      ".job-area",
      ".job-location",
      "[class*='job-address']",
      "[class*='job-area']",
      "[class*='location']",
    ]);

  const getJobCardCompanyName = (card) =>
    getTextBySelectors(card, [
      ".company-name",
      ".company-info .name",
      ".company-text .name",
      "[class*='company-name']",
      "[class*='company'] a",
    ]);

  const getJobCardSalaryText = (card) =>
    decodeBossSalaryText(getTextBySelectors(card, [
      ".salary",
      ".job-salary",
      ".job-limit .red",
      ".job-info .salary",
      "[class*='salary']",
    ]));

  const getJobCardHeadhunterText = (card) => {
    const headhuntingElement = card.querySelector(
      ".job-tag-icon, img[alt*='猎头'], [class*='hunter'], [class*='headhunt']"
    );

    return [
      headhuntingElement?.alt,
      headhuntingElement?.title,
      headhuntingElement?.textContent,
    ]
      .filter(Boolean)
      .join(" ");
  };

  const parseInternSalaryRange = (salaryText) => {
    const text = normalizeSalaryText(salaryText);
    if (!text || /面议|薪资面谈|可议/.test(text)) return null;

    const numbers = [...text.matchAll(/(\d+(?:\.\d+)?)/g)]
      .map((match) => Number(match[1]))
      .filter((value) => Number.isFinite(value));

    if (!numbers.length) return null;

    let multiplier = 1;
    if (/k|千/.test(text)) {
      multiplier = 1000;
    } else if (/万/.test(text)) {
      multiplier = 10000;
    }

    const first = numbers[0] * multiplier;
    const second = (numbers[1] ?? numbers[0]) * multiplier;

    return {
      min: Math.min(first, second),
      max: Math.max(first, second),
    };
  };

  const buildInternSalaryFilterLabel = (min, max) => {
    if (min === null && max === null) return "实习薪资不限";
    if (min !== null && max !== null) return `实习薪资[${min}-${max}]`;
    if (min !== null) return `实习薪资不低于[${min}]`;
    return `实习薪资不高于[${max}]`;
  };

  const initialAiConfig = getAiConfig();

  const state = {
    isRunning: false,
    runId: 0,
    currentAiRequest: null,
    currentIndex: 0,
    currentCityIndex: 0,

    includeKeywords: getStoredStringArray("includeKeywords", []),
    locationKeywords: getStoredStringArray("locationKeywords", []),
    excludeTitleKeywords: getStoredStringArray("excludeTitleKeywords", []),
    excludeCompanyKeywords: getStoredStringArray("excludeCompanyKeywords", []),
    internSalaryMin: parseSalaryBound(getStoredJSON("internSalaryMin", "")),
    internSalaryMax: parseSalaryBound(getStoredJSON("internSalaryMax", "")),

    jobList: [],

    ui: {
      isMinimized: false,
    },

    settings: {
      ai: {
        role: getAiRolePrompt(),
        // 免费版本：用户自定义AI API配置
        apiKey: initialAiConfig.apiKey,
        apiUrl: initialAiConfig.apiUrl,
        model: initialAiConfig.model,
      },
      recruiterActivityStatus: getStoredStringArray(
        "recruiterActivityStatus",
        ["不限"]
      ),
      excludeHeadhunters: getStoredBoolean("excludeHeadhunters", false),
      useAiJobScreening: getStoredBoolean("useAiJobScreening", false),
      resumeText: getStoredString("resumeText", ""),
      resumeAnalysis: getStoredString("resumeAnalysis", ""),
    },
  };

  const elements = {
    panel: null,
    controlBtn: null,
    log: null,
    includeInput: null,
    locationInput: null,
    excludeTitleInput: null,
    excludeCompanyInput: null,
    internSalaryMinInput: null,
    internSalaryMaxInput: null,
    miniIcon: null,
  };

  function getInternSalaryFilterLabel() {
    return buildInternSalaryFilterLabel(
      state.internSalaryMin,
      state.internSalaryMax
    );
  }

  function collectJobCardFilterInfo(card, index) {
    return {
      card,
      index,
      title: getJobCardTitleText(card),
      location: getJobCardLocationText(card),
      company: getJobCardCompanyName(card),
      salary: getJobCardSalaryText(card),
      headhunterText: getJobCardHeadhunterText(card),
    };
  }

  function getJobCardsFromPage() {
    const cardSelectors = [
      "li.job-card-box",
      ".job-card-box",
      ".job-list-box > li",
      ".search-job-result > ul > li",
      ".search-job-result li.job-card-box",
      ".job-list li.job-card-box",
    ];
    const seenElements = new Set();
    const seenJobKeys = new Set();
    const cards = [];

    cardSelectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((card) => {
        if (seenElements.has(card)) return;

        const jobInfo = collectJobCardFilterInfo(card, cards.length);
        const hasJobSignal = jobInfo.title || jobInfo.company || jobInfo.salary;
        if (!hasJobSignal) return;

        const jobKey = [
          normalizeFilterText(jobInfo.title),
          normalizeFilterText(jobInfo.company),
          normalizeFilterText(jobInfo.salary),
          normalizeFilterText(jobInfo.location),
        ].join("|");
        if (jobKey && seenJobKeys.has(jobKey)) return;

        seenElements.add(card);
        seenJobKeys.add(jobKey);
        cards.push(card);
      });
    });

    return cards;
  }

  function formatJobForLog(jobInfo) {
    const title = jobInfo.title || "职位名为空";
    const company = jobInfo.company ? ` / ${jobInfo.company}` : "";
    const salary = jobInfo.salary ? ` / ${jobInfo.salary}` : "";
    const location = jobInfo.location ? ` / ${jobInfo.location}` : "";

    return `${jobInfo.index + 1}. ${title}${company}${salary}${location}`;
  }

  function formatSalaryRangeForLog(salaryRange) {
    if (!salaryRange) return "无法解析";

    return `${salaryRange.min}-${salaryRange.max}`;
  }

  function getJobFilterFailures(jobInfo, excludeHeadhunters) {
    const failures = [];
    const includeKeywords = normalizeKeywordList(state.includeKeywords);
    const titleExcludeKeywords = normalizeKeywordList(state.excludeTitleKeywords);
    const locationKeywords = normalizeKeywordList(state.locationKeywords);
    const companyExcludeKeywords = normalizeKeywordList(
      state.excludeCompanyKeywords
    );
    const title = normalizeFilterText(jobInfo.title);
    const location = normalizeFilterText(jobInfo.location);
    const company = normalizeFilterText(jobInfo.company);
    const headhunterText = normalizeFilterText(jobInfo.headhunterText);
    const salaryLabel = buildInternSalaryFilterLabel(
      state.internSalaryMin,
      state.internSalaryMax
    );

    if (includeKeywords.length && !findMatchedKeyword(title, includeKeywords)) {
      failures.push({
        type: "职位名包含",
        message: `职位名“${jobInfo.title || "空"}”不包含任一关键词[${state.includeKeywords.join("、")}]`,
      });
    }

    const matchedTitleExclude = findMatchedKeyword(title, titleExcludeKeywords);
    if (matchedTitleExclude) {
      failures.push({
        type: "职位名排除",
        message: `职位名命中排除词“${matchedTitleExclude}”`,
      });
    }

    if (locationKeywords.length && !findMatchedKeyword(location, locationKeywords)) {
      failures.push({
        type: "工作地包含",
        message: `工作地“${jobInfo.location || "空"}”不包含任一关键词[${state.locationKeywords.join("、")}]`,
      });
    }

    if (excludeHeadhunters && headhunterText.includes("猎头")) {
      failures.push({
        type: "排除猎头",
        message: `岗位标识命中猎头“${jobInfo.headhunterText || "猎头"}”`,
      });
    }

    const matchedCompanyExclude = findMatchedKeyword(company, companyExcludeKeywords);
    if (matchedCompanyExclude) {
      failures.push({
        type: "排除公司",
        message: `公司“${jobInfo.company || "空"}”命中排除词“${matchedCompanyExclude}”`,
      });
    }

    if (state.internSalaryMin !== null || state.internSalaryMax !== null) {
      const salaryRange = parseInternSalaryRange(jobInfo.salary);
      if (!salaryRange) {
        failures.push({
          type: "实习薪资",
          message: `薪资“${jobInfo.salary || "空"}”无法解析，未通过${salaryLabel}`,
        });
      } else if (
        state.internSalaryMin !== null &&
        salaryRange.min < state.internSalaryMin
      ) {
        failures.push({
          type: "实习薪资",
          message: `薪资“${jobInfo.salary}”解析为${formatSalaryRangeForLog(salaryRange)}，最低低于下限${state.internSalaryMin}`,
        });
      } else if (
        state.internSalaryMax !== null &&
        salaryRange.min > state.internSalaryMax
      ) {
        failures.push({
          type: "实习薪资",
          message: `薪资“${jobInfo.salary}”解析为${formatSalaryRangeForLog(salaryRange)}，最低高于上限${state.internSalaryMax}`,
        });
      }
    }

    return failures;
  }

  function summarizeFilterFailures(failures) {
    const summary = new Map();

    failures.forEach(({ failures: jobFailures }) => {
      jobFailures.forEach((failure) => {
        summary.set(failure.type, (summary.get(failure.type) || 0) + 1);
      });
    });

    return [...summary.entries()]
      .map(([type, count]) => `${type}${count}个`)
      .join("，");
  }

  const UI = {
    PAGE_TYPES: {
      JOB_LIST: "jobList",
      CHAT: "chat",
    },

    currentPageType: null,

    init() {
      this.currentPageType = location.pathname.includes("/chat")
        ? this.PAGE_TYPES.CHAT
        : this.PAGE_TYPES.JOB_LIST;
      this._applyTheme();
      this.createControlPanel();
      this.createMiniIcon();
    },

    createControlPanel() {
      if (document.getElementById("boss-pro-panel")) {
        document.getElementById("boss-pro-panel").remove();
      }

      elements.panel = this._createPanel();

      const header = this._createHeader();
      const controls = this._createPageControls();
      elements.log = this._createLogger();
      const footer = this._createFooter();

      elements.panel.append(header, controls, elements.log, footer);
      document.body.appendChild(elements.panel);
      this._makeDraggable(elements.panel);
    },

    _applyTheme() {
      CONFIG.COLORS =
        this.currentPageType === this.PAGE_TYPES.JOB_LIST
          ? this.THEMES.JOB_LIST
          : this.THEMES.CHAT;

      document.documentElement.style.setProperty(
        "--primary-color",
        CONFIG.COLORS.primary
      );
      document.documentElement.style.setProperty(
        "--secondary-color",
        CONFIG.COLORS.secondary
      );
      document.documentElement.style.setProperty(
        "--accent-color",
        CONFIG.COLORS.accent
      );
      document.documentElement.style.setProperty(
        "--neutral-color",
        CONFIG.COLORS.neutral
      );
    },

    THEMES: {
      JOB_LIST: {
        primary: "#4285f4",
        secondary: "#f5f7fa",
        accent: "#e8f0fe",
        neutral: "#6b7280",
      },
      CHAT: {
        primary: "#34a853",
        secondary: "#f0fdf4",
        accent: "#dcfce7",
        neutral: "#6b7280",
      },
    },

    _createPanel() {
      const panel = document.createElement("div");
      panel.id = "boss-pro-panel";
      panel.className =
        this.currentPageType === this.PAGE_TYPES.JOB_LIST
          ? "boss-joblist-panel"
          : "boss-chat-panel";

      const baseStyles = `
            position: fixed;
            top: 36px;
            right: 24px;
            width: clamp(300px, 80vw, 400px);
            border-radius: 12px;
            padding: 12px;
            font-family: 'Segoe UI', system-ui, sans-serif;
            z-index: 2147483647;
            display: flex;
            flex-direction: column;
            transition: all 0.3s ease;
            background: #ffffff;
            box-shadow: 0 10px 25px rgba(var(--primary-rgb), 0.15);
            border: 1px solid var(--accent-color);
            cursor: default;
        `;

      panel.style.cssText = baseStyles;

      const rgbColor = this._hexToRgb(CONFIG.COLORS.primary);
      document.documentElement.style.setProperty("--primary-rgb", rgbColor);

      return panel;
    },

    _createHeader() {
      const header = document.createElement("div");
      header.className =
        this.currentPageType === this.PAGE_TYPES.JOB_LIST
          ? "boss-header"
          : "boss-chat-header";

      header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0 10px 15px;
            margin-bottom: 15px;
            border-bottom: 1px solid var(--accent-color);
        `;

      const title = this._createTitle();

      const buttonContainer = document.createElement("div");
      buttonContainer.style.cssText = `
            display: flex;
            gap: 8px;
        `;

      const buttonTitles = {
        ai: "AI配置",
        settings: "插件设置",
        close: "最小化海投面板",
      };

      // AI配置按钮图标（使用机器人/AI图标）
      const aiConfigIcon = `<svg t="1767250169245" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="5617" width="200" height="200"><path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64z m0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372z" fill="#4285f4"/><path d="M512 540m-80 0a80 80 0 1 0 160 0 80 80 0 1 0-160 0Z" fill="#4285f4"/><path d="M512 300c-26.5 0-48 21.5-48 48v96c0 26.5 21.5 48 48 48s48-21.5 48-48v-96c0-26.5-21.5-48-48-48zM300 512c0-26.5-21.5-48-48-48h-96c-26.5 0-48 21.5-48 48s21.5 48 48 48h96c26.5 0 48-21.5 48-48zM512 724c-26.5 0-48 21.5-48 48v96c0 26.5 21.5 48 48 48s48-21.5 48-48v-96c0-26.5-21.5-48-48-48zM868 464h-96c-26.5 0-48 21.5-48 48s21.5 48 48 48h96c26.5 0 48-21.5 48-48s-21.5-48-48-48z" fill="#4285f4"/></svg>`;
      
      const aiConfigBtn = this._createIconButton(
        aiConfigIcon,
        () => {
          showAiConfigDialog();
        },
        buttonTitles.ai
      );

      aiConfigBtn.style.color = "#fff";
      aiConfigBtn.title = "AI配置";

      const settingsBtn = this._createIconButton(
        "⚙",
        () => {
          showSettingsDialog();
        },
        buttonTitles.settings
      );

      const closeBtn = this._createIconButton(
        "✕",
        () => {
          state.ui.isMinimized = true;
          elements.panel.style.transform = "translateY(160%)";
          elements.miniIcon.style.display = "flex";
        },
        buttonTitles.close
      );

      buttonContainer.append(aiConfigBtn, settingsBtn, closeBtn);
      header.append(title, buttonContainer);
      return header;
    },

    _createTitle() {
      const title = document.createElement("div");
      title.style.display = "flex";
      title.style.alignItems = "center";
      title.style.gap = "10px";

      const customSvg = `
        <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" 
            style="width: 100%; height: 100%; fill: white;">
            <path d="M896 256H640V160c0-35.3-28.7-64-64-64H448c-35.3 0-64 28.7-64 64v96H128c-35.3 0-64 28.7-64 64v512c0 35.3 28.7 64 64 64h768c35.3 0 64-28.7 64-64V320c0-35.3-28.7-64-64-64zM448 160h128v96H448V160zm448 672H128V320h768v512z" />
            <path d="M512 480c-70.7 0-128 57.3-128 128s57.3 128 128 128 128-57.3 128-128-57.3-128-128-128zm0 192c-35.3 0-64-28.7-64-64s28.7-64 64-64 64 28.7 64 64-28.7 64-64 64z" />
        </svg>
    `;

      const titleConfig = {
        main: `<span style="color:var(--primary-color);">AI</span>-Boss海投助手`,
        sub: "高效求职 · 智能匹配",
      };

      title.innerHTML = `
        <div style="
            width: 40px;
            height: 40px;
            background: var(--primary-color);
            border-radius: 10px;
            display: flex;
            justify-content: center;
            align-items: center;
            color: white;
            font-weight: bold;
            box-shadow: 0 2px 8px rgba(var(--primary-rgb), 0.3);
        ">
            ${customSvg}
        </div>
        <div>
            <h3 style="
                margin: 0;
                color: #2c3e50;
                font-weight: 600;
                font-size: 1.2rem;
            ">
                ${titleConfig.main}
            </h3>
            <span style="
                font-size:0.8em;
                color:var(--neutral-color);
            ">
                ${titleConfig.sub}
            </span>
        </div>
    `;

      return title;
    },

    _createPageControls() {
      return this._createJobListControls();
    },

    _createJobListControls() {
      const container = document.createElement("div");
      container.className = "boss-joblist-controls";
      container.style.marginBottom = "15px";
      container.style.padding = "0 10px";

      const filterContainer = this._createFilterContainer();

      container.append(filterContainer);
      return container;
    },

    _createFilterContainer() {
      const filterContainer = document.createElement("div");
      filterContainer.style.cssText = `
            background: var(--secondary-color);
            border-radius: 12px;
            padding: 15px;
            margin-bottom: 0px;
        `;

      const filterRow = document.createElement("div");
      filterRow.style.cssText = `
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 10px;
            margin-bottom: 12px;
        `;

      const excludeFilterRow = document.createElement("div");
      excludeFilterRow.style.cssText = `
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 10px;
            margin-bottom: 12px;
        `;

      const salaryFilterRow = document.createElement("div");
      salaryFilterRow.style.cssText = `
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 10px;
            margin-bottom: 12px;
        `;

      const includeFilterCol = this._createInputControl(
        "职位名包含：",
        "include-filter",
        "如：前端,开发"
      );
      const locationFilterCol = this._createInputControl(
        "工作地包含：",
        "location-filter",
        "如：杭州,滨江"
      );
      const excludeTitleFilterCol = this._createInputControl(
        "职位名排除：",
        "exclude-title-filter",
        "如：转正,兼职"
      );
      const excludeCompanyFilterCol = this._createInputControl(
        "排除公司：",
        "exclude-company-filter",
        "如：外包,某公司"
      );
      const internSalaryMinCol = this._createInputControl(
        "实习薪资下限：",
        "intern-salary-min-filter",
        "如：150"
      );
      const internSalaryMaxCol = this._createInputControl(
        "实习薪资上限：",
        "intern-salary-max-filter",
        "如：300"
      );

      elements.includeInput = includeFilterCol.querySelector("input");
      elements.locationInput = locationFilterCol.querySelector("input");
      elements.excludeTitleInput =
        excludeTitleFilterCol.querySelector("input");
      elements.excludeCompanyInput =
        excludeCompanyFilterCol.querySelector("input");
      elements.internSalaryMinInput =
        internSalaryMinCol.querySelector("input");
      elements.internSalaryMaxInput =
        internSalaryMaxCol.querySelector("input");

      elements.includeInput.value = state.includeKeywords.join(",");
      elements.locationInput.value = state.locationKeywords.join(",");
      elements.excludeTitleInput.value =
        state.excludeTitleKeywords.join(",");
      elements.excludeCompanyInput.value =
        state.excludeCompanyKeywords.join(",");
      elements.internSalaryMinInput.value =
        state.internSalaryMin === null ? "" : String(state.internSalaryMin);
      elements.internSalaryMaxInput.value =
        state.internSalaryMax === null ? "" : String(state.internSalaryMax);

      filterRow.append(includeFilterCol, locationFilterCol);
      excludeFilterRow.append(excludeTitleFilterCol, excludeCompanyFilterCol);
      salaryFilterRow.append(internSalaryMinCol, internSalaryMaxCol);

      elements.controlBtn = this._createTextButton(
        "启动海投",
        "var(--primary-color)",
        () => {
          toggleProcess();
        }
      );

      filterContainer.append(
        filterRow,
        excludeFilterRow,
        salaryFilterRow,
        elements.controlBtn
      );
      return filterContainer;
    },

    _createInputControl(labelText, id, placeholder) {
      const controlCol = document.createElement("div");
      controlCol.style.cssText = "flex: 1;";

      const label = document.createElement("label");
      label.textContent = labelText;
      label.style.cssText =
        "display:block; margin-bottom:5px; font-weight: 500; color: #333; font-size: 0.9rem;";

      const input = document.createElement("input");
      input.id = id;
      input.placeholder = placeholder;
      input.style.cssText = `
            width: 100%;
            padding: 8px 10px;
            border-radius: 8px;
            border: 1px solid #d1d5db;
            font-size: 14px;
            box-shadow: 0 1px 2px rgba(0,0,0,0.05);
            transition: all 0.2s ease;
        `;

      controlCol.append(label, input);
      return controlCol;
    },

    _createLogger() {
      const log = document.createElement("div");
      log.id = "pro-log";
      log.className =
        this.currentPageType === this.PAGE_TYPES.JOB_LIST
          ? "boss-joblist-log"
          : "boss-chat-log";

      const height =
        this.currentPageType === this.PAGE_TYPES.JOB_LIST ? "260px" : "260px";

      log.style.cssText = `
            height: ${height};
            overflow-y: auto;
            background: var(--secondary-color);
            border-radius: 12px;
            padding: 12px;
            font-size: 13px;
            line-height: 1.5;
            margin-bottom: 15px;
            margin-left: 10px;
            margin-right: 10px;
            transition: all 0.3s ease;
            user-select: text;
            scrollbar-width: thin;
            scrollbar-color: var(--primary-color) var(--secondary-color);
        `;

      log.innerHTML += `
            <style>
                #pro-log::-webkit-scrollbar {
                    width: 6px;
                }
                #pro-log::-webkit-scrollbar-track {
                    background: var(--secondary-color);
                    border-radius: 4px;
                }
                #pro-log::-webkit-scrollbar-thumb {
                    background-color: var(--primary-color);
                    border-radius: 4px;
                }
            </style>
        `;

      return log;
    },

    _createFooter() {
      const footer = document.createElement("div");
      footer.className =
        this.currentPageType === this.PAGE_TYPES.JOB_LIST
          ? "boss-joblist-footer"
          : "boss-chat-footer";

      footer.style.cssText = `
            text-align: center;
            font-size: 0.8em;
            color: var(--neutral-color);
            padding-top: 15px;
            border-top: 1px solid var(--accent-color);
            margin-top: auto;
            padding: 0px;
        `;

      const statsContainer = document.createElement("div");
      statsContainer.style.cssText = `
            display: flex;
            justify-content: space-around;
            margin-bottom: 15px;
        `;

      footer.append(
        statsContainer,
        document.createTextNode("© 2026 小臣版AI-boss海投助手 · Based on Yangshengzhou's open source project · AGPL-3.0-or-later")
      );
      return footer;
    },

    _createTextButton(text, bgColor, onClick) {
      const btn = document.createElement("button");
      btn.className = "boss-btn";
      btn.textContent = text;
      btn.style.cssText = `
            width: 100%;
            padding: 10px 16px;
            background: ${bgColor};
            color: #fff;
            border: none;
            border-radius: 10px;
            cursor: pointer;
            font-size: 15px;
            font-weight: 500;
            transition: all 0.3s ease;
            display: flex;
            justify-content: center;
            align-items: center;
            box-shadow: 0 4px 10px rgba(0,0,0,0.1);
            transform: translateY(0px);
            margin: 0 auto;
        `;

      this._addButtonHoverEffects(btn);
      btn.addEventListener("click", onClick);

      return btn;
    },

    _createIconButton(icon, onClick, title) {
      const btn = document.createElement("button");
      btn.className = "boss-icon-btn";
      btn.innerHTML = icon;
      btn.title = title;

      btn.style.cssText = `
            width: 32px;
            height: 32px;
            border-radius: 50%;
            border: none;
            background: ${this.currentPageType === this.PAGE_TYPES.JOB_LIST
          ? "var(--accent-color)"
          : "var(--accent-color)"
        };
            cursor: pointer;
            font-size: 16px;
            transition: all 0.2s ease;
            display: flex;
            justify-content: center;
            align-items: center;
            color: var(--primary-color);
            overflow: hidden;
            opacity: 1;
        `;

      if (icon.includes("<svg")) {
        btn.style.padding = "4px";
      }

      // 添加点击事件
      btn.addEventListener("click", onClick);

      // 保存 SVG 的原始 fill 颜色
      let originalSvgFill = null;
      if (icon.includes("<svg")) {
        const svgElement = btn.querySelector("svg");
        if (svgElement) {
          const pathElement = svgElement.querySelector("path");
          if (pathElement) {
            originalSvgFill = pathElement.getAttribute("fill");
          }
        }
      }

      btn.addEventListener("mouseenter", () => {
        btn.style.backgroundColor = "var(--primary-color)";
        btn.style.color = "#fff";
        btn.style.transform = "scale(1.1)";

        if (icon.includes("<svg")) {
          const svgElement = btn.querySelector("svg");
          if (svgElement) {
            const pathElement = svgElement.querySelector("path");
            if (pathElement) {
              pathElement.setAttribute("fill", "#fff");
            }
          }
        }
      });

      btn.addEventListener("mouseleave", () => {
        btn.style.backgroundColor =
          this.currentPageType === this.PAGE_TYPES.JOB_LIST
            ? "var(--accent-color)"
            : "var(--accent-color)";
        btn.style.color = "var(--primary-color)";
        btn.style.transform = "scale(1)";

        // 如果按钮包含 SVG，恢复 SVG 的原始颜色
        if (icon.includes("<svg") && originalSvgFill) {
          const svgElement = btn.querySelector("svg");
          if (svgElement) {
            const pathElement = svgElement.querySelector("path");
            if (pathElement) {
              pathElement.setAttribute("fill", originalSvgFill);
            }
          }
        }
      });

      return btn;
    },

    _addButtonHoverEffects(btn) {
      btn.addEventListener("mouseenter", () => {
        btn.style.boxShadow = `0 6px 15px rgba(var(--primary-rgb), 0.3)`;
      });

      btn.addEventListener("mouseleave", () => {
        btn.style.boxShadow = "0 4px 10px rgba(0,0,0,0.1)";
      });
    },

    _makeDraggable(panel) {
      const header = panel.querySelector(".boss-header, .boss-chat-header");

      if (!header) return;

      header.style.cursor = "move";

      let isDragging = false;
      let startX = 0,
        startY = 0;
      let initialX = panel.offsetLeft,
        initialY = panel.offsetTop;

      header.addEventListener("mousedown", (e) => {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        initialX = panel.offsetLeft;
        initialY = panel.offsetTop;
        panel.style.transition = "none";
        panel.style.zIndex = "2147483647";
      });

      document.addEventListener("mousemove", (e) => {
        if (!isDragging) return;

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        panel.style.left = `${initialX + dx}px`;
        panel.style.top = `${initialY + dy}px`;
        panel.style.right = "auto";
      });

      document.addEventListener("mouseup", () => {
        if (isDragging) {
          isDragging = false;
          panel.style.transition = "all 0.3s ease";
          panel.style.zIndex = "2147483646";
        }
      });
    },

    createMiniIcon() {
      document.getElementById("boss-mini-icon")?.remove();
      elements.miniIcon = document.createElement("div");
      elements.miniIcon.id = "boss-mini-icon";
      elements.miniIcon.style.cssText = `
        width: ${CONFIG.MINI_ICON_SIZE || 48}px;
        height: ${CONFIG.MINI_ICON_SIZE || 48}px;
        position: fixed;
        bottom: 40px;
        left: 40px;
        background: var(--primary-color);
        border-radius: 50%;
        box-shadow: 0 6px 16px rgba(var(--primary-rgb), 0.4);
        cursor: pointer;
        display: none;
        justify-content: center;
        align-items: center;
        color: #fff;
        z-index: 2147483647;
        transition: all 0.3s ease;
        overflow: hidden;

    `;

      const customSvg = `
        <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" 
            style="width: 100%; height: 100%; fill: white;">
            <path d="M512 116.032a160 160 0 0 1 52.224 311.232v259.008c118.144-22.272 207.552-121.088 207.552-239.36 0-25.152 21.568-45.568 48.128-45.568 26.624 0 48.128 20.416 48.128 45.632 0 184.832-158.848 335.232-354.048 335.232S160 631.808 160 446.976c0-25.152 21.568-45.632 48.128-45.632 26.624 0 48.128 20.48 48.128 45.632 0 118.144 89.088 216.96 206.976 239.296V428.416A160.064 160.064 0 0 1 512 116.032z m0 96a64 64 0 1 0 0 128 64 64 0 0 0 0-128z m-36.672 668.48l-21.888-19.584a17.92 17.92 0 0 0-24.64 0l-21.952 19.584a56.32 56.32 0 0 1-77.504 0l-21.952-19.584a17.92 17.92 0 0 0-24.64 0l-28.288 25.6c-9.6 8.704-23.36 6.4-30.72-4.992a29.696 29.696 0 0 1 4.16-36.672l28.352-25.6a56.32 56.32 0 0 1 77.568 0l21.888 19.584a17.92 17.92 0 0 0 24.704 0l21.824-19.52a56.32 56.32 0 0 1 77.568 0l21.888 19.52a17.92 17.92 0 0 0 24.64 0l21.952-19.52a56.32 56.32 0 0 1 77.504 0l21.952 19.52a17.92 17.92 0 0 0 24.64 0l21.824-19.52a56.32 56.32 0 0 1 77.632 0l21.824 19.52c9.664 8.704 11.52 25.152 4.224 36.672-7.296 11.52-21.12 13.696-30.72 4.992l-21.888-19.584a17.92 17.92 0 0 0-24.64 0l-21.888 19.584a56.32 56.32 0 0 1-77.568 0l-21.888-19.584a17.92 17.92 0 0 0-24.64 0l-21.888 19.584a57.408 57.408 0 0 1-38.656 15.488 58.176 58.176 0 0 1-38.784-15.488z" />
        </svg>
    `;

      elements.miniIcon.innerHTML = customSvg;

      elements.miniIcon.addEventListener("mouseenter", () => {
        elements.miniIcon.style.transform = "scale(1.1)";
        elements.miniIcon.style.boxShadow = `0 8px 20px rgba(var(--primary-rgb), 0.5)`;
      });

      elements.miniIcon.addEventListener("mouseleave", () => {
        elements.miniIcon.style.transform = "scale(1)";
        elements.miniIcon.style.boxShadow = `0 6px 16px rgba(var(--primary-rgb), 0.4)`;
      });

      elements.miniIcon.addEventListener("click", () => {
        state.ui.isMinimized = false;
        elements.panel.style.transform = "translateY(0)";
        elements.miniIcon.style.display = "none";
      });

      document.body.appendChild(elements.miniIcon);
    },

    _hexToRgb(hex) {
      hex = hex.replace("#", "");

      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);

      return `${r}, ${g}, ${b}`;
    },
  };

  const settings = {
    ai: {
      role: getAiRolePrompt(),
    },

    recruiterActivityStatus: getStoredStringArray("recruiterActivityStatus", ["不限"]),

    excludeHeadhunters: getStoredBoolean("excludeHeadhunters", false),

    useAiJobScreening: getStoredBoolean("useAiJobScreening", false),
  };

  function saveSettings() {
    setStorageItem("aiRole", settings.ai.role);

    setStorageItem(
      "recruiterActivityStatus",
      JSON.stringify(settings.recruiterActivityStatus)
    );

    setStorageItem(
      "excludeHeadhunters",
      settings.excludeHeadhunters.toString()
    );

    setStorageItem(
      "useAiJobScreening",
      settings.useAiJobScreening.toString()
    );

    if (state.settings) {
      state.settings.ai = {
        ...state.settings.ai,
        ...settings.ai,
      };
      state.settings.recruiterActivityStatus = settings.recruiterActivityStatus;
      state.settings.excludeHeadhunters = settings.excludeHeadhunters;
      state.settings.useAiJobScreening = settings.useAiJobScreening;
    }
  }

  function createSettingsDialog() {
    const dialog = document.createElement("div");
    dialog.id = "boss-settings-dialog";
    dialog.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: clamp(300px, 90vw, 550px);
        height: 80vh;
        background: #ffffff;
        border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.15);
        z-index: 999999;
        display: none;
        flex-direction: column;
        font-family: 'Segoe UI', sans-serif;
        overflow: hidden;
        transition: all 0.3s ease;
    `;

    dialog.innerHTML += `
        <style>
            #boss-settings-dialog {
                opacity: 0;
                transform: translate(-50%, -50%) scale(0.95);
            }
            #boss-settings-dialog.active {
                opacity: 1;
                transform: translate(-50%, -50%) scale(1);
            }
            .setting-item {
                transition: all 0.2s ease;
            }
            .setting-item:hover {
                background-color: rgba(0, 123, 255, 0.05);
            }
            .multi-select-container {
                position: relative;
                width: 100%;
                margin-top: 10px;
            }
            .multi-select-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px;
                border-radius: 8px;
                border: 1px solid #d1d5db;
                background: white;
                cursor: pointer;
                transition: all 0.2s ease;
            }
            .multi-select-header:hover {
                border-color: rgba(0, 123, 255, 0.7);
            }
            .multi-select-options {
                position: absolute;
                top: 100%;
                left: 0;
                right: 0;
                max-height: 200px;
                overflow-y: auto;
                border-radius: 8px;
                border: 1px solid #d1d5db;
                background: white;
                z-index: 100;
                box-shadow: 0 4px 10px rgba(0,0,0,0.1);
                display: none;
            }
            .multi-select-option {
                padding: 10px;
                cursor: pointer;
                transition: all 0.2s ease;
            }
            .multi-select-option:hover {
                background-color: rgba(0, 123, 255, 0.05);
            }
            .multi-select-option.selected {
                background-color: rgba(0, 123, 255, 0.1);
            }
            .multi-select-clear {
                color: #666;
                cursor: pointer;
                margin-left: 5px;
            }
            .multi-select-clear:hover {
                color: #333;
            }
        </style>
    `;

    const dialogHeader = createDialogHeader("AI-Boss海投助手·设置");

    const dialogContent = document.createElement("div");
    dialogContent.style.cssText = `
        padding: 18px;
        flex: 1;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: rgba(0, 123, 255, 0.5) rgba(0, 0, 0, 0.05);
    `;

    dialogContent.innerHTML += `
    <style>
        #boss-settings-dialog ::-webkit-scrollbar {
            width: 8px;
            height: 8px;
        }
        #boss-settings-dialog ::-webkit-scrollbar-track {
            background: rgba(0,0,0,0.05);
            border-radius: 10px;
            margin: 8px 0;
        }
        #boss-settings-dialog ::-webkit-scrollbar-thumb {
            background: rgba(0, 123, 255, 0.5);
            border-radius: 10px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            transition: all 0.2s ease;
        }
        #boss-settings-dialog ::-webkit-scrollbar-thumb:hover {
            background: rgba(0, 123, 255, 0.7);
            box-shadow: 0 1px 5px rgba(0,0,0,0.15);
        }
    </style>
    `;

    const tabsContainer = document.createElement("div");
    tabsContainer.style.cssText = `
        display: flex;
        border-bottom: 1px solid rgba(0, 123, 255, 0.2);
        margin-bottom: 20px;
    `;

    const aiTab = document.createElement("button");
    aiTab.textContent = "AI设置";
    aiTab.className = "settings-tab active";
    aiTab.style.cssText = `
        padding: 9px 15px;
        background: rgba(0, 123, 255, 0.9);
        color: white;
        border: none;
        border-radius: 8px 8px 0 0;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
        margin-right: 5px;
    `;

    const advancedTab = document.createElement("button");
    advancedTab.textContent = "高级设置";
    advancedTab.className = "settings-tab";
    advancedTab.style.cssText = `
        padding: 9px 15px;
        background: rgba(0, 0, 0, 0.05);
        color: #333;
        border: none;
        border-radius: 8px 8px 0 0;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
        margin-right: 5px;
    `;

    tabsContainer.append(aiTab, advancedTab);

    const aiSettingsPanel = document.createElement("div");
    aiSettingsPanel.id = "ai-settings-panel";

    const roleSettingResult = createSettingItem(
      "AI角色定位",
      "定义AI评估简历与判断岗位是否投递的标准",
      () => document.getElementById("ai-role-input")
    );

    const roleSetting = roleSettingResult.settingItem;

    const roleInput = document.createElement("textarea");
    roleInput.id = "ai-role-input";
    roleInput.rows = 5;
    roleInput.style.cssText = `
        width: 100%;
        padding: 12px;
        border-radius: 8px;
        border: 1px solid #d1d5db;
        resize: vertical;
        font-size: 14px;
        transition: all 0.2s ease;
        margin-top: 10px;
    `;

    addFocusBlurEffects(roleInput);
    roleSetting.append(roleInput);
    aiSettingsPanel.append(roleSetting);

    // 简历上传和分析设置
    const resumeUploadSettingResult = createSettingItem(
      "简历上传与AI分析",
      "上传简历文件(PDF/Word/TXT)，AI将分析简历用于岗位匹配评估",
      () => document.getElementById("resume-upload-container")
    );

    const resumeUploadSetting = resumeUploadSettingResult.settingItem;
    const resumeUploadContainer = document.createElement("div");
    resumeUploadContainer.id = "resume-upload-container";
    resumeUploadContainer.style.cssText = `
        width: 100%;
        margin-top: 10px;
    `;

    // 文件上传区域
    const fileUploadArea = document.createElement("div");
    fileUploadArea.style.cssText = `
        border: 2px dashed #d1d5db;
        border-radius: 8px;
        padding: 20px;
        text-align: center;
        background: #f9fafb;
        cursor: pointer;
        transition: all 0.3s ease;
    `;

    fileUploadArea.addEventListener("mouseenter", () => {
      fileUploadArea.style.borderColor = "#667eea";
      fileUploadArea.style.background = "#f0f4ff";
    });

    fileUploadArea.addEventListener("mouseleave", () => {
      fileUploadArea.style.borderColor = "#d1d5db";
      fileUploadArea.style.background = "#f9fafb";
    });

    // 隐藏的文件输入
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".pdf,.doc,.docx,.txt";
    fileInput.style.display = "none";

    // 上传图标和文字
    const uploadIcon = document.createElement("div");
    uploadIcon.innerHTML = "📄";
    uploadIcon.style.cssText = `
        font-size: 48px;
        margin-bottom: 10px;
    `;

    const uploadText = document.createElement("div");
    uploadText.textContent = "点击上传简历文件";
    uploadText.style.cssText = `
        font-size: 16px;
        color: #374151;
        margin-bottom: 5px;
    `;

    const uploadSubText = document.createElement("div");
    uploadSubText.textContent = "支持 PDF、Word、TXT 格式";
    uploadSubText.style.cssText = `
        font-size: 12px;
        color: #6b7280;
    `;

    const resumeFileNameDisplay = document.createElement("div");
    resumeFileNameDisplay.id = "resume-file-name";
    resumeFileNameDisplay.style.cssText = `
        margin-top: 10px;
        font-size: 13px;
        color: #667eea;
        font-weight: 500;
    `;

    fileUploadArea.append(uploadIcon, uploadText, uploadSubText, resumeFileNameDisplay);

    // 点击上传区域触发文件选择
    fileUploadArea.addEventListener("click", () => {
      fileInput.click();
    });

    // 文件选择处理
    fileInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      // 检查文件类型
      const validTypes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'];
      const validExtensions = ['.pdf', '.doc', '.docx', '.txt'];
      const fileExtension = '.' + file.name.split('.').pop().toLowerCase();
      
      if (!validTypes.includes(file.type) && !validExtensions.includes(fileExtension)) {
        showNotification("不支持的文件格式，请上传 PDF、Word 或 TXT 文件", "error");
        return;
      }

      // 检查文件大小 (最大10MB)
      if (file.size > 10 * 1024 * 1024) {
        showNotification("文件太大，请上传小于 10MB 的文件", "error");
        return;
      }

      resumeFileNameDisplay.textContent = `已选择: ${file.name}`;
      
      try {
        showNotification("正在读取文件内容...", "info");
        const result = await Core.readResumeFile(file);
        
        if (result.success) {
          // 保存简历文本（使用安全存储）
          state.settings.resumeText = result.text;
          const saveResult = setLargeItem("resumeText", result.text);
          
          // 显示在文本框中（可编辑）
          resumeTextArea.value = result.text;
          
          if (saveResult === 'truncated') {
            showNotification(`文件读取成功！共 ${result.text.length} 字符。（内容已截断以符合存储限制）`, "warning");
          } else if (saveResult === false) {
            showNotification(`文件读取成功！共 ${result.text.length} 字符。（无法保存到本地存储，但当前会话可用）`, "warning");
          } else {
            showNotification(`文件读取成功！共 ${result.text.length} 字符。点击 AI分析简历 进行分析`, "success");
          }
        } else {
          // 提取失败，显示部分内容和提示
          if (result.text && result.text.length > 0) {
            resumeTextArea.value = result.text + "\n\n" + result.message;
            showNotification("文件内容提取不完整，请检查文本框中的提示", "warning");
          } else {
            resumeTextArea.value = result.message;
            showNotification(result.message, "error");
          }
        }
      } catch (error) {
        showNotification("读取文件失败: " + error.message, "error");
      }
    });

    // 简历文本编辑区域（读取文件后可编辑）
    const resumeTextLabel = document.createElement("div");
    resumeTextLabel.textContent = "简历内容（可编辑）：";
    resumeTextLabel.style.cssText = `
        font-size: 14px;
        font-weight: 600;
        color: #374151;
        margin-top: 15px;
        margin-bottom: 8px;
    `;

    // 添加提示说明
    const pasteHint = document.createElement("div");
    pasteHint.innerHTML = `
      <div style="
        background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%);
        border: 1px solid #3b82f6;
        border-radius: 8px;
        padding: 12px 15px;
        margin-bottom: 12px;
        font-size: 13px;
        color: #1e40af;
        line-height: 1.6;
      ">
        <strong>💡 提示：</strong>如果文件上传失败，请直接打开简历文件，
        <kbd style="background:#fff;padding:2px 6px;border-radius:3px;border:1px solid #93c5fd;">Ctrl+A</kbd> 
        全选后 
        <kbd style="background:#fff;padding:2px 6px;border-radius:3px;border:1px solid #93c5fd;">Ctrl+C</kbd> 
        复制，然后粘贴到下方文本框中。
      </div>
    `;

    const resumeTextArea = document.createElement("textarea");
    resumeTextArea.id = "resume-text-input";
    resumeTextArea.placeholder = "请上传简历文件，或在此直接粘贴简历内容...\n\n如果PDF/Word文件上传后显示乱码，请直接复制粘贴文本内容到这里";
    resumeTextArea.value = state.settings.resumeText || "";
    resumeTextArea.style.cssText = `
        width: 100%;
        min-height: 200px;
        padding: 12px;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        font-size: 14px;
        resize: vertical;
        font-family: inherit;
        line-height: 1.5;
    `;

    // 按钮容器
    const resumeBtnContainer = document.createElement("div");
    resumeBtnContainer.style.cssText = `
        display: flex;
        gap: 10px;
        margin-top: 10px;
    `;

    // AI分析按钮
    const analyzeBtn = document.createElement("button");
    analyzeBtn.textContent = "AI分析简历";
    analyzeBtn.style.cssText = `
        flex: 1;
        padding: 10px 16px;
        border-radius: 6px;
        border: none;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        cursor: pointer;
        font-size: 14px;
        font-weight: 600;
        transition: all 0.3s ease;
    `;

    analyzeBtn.addEventListener("mouseenter", () => {
      analyzeBtn.style.transform = "translateY(-2px)";
      analyzeBtn.style.boxShadow = "0 4px 12px rgba(102, 126, 234, 0.4)";
    });

    analyzeBtn.addEventListener("mouseleave", () => {
      analyzeBtn.style.transform = "translateY(0)";
      analyzeBtn.style.boxShadow = "none";
    });

    analyzeBtn.addEventListener("click", async () => {
      const resumeText = resumeTextArea.value.trim();
      if (!resumeText) {
        showNotification("请先上传简历文件或输入简历内容", "error");
        return;
      }
      
      // 保存简历文本（使用安全存储）
      state.settings.resumeText = resumeText;
      const saveResult = setLargeItem("resumeText", resumeText);
      if (saveResult === 'truncated') {
        showNotification("简历内容已截断以符合存储限制", "warning");
      } else if (saveResult === false) {
        showNotification("无法保存到本地存储，但当前会话可用", "warning");
      }
      
      analyzeBtn.textContent = "🔄 分析中...";
      analyzeBtn.disabled = true;
      
      try {
        const analysis = await Core.analyzeResumeWithAI(resumeText);
        if (analysis) {
          state.settings.resumeAnalysis = analysis;
          setLargeItem("resumeAnalysis", analysis);
          analysisResultArea.value = analysis;
          showNotification("简历分析完成！", "success");
        }
      } catch (error) {
        showNotification("分析失败: " + error.message, "error");
      } finally {
        analyzeBtn.textContent = "🤖 AI分析简历";
        analyzeBtn.disabled = false;
      }
    });

    // 保存按钮
    const saveResumeBtn = document.createElement("button");
    saveResumeBtn.textContent = "保存简历";
    saveResumeBtn.style.cssText = `
        padding: 10px 16px;
        border-radius: 6px;
        border: 1px solid #10b981;
        background: rgba(16, 185, 129, 0.1);
        color: #10b981;
        cursor: pointer;
        font-size: 14px;
        font-weight: 600;
        transition: all 0.3s ease;
    `;

    saveResumeBtn.addEventListener("mouseenter", () => {
      saveResumeBtn.style.background = "rgba(16, 185, 129, 0.2)";
    });

    saveResumeBtn.addEventListener("mouseleave", () => {
      saveResumeBtn.style.background = "rgba(16, 185, 129, 0.1)";
    });

    saveResumeBtn.addEventListener("click", () => {
      state.settings.resumeText = resumeTextArea.value;
      const saveResult = setLargeItem("resumeText", resumeTextArea.value);
      if (saveResult === 'truncated') {
        showNotification("简历已保存（内容已截断以符合存储限制）", "warning");
      } else if (saveResult === false) {
        showNotification("无法保存到本地存储，但当前会话可用", "warning");
      } else {
        showNotification("简历已保存！", "success");
      }
    });

    resumeBtnContainer.append(analyzeBtn, saveResumeBtn);

    // 分析结果显示区域
    const analysisLabel = document.createElement("div");
    analysisLabel.textContent = "AI分析结果（用于岗位匹配评估）：";
    analysisLabel.style.cssText = `
        font-size: 14px;
        font-weight: 600;
        color: #374151;
        margin-top: 15px;
        margin-bottom: 8px;
    `;

    const analysisResultArea = document.createElement("textarea");
    analysisResultArea.id = "resume-analysis-result";
    analysisResultArea.placeholder = "AI分析结果将显示在这里...";
    analysisResultArea.value = state.settings.resumeAnalysis || "";
    analysisResultArea.style.cssText = `
        width: 100%;
        min-height: 100px;
        padding: 12px;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        font-size: 13px;
        resize: vertical;
        font-family: inherit;
        line-height: 1.5;
        background: #f9fafb;
    `;

    resumeUploadContainer.append(
      fileUploadArea,
      fileInput,
      pasteHint,
      resumeTextLabel,
      resumeTextArea,
      resumeBtnContainer,
      analysisLabel,
      analysisResultArea
    );
    resumeUploadSetting.append(resumeUploadContainer);
    aiSettingsPanel.append(resumeUploadSetting);

    const advancedSettingsPanel = document.createElement("div");
    advancedSettingsPanel.id = "advanced-settings-panel";
    advancedSettingsPanel.style.display = "none";

    const excludeHeadhuntersSettingResult = createSettingItem(
      "投递时排除猎头",
      "开启后将不会向猎头职位自动投递简历",
      () => document.querySelector("#toggle-exclude-headhunters input")
    );

    const excludeHeadhuntersSetting =
      excludeHeadhuntersSettingResult.settingItem;
    const excludeHeadhuntersDescriptionContainer =
      excludeHeadhuntersSettingResult.descriptionContainer;

    const excludeHeadhuntersToggle = createToggleSwitch(
      "exclude-headhunters",
      settings.excludeHeadhunters,
      (checked) => {
        settings.excludeHeadhunters = checked;
      },
      true
    );

    excludeHeadhuntersDescriptionContainer.append(excludeHeadhuntersToggle);

    const aiJobScreeningSettingResult = createSettingItem(
      "AI判断是否投递",
      "开启后会结合简历分析和职位描述判断岗位是否值得投递",
      () => document.querySelector("#toggle-ai-job-screening input")
    );

    const aiJobScreeningSetting =
      aiJobScreeningSettingResult.settingItem;
    const aiJobScreeningDescriptionContainer =
      aiJobScreeningSettingResult.descriptionContainer;

    const aiJobScreeningToggle = createToggleSwitch(
      "ai-job-screening",
      settings.useAiJobScreening,
      (checked) => {
        settings.useAiJobScreening = checked;
      },
      true
    );

    aiJobScreeningDescriptionContainer.append(aiJobScreeningToggle);

    const recruiterStatusSettingResult = createSettingItem(
      "投递招聘者状态（多选）",
      "筛选活跃状态符合要求的招聘者进行投递",
      () => document.querySelector("#recruiter-status-select .select-header")
    );

    const recruiterStatusSetting = recruiterStatusSettingResult.settingItem;

    const statusSelect = document.createElement("div");
    statusSelect.id = "recruiter-status-select";
    statusSelect.className = "custom-select";
    statusSelect.style.cssText = `
        position: relative;
        width: 100%;
        margin-top: 10px;
    `;

    const statusHeader = document.createElement("div");
    statusHeader.className = "select-header";
    statusHeader.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        border-radius: 8px;
        border: 1px solid #e2e8f0;
        background: white;
        cursor: pointer;
        transition: all 0.2s ease;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
        min-height: 44px;
    `;

    const statusDisplay = document.createElement("div");
    statusDisplay.className = "select-value";
    statusDisplay.style.cssText = `
        flex: 1;
        text-align: left;
        color: #334155;
        font-size: 14px;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    `;
    statusDisplay.textContent = getStatusDisplayText();

    const statusIcon = document.createElement("div");
    statusIcon.className = "select-icon";
    statusIcon.innerHTML = "&#9660;";
    statusIcon.style.cssText = `
        margin-left: 10px;
        color: #64748b;
        transition: transform 0.2s ease;
    `;

    const statusClear = document.createElement("button");
    statusClear.className = "select-clear";
    statusClear.innerHTML = "×";
    statusClear.style.cssText = `
        background: none;
        border: none;
        color: #94a3b8;
        cursor: pointer;
        font-size: 16px;
        margin-left: 8px;
        display: none;
        transition: color 0.2s ease;
    `;

    statusHeader.append(statusDisplay, statusClear, statusIcon);

    const statusOptions = document.createElement("div");
    statusOptions.className = "select-options";
    statusOptions.style.cssText = `
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        right: 0;
        max-height: 240px;
        overflow-y: auto;
        border-radius: 8px;
        border: 1px solid #e2e8f0;
        background: white;
        z-index: 100;
        box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
        display: none;
        transition: all 0.2s ease;
        scrollbar-width: thin;
        scrollbar-color: #cbd5e1 #f1f5f9;
    `;

    statusOptions.innerHTML += `
        <style>
            .select-options::-webkit-scrollbar {
                width: 6px;
            }
            .select-options::-webkit-scrollbar-track {
                background: #f1f5f9;
                border-radius: 10px;
            }
            .select-options::-webkit-scrollbar-thumb {
                background: #cbd5e1;
                border-radius: 10px;
            }
            .select-options::-webkit-scrollbar-thumb:hover {
                background: #94a3b8;
            }
        </style>
    `;

    const statusOptionsList = [
      { value: "不限", text: "不限" },
      { value: "在线", text: "在线" },
      { value: "刚刚活跃", text: "刚刚活跃" },
      { value: "今日活跃", text: "今日活跃" },
      { value: "3日内活跃", text: "3日内活跃" },
      { value: "本周活跃", text: "本周活跃" },
      { value: "本月活跃", text: "本月活跃" },
      { value: "半年前活跃", text: "半年前活跃" },
    ];

    statusOptionsList.forEach((option) => {
      const statusOption = document.createElement("div");
      statusOption.className =
        "select-option" +
        (settings.recruiterActivityStatus &&
          Array.isArray(settings.recruiterActivityStatus) &&
          settings.recruiterActivityStatus.includes(option.value)
          ? " selected"
          : "");
      statusOption.dataset.value = option.value;
      statusOption.style.cssText = `
            padding: 12px 16px;
            cursor: pointer;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            font-size: 14px;
            color: #334155;
        `;

      const checkIcon = document.createElement("span");
      checkIcon.className = "check-icon";
      checkIcon.innerHTML = "✓";
      checkIcon.style.cssText = `
            margin-right: 8px;
            color: rgba(0, 123, 255, 0.9);
            font-weight: bold;
            display: ${settings.recruiterActivityStatus &&
          Array.isArray(settings.recruiterActivityStatus) &&
          settings.recruiterActivityStatus.includes(option.value)
          ? "inline"
          : "none"
        };
        `;

      const textSpan = document.createElement("span");
      textSpan.textContent = option.text;

      statusOption.append(checkIcon, textSpan);

      statusOption.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleStatusOption(option.value);
      });

      statusOptions.appendChild(statusOption);
    });

    statusHeader.addEventListener("click", () => {
      statusOptions.style.display =
        statusOptions.style.display === "block" ? "none" : "block";
      statusIcon.style.transform =
        statusOptions.style.display === "block"
          ? "rotate(180deg)"
          : "rotate(0)";
    });

    statusClear.addEventListener("click", (e) => {
      e.stopPropagation();
      settings.recruiterActivityStatus = [];
      updateStatusOptions();
    });

    document.addEventListener("click", (e) => {
      if (!statusSelect.contains(e.target)) {
        statusOptions.style.display = "none";
        statusIcon.style.transform = "rotate(0)";
      }
    });

    statusHeader.addEventListener("mouseenter", () => {
      statusHeader.style.borderColor = "rgba(0, 123, 255, 0.5)";
      statusHeader.style.boxShadow = "0 0 0 3px rgba(0, 123, 255, 0.1)";
    });

    statusHeader.addEventListener("mouseleave", () => {
      if (!statusHeader.contains(document.activeElement)) {
        statusHeader.style.borderColor = "#e2e8f0";
        statusHeader.style.boxShadow = "0 1px 2px rgba(0, 0, 0, 0.05)";
      }
    });

    statusHeader.addEventListener("focus", () => {
      statusHeader.style.borderColor = "rgba(0, 123, 255, 0.7)";
      statusHeader.style.boxShadow = "0 0 0 3px rgba(0, 123, 255, 0.2)";
    });

    statusHeader.addEventListener("blur", () => {
      statusHeader.style.borderColor = "#e2e8f0";
      statusHeader.style.boxShadow = "0 1px 2px rgba(0, 0, 0, 0.05)";
    });

    statusSelect.append(statusHeader, statusOptions);
    recruiterStatusSetting.append(statusSelect);

    advancedSettingsPanel.append(
      excludeHeadhuntersSetting,
      aiJobScreeningSetting,
      recruiterStatusSetting
    );

    aiTab.addEventListener("click", () => {
      setActiveTab(aiTab, aiSettingsPanel);
    });

    advancedTab.addEventListener("click", () => {
      setActiveTab(advancedTab, advancedSettingsPanel);
    });

    const dialogFooter = document.createElement("div");
    dialogFooter.style.cssText = `
        padding: 15px 20px;
        border-top: 1px solid #e5e7eb;
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        background: rgba(0, 0, 0, 0.03);
    `;

    const cancelBtn = createTextButton("取消", "#e5e7eb", () => {
      dialog.style.display = "none";
    });

    const saveBtn = createTextButton(
      "保存设置",
      "rgba(0, 123, 255, 0.9)",
      () => {
        try {
          const aiRoleInput = document.getElementById("ai-role-input");
          settings.ai.role = aiRoleInput
            ? aiRoleInput.value.trim() || DEFAULT_AI_ROLE_PROMPT
            : DEFAULT_AI_ROLE_PROMPT;

          saveSettings();

          showNotification("设置已保存");
          dialog.style.display = "none";
        } catch (error) {
          showNotification("保存失败: " + error.message, "error");
          console.error("保存设置失败:", error);
        }
      }
    );

    dialogFooter.append(cancelBtn, saveBtn);

    dialogContent.append(
      tabsContainer,
      aiSettingsPanel,
      advancedSettingsPanel
    );
    dialog.append(dialogHeader, dialogContent, dialogFooter);

    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) {
        dialog.style.display = "none";
      }
    });

    return dialog;
  }

  function showSettingsDialog() {
    let dialog = document.getElementById("boss-settings-dialog");
    if (!dialog) {
      dialog = createSettingsDialog();
      document.body.appendChild(dialog);
    }

    dialog.style.display = "flex";

    setTimeout(() => {
      dialog.classList.add("active");
      setTimeout(loadSettingsIntoUI, 100);
    }, 10);
  }

  function toggleStatusOption(value) {
    if (value === "不限") {
      settings.recruiterActivityStatus =
        settings.recruiterActivityStatus.includes("不限") ? [] : ["不限"];
    } else {
      if (settings.recruiterActivityStatus.includes("不限")) {
        settings.recruiterActivityStatus = [value];
      } else {
        if (settings.recruiterActivityStatus.includes(value)) {
          settings.recruiterActivityStatus =
            settings.recruiterActivityStatus.filter((v) => v !== value);
        } else {
          settings.recruiterActivityStatus.push(value);
        }

        if (settings.recruiterActivityStatus.length === 0) {
          settings.recruiterActivityStatus = ["不限"];
        }
      }
    }

    if (state.settings) {
      state.settings.recruiterActivityStatus = settings.recruiterActivityStatus;
    }

    updateStatusOptions();
  }

  function updateStatusOptions() {
    const options = document.querySelectorAll(
      "#recruiter-status-select .select-option"
    );
    options.forEach((option) => {
      const isSelected = settings.recruiterActivityStatus.includes(
        option.dataset.value
      );
      option.className = "select-option" + (isSelected ? " selected" : "");
      option.querySelector(".check-icon").style.display = isSelected
        ? "inline"
        : "none";

      if (option.dataset.value === "不限") {
        if (isSelected) {
          options.forEach((opt) => {
            if (opt.dataset.value !== "不限") {
              opt.className = "select-option";
              opt.querySelector(".check-icon").style.display = "none";
            }
          });
        }
      } else if (settings.recruiterActivityStatus.includes("不限")) {
        option.querySelector(".check-icon").style.display = "none";
        option.className = "select-option";
      }
    });

    document.querySelector(
      "#recruiter-status-select .select-value"
    ).textContent = getStatusDisplayText();

    document.querySelector(
      "#recruiter-status-select .select-clear"
    ).style.display =
      settings.recruiterActivityStatus.length > 0 &&
        !settings.recruiterActivityStatus.includes("不限")
        ? "inline"
        : "none";

    if (state.settings) {
      state.settings.recruiterActivityStatus = settings.recruiterActivityStatus;
    }
  }

  function getStatusDisplayText() {
    if (settings.recruiterActivityStatus.includes("不限")) {
      return "不限";
    }

    if (settings.recruiterActivityStatus.length === 0) {
      return "请选择";
    }

    if (settings.recruiterActivityStatus.length <= 2) {
      return settings.recruiterActivityStatus.join("、");
    }

    return `${settings.recruiterActivityStatus[0]}、${settings.recruiterActivityStatus[1]}等${settings.recruiterActivityStatus.length}项`;
  }

  function createDialogHeader(title) {
    const header = document.createElement("div");
    header.style.cssText = `
        padding: 20px 24px;
        background: #4285f4;
        color: white;
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-shrink: 0;
    `;

    const titleElement = document.createElement("div");
    titleElement.textContent = title;
    titleElement.style.cssText = "font-size: 18px; font-weight: 600;";

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.style.cssText =
      "width: 32px; height: 32px; border-radius: 50%; border: none; background: rgba(255,255,255,0.2); color: white; font-size: 24px; cursor: pointer;";
    closeBtn.addEventListener("click", () => {
      const dialog = closeBtn.closest("#boss-settings-dialog, #boss-ai-config-dialog");
      if (dialog) dialog.style.display = "none";
    });

    header.append(titleElement, closeBtn);
    return header;
  }

  function createSettingItem(title, description, controlGetter) {
    const settingItem = document.createElement("div");
    settingItem.className = "setting-item";
    settingItem.style.cssText = `
        padding: 20px 22px;
        border: 1px solid #dbeafe;
        border-radius: 10px;
        margin-bottom: 18px;
        background: #ffffff;
    `;

    const titleElement = document.createElement("div");
    titleElement.textContent = title;
    titleElement.style.cssText = "font-size: 17px; font-weight: 600; color: #333; margin-bottom: 6px;";

    const descElement = document.createElement("div");
    descElement.textContent = description;
    descElement.style.cssText = "font-size: 13px; color: #666; margin-bottom: 10px;";

    const descriptionContainer = document.createElement("div");
    descriptionContainer.style.cssText = "width: 100%;";
    descriptionContainer.append(titleElement, descElement);

    settingItem.append(descriptionContainer);
    settingItem.addEventListener("click", () => {
      const control = controlGetter?.();
      if (control && typeof control.focus === "function") control.focus();
    });

    return { settingItem, descriptionContainer };
  }

  function addFocusBlurEffects(element) {
    element.addEventListener("focus", () => {
      element.style.borderColor = "#4285f4";
      element.style.boxShadow = "0 0 0 3px rgba(66,133,244,0.15)";
    });
    element.addEventListener("blur", () => {
      element.style.borderColor = "#d1d5db";
      element.style.boxShadow = "none";
    });
  }

  function createToggleSwitch(id, isChecked, onChange) {
    const container = document.createElement("div");
    container.className = "toggle-container";
    container.style.cssText = "display: flex; justify-content: flex-end; align-items: center;";

    const switchContainer = document.createElement("div");
    switchContainer.className = "toggle-switch";
    switchContainer.style.cssText = `
        position: relative;
        width: 50px;
        height: 26px;
        border-radius: 13px;
        background-color: ${isChecked ? "rgba(0, 123, 255, 0.9)" : "#e5e7eb"};
        cursor: pointer;
    `;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = `toggle-${id}`;
    checkbox.checked = isChecked;
    checkbox.style.display = "none";

    const slider = document.createElement("span");
    slider.className = "toggle-slider";
    slider.style.cssText = `
        position: absolute;
        top: 3px;
        left: ${isChecked ? "27px" : "3px"};
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background-color: white;
        box-shadow: 0 1px 3px rgba(0,0,0,0.2);
    `;

    const forceUpdateUI = (checked) => {
      checkbox.checked = checked;
      switchContainer.style.backgroundColor = checked
        ? "rgba(0, 123, 255, 0.9)"
        : "#e5e7eb";
      slider.style.left = checked ? "27px" : "3px";
    };

    switchContainer.addEventListener("click", () => {
      const newState = !checkbox.checked;
      if (onChange?.(newState) !== false) forceUpdateUI(newState);
    });

    switchContainer.append(checkbox, slider);
    container.append(switchContainer);
    return container;
  }

  function createTextButton(text, backgroundColor, onClick) {
    const button = document.createElement("button");
    button.textContent = text;
    button.style.cssText = `
        padding: 10px 20px;
        border: none;
        border-radius: 8px;
        background: ${backgroundColor};
        color: ${backgroundColor === "#e5e7eb" ? "#333" : "white"};
        cursor: pointer;
        font-size: 14px;
        font-weight: 600;
    `;
    button.addEventListener("click", onClick);
    return button;
  }

  function setActiveTab(activeTab, activePanel) {
    document.querySelectorAll(".settings-tab").forEach((tab) => {
      tab.style.background = "rgba(0, 0, 0, 0.05)";
      tab.style.color = "#333";
      tab.classList.remove("active");
    });
    document.querySelectorAll("#ai-settings-panel, #advanced-settings-panel").forEach((panel) => {
      panel.style.display = "none";
    });
    activeTab.style.background = "rgba(0, 123, 255, 0.9)";
    activeTab.style.color = "white";
    activeTab.classList.add("active");
    activePanel.style.display = "block";
  }

  function showNotification(message, type = "info") {
    const colors = {
      success: "#16a34a",
      error: "#dc2626",
      warning: "#d97706",
      info: "#2563eb",
    };
    const notice = document.createElement("div");
    notice.textContent = message;
    notice.style.cssText = `
        position: fixed;
        top: 24px;
        right: 24px;
        z-index: 2147483647;
        background: ${colors[type] || colors.info};
        color: white;
        padding: 10px 14px;
        border-radius: 8px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.18);
        font-size: 13px;
        max-width: 360px;
    `;
    document.body.appendChild(notice);
    setTimeout(() => notice.remove(), 2500);
    if (typeof Core !== "undefined") Core.log(message);
  }

  function showAiConfigDialog() {
    let dialog = document.getElementById("boss-ai-config-dialog");
    if (!dialog) {
      dialog = createAiConfigDialog();
      document.body.appendChild(dialog);
    }
    dialog.style.display = "flex";
  }

  function createAiConfigDialog() {
    const dialog = document.createElement("div");
    dialog.id = "boss-ai-config-dialog";
    dialog.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: clamp(360px, 90vw, 520px);
        max-height: 85vh;
        background: #ffffff;
        border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.2);
        z-index: 2147483647;
        display: none;
        flex-direction: column;
        overflow: hidden;
        font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
    `;

    const header = createDialogHeader("AI配置");
    const body = document.createElement("div");
    body.style.cssText = "padding: 20px; overflow-y: auto;";
    body.innerHTML = `
      <p style="color:#666;font-size:13px;margin:0 0 16px;">配置你自己的 AI API，支持 OpenAI、DeepSeek、硅基流动、火山引擎等兼容接口</p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px;">
        <button class="ai-preset-btn" data-url="https://api.siliconflow.cn/v1/chat/completions" data-model="deepseek-ai/DeepSeek-V2.5">硅基流动</button>
        <button class="ai-preset-btn" data-url="https://ark.cn-beijing.volces.com/api/v3/chat/completions" data-model="doubao-lite-4k">火山引擎</button>
        <button class="ai-preset-btn" data-url="https://api.openai.com/v1/chat/completions" data-model="gpt-4o-mini">OpenAI</button>
        <button class="ai-preset-btn" data-url="https://api.deepseek.com/v1/chat/completions" data-model="deepseek-chat">DeepSeek</button>
      </div>
      <label style="display:block;margin-bottom:6px;">API Key：</label>
      <input id="ai-api-key" type="password" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;margin-bottom:14px;">
      <label style="display:block;margin-bottom:6px;">API URL：</label>
      <input id="ai-api-url" type="text" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;margin-bottom:14px;">
      <label style="display:block;margin-bottom:6px;">模型名称：</label>
      <input id="ai-model" type="text" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;margin-bottom:18px;">
      <div style="display:flex;gap:10px;">
        <button id="ai-test-btn" style="flex:1;padding:12px;border:none;border-radius:8px;background:#16a34a;color:white;font-weight:600;cursor:pointer;">测试连接</button>
        <button id="ai-save-btn" style="flex:1;padding:12px;border:none;border-radius:8px;background:#4285f4;color:white;font-weight:600;cursor:pointer;">保存配置</button>
      </div>
      <div id="ai-config-status" style="margin-top:12px;font-size:12px;color:#666;min-height:16px;text-align:center;"></div>
    `;

    dialog.append(header, body);

    const apiKeyInput = body.querySelector("#ai-api-key");
    const apiUrlInput = body.querySelector("#ai-api-url");
    const modelInput = body.querySelector("#ai-model");
    const statusDiv = body.querySelector("#ai-config-status");
    const savedAiConfig = getAiConfig();
    apiKeyInput.value = savedAiConfig.apiKey;
    apiUrlInput.value = savedAiConfig.apiUrl;
    modelInput.value = savedAiConfig.model;

    body.querySelectorAll(".ai-preset-btn").forEach((btn) => {
      btn.style.cssText = "padding:8px 12px;border:1px solid #d1d5db;border-radius:8px;background:#f8fafc;cursor:pointer;";
      btn.addEventListener("click", () => {
        apiUrlInput.value = btn.dataset.url;
        modelInput.value = btn.dataset.model;
        statusDiv.textContent = `已选择：${btn.textContent}`;
      });
    });

    body.querySelector("#ai-test-btn").addEventListener("click", async () => {
      const apiKey = apiKeyInput.value.trim();
      const apiUrl = apiUrlInput.value.trim();
      const model = modelInput.value.trim();
      if (!apiKey || !apiUrl || !model) {
        statusDiv.textContent = "请填写完整的 API 配置";
        statusDiv.style.color = "#dc2626";
        return;
      }
      const normalizedApiUrl = normalizeApiUrl(apiUrl);
      if (!normalizedApiUrl) {
        statusDiv.textContent = "API URL 必须是有效的 HTTP(S) 地址";
        statusDiv.style.color = "#dc2626";
        return;
      }

      statusDiv.textContent = "正在测试 API 连接...";
      const result = await testAiConnection(apiKey, normalizedApiUrl, model);
      statusDiv.textContent = result.success ? `连接成功：${result.message}` : `连接失败：${result.message}`;
      statusDiv.style.color = result.success ? "#16a34a" : "#dc2626";
    });

    body.querySelector("#ai-save-btn").addEventListener("click", () => {
      const apiKey = apiKeyInput.value.trim();
      const apiUrl = apiUrlInput.value.trim();
      const model = modelInput.value.trim();
      const normalizedApiUrl = normalizeApiUrl(apiUrl);
      if (apiUrl && !normalizedApiUrl) {
        statusDiv.textContent = "API URL 必须是有效的 HTTP(S) 地址";
        statusDiv.style.color = "#dc2626";
        return;
      }

      if (apiKey) setSecureConfigItem("aiApiKey", apiKey);
      if (normalizedApiUrl) setSecureConfigItem("aiApiUrl", normalizedApiUrl);
      if (model) setSecureConfigItem("aiModel", model);
      state.settings.ai = {
        ...state.settings.ai,
        ...getAiConfig(),
      };
      statusDiv.textContent = "配置已保存";
      statusDiv.style.color = "#16a34a";
      setTimeout(() => (dialog.style.display = "none"), 700);
    });

    return dialog;
  }

  function testAiConnection(apiKey, apiUrl, model) {
    return new Promise((resolve) => {
      const normalizedApiUrl = normalizeApiUrl(apiUrl);
      if (!normalizedApiUrl) {
        resolve({ success: false, message: "API URL 无效" });
        return;
      }
      if (typeof GM_xmlhttpRequest !== "function") {
        resolve({ success: false, message: "当前脚本管理器不支持跨域请求" });
        return;
      }

      GM_xmlhttpRequest({
        method: "POST",
        url: normalizedApiUrl,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        data: JSON.stringify({
          model,
          messages: [{ role: "user", content: "请回复：连接成功" }],
          max_tokens: 20,
        }),
        timeout: CONFIG.API.TIMEOUT,
        onload: (response) => {
          try {
            const result = parseJsonSafely(response.responseText);
            if (response.status < 200 || response.status >= 300) {
              const fallbackMessage = String(response.responseText || "").trim().slice(0, 160);
              resolve({ success: false, message: result?.error?.message || fallbackMessage || `HTTP ${response.status}` });
              return;
            }
            if (!result) {
              resolve({ success: false, message: "AI响应不是有效JSON" });
              return;
            }
            const message =
              result.choices?.[0]?.message?.content ||
              result.choices?.[0]?.text ||
              "模型已响应";
            resolve({ success: true, message: String(message).trim() });
          } catch (error) {
            resolve({ success: false, message: error.message });
          }
        },
        onerror: () => resolve({ success: false, message: "网络请求失败" }),
        ontimeout: () => resolve({ success: false, message: "请求超时" }),
      });
    });
  }

  const Core = {
    isActive(runId) {
      return state.isRunning && state.runId === runId;
    },

    async startProcessing(runId) {
      if (!location.pathname.includes("/jobs")) {
        this.log("瘦身版仅保留职位页海投流程，请打开职位页面使用");
        stopProcessing();
        return;
      }

      await this.autoScrollJobList(runId);
      if (!this.isActive(runId)) return;

      while (this.isActive(runId)) {
        await this.processJobList(runId);
        if (!this.isActive(runId)) break;
        await this.delay(CONFIG.BASIC_INTERVAL);
      }
    },

    async autoScrollJobList(runId) {
      const maxHistory = 3;
      const cardCountHistory = [];

      for (let i = 0; i < 8 && this.isActive(runId); i++) {
        window.scrollTo({
          top: document.documentElement.scrollHeight,
          behavior: "smooth",
        });
        await this.delay(CONFIG.BASIC_INTERVAL);
        if (!this.isActive(runId)) return;
        cardCountHistory.push(getJobCardsFromPage().length);
        if (cardCountHistory.length > maxHistory) cardCountHistory.shift();
        if (
          cardCountHistory.length === maxHistory &&
          new Set(cardCountHistory).size === 1
        ) {
          this.log("当前页面岗位加载完成，开始沟通");
          break;
        }
      }

      window.scrollTo({ top: 0, behavior: "smooth" });
      await this.delay(500);
    },

    async scrollToLoadMoreJobs(runId) {
      const viewportHeight = window.innerHeight;
      for (let i = 0; i < 3 && this.isActive(runId); i++) {
        const currentScroll = window.scrollY || document.documentElement.scrollTop;
        window.scrollTo({
          top: currentScroll + viewportHeight * 0.8,
          behavior: "smooth",
        });
        this.log(`正在加载更多职位... (${i + 1}/3)`);
        await this.delay(1000);
      }
      if (!this.isActive(runId)) return;
      window.scrollTo({ top: 0, behavior: "smooth" });
      await this.delay(500);
    },

    async processJobList(runId) {
      if (!this.isActive(runId)) return;
      const activeStatusFilter = settings.recruiterActivityStatus;

      if (!state.jobList || state.jobList.length === 0) {
        const excludeHeadhunters = settings.excludeHeadhunters;
        await this.scrollToLoadMoreJobs(runId);
        if (!this.isActive(runId)) return;

        const allJobCards = getJobCardsFromPage();
        const filterFailures = [];
        state.jobList = [];

        allJobCards.forEach((card, index) => {
          const jobInfo = collectJobCardFilterInfo(card, index);
          const failures = getJobFilterFailures(jobInfo, excludeHeadhunters);
          if (failures.length) {
            filterFailures.push({ jobInfo, failures });
            return;
          }
          state.jobList.push(card);
        });

        this.log(
          `职位卡片识别：共 ${allJobCards.length} 个，硬规则通过 ${state.jobList.length} 个，排除 ${filterFailures.length} 个`
        );

        if (!allJobCards.length) {
          this.log("没有识别到职位卡片：可能是页面列表还没加载完成，或BOSS页面结构变化导致选择器失效");
          stopProcessing();
          return;
        }

        const summary = summarizeFilterFailures(filterFailures);
        if (summary) this.log(`硬规则排除统计：${summary}`);

        if (!state.jobList.length) {
          const aiStatus = settings.useAiJobScreening
            ? "AI判断已开启，但当前没有通过硬规则的职位，因此还未进入AI判断"
            : "AI判断已关闭，本次失败来自硬规则筛选";
          this.log(`没有符合条件的职位：${aiStatus}`);

          filterFailures.slice(0, 12).forEach(({ jobInfo, failures }) => {
            this.log(
              `排除原因：${formatJobForLog(jobInfo)}；${failures
                .map((failure) => failure.message)
                .join("；")}`
            );
          });

          if (filterFailures.length > 12) {
            this.log(`还有 ${filterFailures.length - 12} 个职位被排除，以上仅展示前 12 个`);
          }
          stopProcessing();
          return;
        }

        this.log(`已加载 ${state.jobList.length} 个符合条件的职位`);
      }

      if (state.currentIndex >= state.jobList.length) {
        await this.resetCycle(runId);
        return;
      }

      const currentCard = state.jobList[state.currentIndex];
      currentCard.scrollIntoView({ behavior: "smooth", block: "center" });
      currentCard.click();
      await this.delay(CONFIG.OPERATION_INTERVAL * 2);
      if (!this.isActive(runId)) return;

      let activeTime = "未知";
      const onlineTag = document.querySelector(".boss-online-tag");
      if (onlineTag && onlineTag.textContent.trim() === "在线") {
        activeTime = "在线";
      } else {
        const activeTimeElement = document.querySelector(".boss-active-time");
        activeTime = activeTimeElement?.textContent?.trim() || "未知";
      }

      const isActiveStatusMatch =
        activeStatusFilter.includes("不限") || activeStatusFilter.includes(activeTime);
      if (!isActiveStatusMatch) {
        this.log(`跳过: 招聘者状态 "${activeTime}"`);
        state.currentIndex++;
        return;
      }

      const jobNumber = state.currentIndex + 1;
      const jobInfo = this.collectCurrentJobDetail(currentCard);

      if (settings.useAiJobScreening) {
        this.log(`AI正在判断岗位：${jobNumber}/${state.jobList.length} ${jobInfo.title || ""}`);
        const aiDecision = await this.evaluateJobWithAI({ ...jobInfo, activeTime });
        if (!this.isActive(runId)) return;

        if (aiDecision.fallback) {
          this.log(`AI判断不可用，按硬规则继续：${aiDecision.reason}`);
        } else if (!aiDecision.shouldApply) {
          const riskText = aiDecision.riskKeywords.length
            ? `，风险关键词：${aiDecision.riskKeywords.join("、")}`
            : "";
          this.log(`AI跳过岗位：${jobInfo.title || "未知岗位"}，${aiDecision.reason}${riskText}`);
          state.currentIndex++;
          return;
        } else {
          const matchedText = aiDecision.matchedSkills.length
            ? `，匹配技能：${aiDecision.matchedSkills.join("、")}`
            : "";
          this.log(`AI允许投递：${aiDecision.reason}，置信度${aiDecision.confidence}${matchedText}`);
        }
      }

      const includeLog = state.includeKeywords.length
        ? `职位名包含[${state.includeKeywords.join("、")}]`
        : "职位名不限";
      const titleExcludeLog = state.excludeTitleKeywords.length
        ? `职位名排除[${state.excludeTitleKeywords.join("、")}]`
        : "职位名不排除";
      const locationLog = state.locationKeywords.length
        ? `工作地包含[${state.locationKeywords.join("、")}]`
        : "工作地不限";
      const companyExcludeLog = state.excludeCompanyKeywords.length
        ? `排除公司[${state.excludeCompanyKeywords.join("、")}]`
        : "公司不限";
      this.log(
        `正在沟通：${jobNumber}/${state.jobList.length}，${includeLog}，${titleExcludeLog}，${locationLog}，${companyExcludeLog}，${getInternSalaryFilterLabel()}，招聘者"${activeTime}"`
      );
      state.currentIndex++;

      if (!this.isActive(runId)) return;
      const chatBtn = document.querySelector("a.op-btn-chat");
      if (chatBtn && chatBtn.textContent.trim() === "立即沟通") {
        chatBtn.click();
        await this.handleGreetingModal(runId);
      }
    },

    async handleGreetingModal(runId) {
      await this.delay(CONFIG.OPERATION_INTERVAL * 3);
      if (!this.isActive(runId)) return;
      const stayBtn = [...document.querySelectorAll(".default-btn.cancel-btn")].find(
        (button) => button.textContent.trim() === "留在此页"
      );
      if (stayBtn) {
        stayBtn.click();
        await this.delay(CONFIG.OPERATION_INTERVAL);
      }
    },

    getCurrentJobDetailRoot() {
      const selectors = [
        ".job-detail-box",
        ".job-detail-container",
        ".job-sec",
        ".job-detail",
        ".job-detail-wrap",
        ".job-detail-content",
      ];
      const candidates = selectors.flatMap((selector) =>
        Array.from(document.querySelectorAll(selector))
      );
      return (
        candidates.find((element) => {
          const text = this.cleanJobText(element.textContent);
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && text.length > 80;
        }) || document.body
      );
    },

    getFirstText(root, selectors) {
      for (const selector of selectors) {
        const cleaned = this.cleanJobText(root.querySelector(selector)?.textContent);
        if (cleaned) return cleaned;
      }
      return "";
    },

    collectCurrentJobDetail(card) {
      const root = this.getCurrentJobDetailRoot();
      const cardInfo = collectJobCardFilterInfo(card, 0);
      const title =
        this.getFirstText(root, [".job-name", ".job-title", ".job-detail-title", "h1"]) ||
        cardInfo.title;
      const salary = decodeBossSalaryText(
        this.getFirstText(root, [".salary", ".job-salary", ".job-limit .red", "[class*='salary']"]) ||
          cardInfo.salary
      );
      const company =
        this.getFirstText(root, [".company-name", ".company-info .name", "[class*='company-name']"]) ||
        cardInfo.company;
      const location =
        this.getFirstText(root, [".job-address-desc", ".job-location", ".job-area", "[class*='location']"]) ||
        cardInfo.location;
      const tags = [".job-tags span", ".tag-list span", ".job-detail-tags span"]
        .flatMap((selector) => Array.from(root.querySelectorAll(selector)))
        .map((element) => this.cleanJobText(element.textContent))
        .filter(Boolean);

      return {
        title,
        company,
        salary,
        location,
        tags: [...new Set(tags)].slice(0, 30),
        description: this.truncateForAi(root.textContent, 6000),
      };
    },

    parseAiJobScreeningResponse(responseText) {
      const parsed = parseJsonObjectFromText(responseText);
      const normalizeList = (value) => {
        if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
        if (typeof value === "string") {
          return value.split(/[，,、;；\n]/).map((item) => item.trim()).filter(Boolean);
        }
        return [];
      };

      const shouldApply = parsed.shouldApply === true || parsed.shouldApply === "true";
      const rawConfidence = Number(parsed.confidence) || 0;

      return {
        shouldApply,
        confidence: shouldApply ? Math.max(55, Math.min(rawConfidence, 100)) : rawConfidence,
        reason: String(parsed.reason || "").trim() || "AI未提供原因",
        riskKeywords: normalizeList(parsed.riskKeywords),
        matchedSkills: normalizeList(parsed.matchedSkills),
      };
    },

    async evaluateJobWithAI(jobInfo) {
      const { apiKey, apiUrl, model } = getAiConfig();
      const resumeText = state.settings.resumeText || "";
      const resumeAnalysis = state.settings.resumeAnalysis || "";
      const fallbackDecision = (reason) => ({
        shouldApply: true,
        confidence: 0,
        reason,
        riskKeywords: [],
        matchedSkills: [],
        fallback: true,
      });

      if (!apiKey || !apiUrl || !model) return fallbackDecision("AI API未配置");
      if (!resumeText.trim() && !resumeAnalysis.trim()) {
        return fallbackDecision("未找到简历内容或简历分析");
      }

      const screeningPrompt = `你是稳健、偏求职机会增长导向的岗位匹配审核助手。请判断候选人是否应该投递这个岗位。

请只返回JSON，不要输出Markdown、解释或多余文字。

候选人简历原文：
${this.truncateResumeText(resumeText, 3000) || "无"}

候选人简历分析：
${resumeAnalysis || "无"}

岗位信息：
职位名：${jobInfo.title || "未知"}
公司：${jobInfo.company || "未知"}
薪资：${jobInfo.salary || "未知"}
地点：${jobInfo.location || "未知"}
招聘者活跃状态：${jobInfo.activeTime || "未知"}
标签：${jobInfo.tags?.join("、") || "无"}
职位详情：
${this.truncateForAi(jobInfo.description, 5000) || "无"}

判断标准：
1. 采用稳健但不过度苛刻的匹配标准。只要岗位方向与候选人主线相关，或核心技能/项目经历有明确可迁移性，即使不是完全贴合，也可以返回 shouldApply=true。
2. 置信度低一点也可以投递：弱匹配但值得尝试时返回 shouldApply=true，confidence 给 55-70；中等匹配给 70-85；高度匹配给 85 以上。
3. 只有岗位明显偏基础设施、云原生底层、容器、虚拟化、DPU、编译器、分布式存储、网络、AIOps、基础软件、操作系统内核、硬件一体化等候选人主线明显不相关方向，才返回 shouldApply=false。
4. 普通加分项缺失、经验年限略偏高、职位描述较泛时，不要直接判为不投；可以降低 confidence，但仍建议投递。
5. 必须关注岗位对毕业年份、毕业时间、应届届别、在校生身份、实习转正时间等硬性要求；如果候选人的毕业年份或身份明显不符合，应返回 shouldApply=false。

返回JSON格式：
{
  "shouldApply": true或false,
  "confidence": 0到100的数字,
  "reason": "一句话说明判断原因",
  "riskKeywords": ["导致不适合的关键词，没有则为空数组"],
  "matchedSkills": ["匹配到的简历技能，没有则为空数组"]
}`;

      try {
        const response = await this.requestAi(screeningPrompt, {
          systemRole: getAiRolePrompt(),
          maxTokens: 700,
          temperature: 0.1,
          topP: 0.7,
        });
        return { ...this.parseAiJobScreeningResponse(response), fallback: false };
      } catch (error) {
        return fallbackDecision(`AI判断失败: ${error.message}`);
      }
    },

    async requestAi(message, options = {}) {
      const { apiKey, apiUrl, model } = getAiConfig();
      if (!apiKey || !apiUrl || !model) {
        this.log("未配置AI API，请先点击AI配置按钮设置API Key");
        throw new Error("未配置AI API");
      }
      const normalizedApiUrl = normalizeApiUrl(apiUrl);
      if (!normalizedApiUrl) {
        this.log("AI API URL无效，请重新配置");
        throw new Error("AI API URL无效");
      }
      if (typeof GM_xmlhttpRequest !== "function") {
        throw new Error("当前脚本管理器不支持跨域请求");
      }

      const messages = [{ role: "user", content: message }];
      if (!isSiliconFlowEndpoint(normalizedApiUrl)) {
        messages.unshift({
          role: "system",
          content: options.systemRole || getAiRolePrompt(),
        });
      }

      const requestBody = {
        model,
        messages,
        max_tokens: options.maxTokens || 512,
      };
      if (options.temperature !== undefined) requestBody.temperature = options.temperature;
      if (options.topP !== undefined) requestBody.top_p = options.topP;

      return new Promise((resolve, reject) => {
        let request = null;
        const clearCurrentRequest = () => {
          if (state.currentAiRequest === request) state.currentAiRequest = null;
        };
        const resolveOnce = (value) => {
          clearCurrentRequest();
          resolve(value);
        };
        const rejectOnce = (error) => {
          clearCurrentRequest();
          reject(error);
        };

        request = GM_xmlhttpRequest({
          method: "POST",
          url: normalizedApiUrl,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          data: JSON.stringify(requestBody),
          timeout: 30000,
          onload: (response) => {
            try {
              const result = parseJsonSafely(response.responseText);
              if (response.status < 200 || response.status >= 300) {
                const fallbackMessage = String(response.responseText || "").trim().slice(0, 160);
                rejectOnce(new Error(result?.error?.message || fallbackMessage || `HTTP ${response.status}`));
                return;
              }
              if (!result) {
                rejectOnce(new Error("AI响应不是有效JSON"));
                return;
              }
              const content =
                result.choices?.[0]?.message?.content ||
                result.choices?.[0]?.text ||
                result.data?.choices?.[0]?.message?.content;
              if (!content) {
                rejectOnce(new Error("AI响应格式异常"));
                return;
              }
              resolveOnce(content);
            } catch (error) {
              rejectOnce(error);
            }
          },
          onerror: () => rejectOnce(new Error("网络请求失败")),
          ontimeout: () => rejectOnce(new Error("请求超时")),
          onabort: () => rejectOnce(new Error("请求已停止")),
        });
        state.currentAiRequest = request;
      });
    },

    async readResumeFile(file) {
      const readAsArrayBuffer = () =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (event) => resolve(event.target.result);
          reader.onerror = () => reject(new Error("文件读取失败"));
          reader.readAsArrayBuffer(file);
        });

      try {
        const buffer = await readAsArrayBuffer();
        const text = this.extractLooseText(buffer);
        if (!text.trim()) {
          return {
            success: false,
            text: "",
            message: "未能提取到可用文本，请直接复制简历内容粘贴到文本框",
          };
        }
        return { success: true, text };
      } catch (error) {
        return { success: false, text: "", message: error.message };
      }
    },

    extractLooseText(arrayBuffer) {
      const decoders = ["utf-8", "gbk", "gb2312"];
      for (const encoding of decoders) {
        try {
          const text = new TextDecoder(encoding, { fatal: false }).decode(arrayBuffer);
          const cleaned = text
            .replace(/[^\x09\x0a\x0d\x20-\x7e\u4e00-\u9fa5，。；：、（）【】《》？！,.()\-+/#@%&=：]/g, " ")
            .replace(/\s{2,}/g, " ")
            .trim();
          if (cleaned.length > 50) return cleaned;
        } catch (_) {
          continue;
        }
      }
      return "";
    },

    truncateResumeText(resumeText, maxLength = 6000) {
      const text = String(resumeText || "").trim();
      if (text.length <= maxLength) return text;
      return `${text.slice(0, maxLength)}\n[简历内容已截断]`;
    },

    async analyzeResumeWithAI(resumeText) {
      this.log("正在使用AI分析简历...");
      const analysisPrompt = `请基于以下真实简历内容提取岗位匹配所需信息，重点包括：毕业年份/毕业时间/应届届别/在校生身份、求职方向、核心技能、项目经历、实习经历、学历、可投递岗位类型和明显不适合的岗位类型。\n\n简历内容：\n${this.truncateResumeText(resumeText, 6000)}`;
      return this.requestAi(analysisPrompt, {
        systemRole: "你是严格的简历分析助手，只基于简历原文总结，不编造信息。",
        maxTokens: 1200,
        temperature: 0.2,
      });
    },

    cleanJobText(text) {
      return String(text || "")
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    },

    truncateForAi(text, maxLength = 5000) {
      const cleaned = this.cleanJobText(text);
      if (cleaned.length <= maxLength) return cleaned;
      return `${cleaned.slice(0, maxLength)}\n[内容已截断]`;
    },

    async resetCycle(runId) {
      const cities = state.locationKeywords.filter((kw) => kw.trim() !== "");
      if (cities.length > 1 && state.currentCityIndex < cities.length - 1) {
        state.currentCityIndex++;
        const nextCity = cities[state.currentCityIndex];
        this.log(`切换到下一个城市: ${nextCity}`);
        await this.switchCity(nextCity);
        if (!this.isActive(runId)) return;
        state.jobList = [];
        state.currentIndex = 0;
        await this.delay(2500);
        return;
      }

      this.log("本轮职位处理完成");
      stopProcessing();
    },

    async switchCity(cityName) {
      try {
        const citySelector =
          document.querySelector(".city-label") ||
          document.querySelector(".city-select") ||
          document.querySelector("[class*='city']");
        if (citySelector) {
          citySelector.click();
          await this.delay(700);
        }

        const searchInput =
          document.querySelector(".city-search input") ||
          document.querySelector(".filter-city-search input") ||
          document.querySelector("input[placeholder*='城市']");
        if (searchInput) {
          searchInput.value = cityName;
          searchInput.dispatchEvent(new Event("input", { bubbles: true }));
          await this.delay(700);
        }

        const cityItems = document.querySelectorAll(
          ".city-item, .filter-city-item, [class*='city-list'] li"
        );
        for (const item of cityItems) {
          if (item.textContent.includes(cityName)) {
            item.click();
            this.log(`已切换到城市: ${cityName}`);
            return true;
          }
        }
      } catch (error) {
        this.log(`切换城市失败: ${error.message}`);
      }
      return false;
    },

    async simulateClick(element) {
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const eventOptions = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      element.dispatchEvent(new MouseEvent("mousedown", eventOptions));
      element.dispatchEvent(new MouseEvent("mouseup", eventOptions));
      element.dispatchEvent(new MouseEvent("click", eventOptions));
    },

    async waitForElement(selectorOrFunction, timeout = 5000) {
      const startTime = Date.now();
      while (Date.now() - startTime < timeout) {
        const element =
          typeof selectorOrFunction === "function"
            ? selectorOrFunction()
            : document.querySelector(selectorOrFunction);
        if (element) return element;
        await this.delay(100);
      }
      return null;
    },

    delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },

    log(message) {
      const logEntry = `[${new Date().toLocaleTimeString()}] ${message}`;
      const logPanel = document.querySelector("#pro-log");
      if (logPanel) {
        const logItem = document.createElement("div");
        logItem.className = "log-item";
        logItem.style.padding = "0px 8px";
        logItem.textContent = logEntry;
        logPanel.appendChild(logItem);
        logPanel.scrollTop = logPanel.scrollHeight;
      }
    },
  };

  function stopProcessing() {
    state.isRunning = false;
    state.runId++;
    state.currentIndex = 0;

    if (state.currentAiRequest?.abort) {
      try {
        state.currentAiRequest.abort();
      } catch (error) {
        console.warn("停止AI请求失败:", error);
      }
    }
    state.currentAiRequest = null;

    if (elements.controlBtn) {
      elements.controlBtn.textContent = "启动海投";
    }
  }

  async function toggleProcess() {
    if (state.isRunning) {
      stopProcessing();
      Core.log("已停止海投");
      return;
    }

    state.isRunning = true;
    const runId = ++state.runId;

    state.jobList = [];
    state.currentIndex = 0;
    state.currentCityIndex = 0;

    state.includeKeywords = parseKeywordList(elements.includeInput?.value || "");
    state.locationKeywords = parseKeywordList(elements.locationInput?.value || "");
    state.excludeTitleKeywords = parseKeywordList(elements.excludeTitleInput?.value || "");
    state.excludeCompanyKeywords = parseKeywordList(elements.excludeCompanyInput?.value || "");
    state.internSalaryMin = parseSalaryBound(elements.internSalaryMinInput?.value);
    state.internSalaryMax = parseSalaryBound(elements.internSalaryMaxInput?.value);

    if (
      state.internSalaryMin !== null &&
      state.internSalaryMax !== null &&
      state.internSalaryMin > state.internSalaryMax
    ) {
      const originalMin = state.internSalaryMin;
      state.internSalaryMin = state.internSalaryMax;
      state.internSalaryMax = originalMin;
    }

    setStorageItem("includeKeywords", JSON.stringify(state.includeKeywords));
    setStorageItem("locationKeywords", JSON.stringify(state.locationKeywords));
    setStorageItem("excludeTitleKeywords", JSON.stringify(state.excludeTitleKeywords));
    setStorageItem("excludeCompanyKeywords", JSON.stringify(state.excludeCompanyKeywords));
    setStorageItem("internSalaryMin", JSON.stringify(state.internSalaryMin));
    setStorageItem("internSalaryMax", JSON.stringify(state.internSalaryMax));

    elements.controlBtn.textContent = "停止海投";
    const logPanel = document.querySelector("#pro-log");
    if (logPanel) logPanel.replaceChildren();

    Core.log(`开始自动海投，时间：${new Date().toLocaleTimeString()}`);
    Core.log(
      `筛选条件：职位名包含【${state.includeKeywords.join("、") || "无"}】，职位名排除【${state.excludeTitleKeywords.join("、") || "无"}】，工作地包含【${state.locationKeywords.join("、") || "无"}】，排除公司【${state.excludeCompanyKeywords.join("、") || "无"}】，${getInternSalaryFilterLabel()}`
    );
    Core.log(
      `筛选开关：AI判断${settings.useAiJobScreening ? "开启" : "关闭"}，排除猎头${settings.excludeHeadhunters ? "开启" : "关闭"}，招聘者活跃状态【${settings.recruiterActivityStatus.join("、") || "不限"}】`
    );

    const firstCity = state.locationKeywords.find((kw) => kw.trim() !== "");
    if (firstCity) {
      Core.log(`准备切换到第一个城市: ${firstCity}`);
      await Core.switchCity(firstCity);
      if (!Core.isActive(runId)) return;
      await Core.delay(2000);
      if (!Core.isActive(runId)) return;
    }

    Core.startProcessing(runId);
  }

  function loadSettingsIntoUI() {
    const aiRoleInput = document.getElementById("ai-role-input");
    if (aiRoleInput) aiRoleInput.value = settings.ai.role;

    const excludeHeadhuntersInput = document.querySelector("#toggle-exclude-headhunters input");
    if (excludeHeadhuntersInput) {
      excludeHeadhuntersInput.checked = settings.excludeHeadhunters;
    }

    const aiJobScreeningInput = document.querySelector("#toggle-ai-job-screening input");
    if (aiJobScreeningInput) {
      aiJobScreeningInput.checked = settings.useAiJobScreening;
    }

    updateStatusOptions();
  }

  function init() {
    if (!location.pathname.includes("/jobs")) return;
    UI.init();
    document.body.style.position = "relative";
    Core.log("欢迎使用AI-Boss海投助手，我将自动投递岗位！");
  }

  window.addEventListener("load", init);

  let lastUrl = location.href;
  new MutationObserver(() => {
    const currentUrl = location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      if (location.pathname.includes("/jobs")) init();
    }
  }).observe(document, { subtree: true, childList: true });

})();

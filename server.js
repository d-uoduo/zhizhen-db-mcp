import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import puppeteer from "puppeteer-core";
import fs from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const HOME_URL = "https://ss.zhizhen.com/";
const SORT_CODES = { collection: "1", date_asc: "2", date_desc: "3", cited: "4", relevance: "6" };
const FIELD_CODES = { 全部字段: "Z", 主题: "Su", 题名: "T", 作者: "A", 摘要: "S", 关键词: "K", 作者单位: "O" };

const SEARCH_URL = (sw, { isort, field, year_from, year_to } = {}) => {
  const params = [];
  const fcode = (field && FIELD_CODES[field]) || null;
  const useAdv = !!fcode || year_from != null || year_to != null;
  if (useAdv) {
    const q = String(sw).replace(/['\[\]]/g, " ").replace(/\s+/g, " ").trim();
    let adv = `((${fcode || "Z"}='${q}'))`;
    if (year_from != null || year_to != null) {
      adv += `AND(${year_from ?? 1000}<Y<${year_to ?? 2027})`;
    }
    params.push("adv=" + encodeURIComponent(adv));
    params.push("aorp=a");
  } else {
    params.push("sw=" + encodeURIComponent(sw));
  }
  if (isort) params.push("isort=" + String(isort));
  return `https://ss.zhizhen.com/s?${params.join("&")}`;
};
const PORT = Number(process.env.ZHIZHEN_DEBUG_PORT || 9333);
const DEBUG_URL = `http://127.0.0.1:${PORT}/json/version`;
const HEADED = process.env.ZHIZHEN_HEADLESS !== "1";

const BASE_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const PROFILE_DIR = process.env.ZHIZHEN_PROFILE_DIR
  ? path.resolve(process.env.ZHIZHEN_PROFILE_DIR)
  : path.join(BASE_DIR, "browser-profile");
const CACHE_DIR = process.env.ZHIZHEN_CACHE_DIR
  ? path.resolve(process.env.ZHIZHEN_CACHE_DIR)
  : path.join("D:\\", "文献库", "zhizhen_cache");

const SEARCH_TTL_MS = 7 * 24 * 3600 * 1000;
const DETAIL_TTL_MS = 30 * 24 * 3600 * 1000;

const CHROME_CANDIDATES = [
  process.env.ZHIZHEN_CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);

let browser = null;
let page = null;
let profileUserAgent = null;

async function ensureDirs() {
  await fs.mkdir(path.join(CACHE_DIR, "search"), { recursive: true });
  await fs.mkdir(path.join(CACHE_DIR, "detail"), { recursive: true });
  await fs.mkdir(PROFILE_DIR, { recursive: true });
}

function findChrome() {
  return CHROME_CANDIDATES.find((p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function isDebuggerUp() {
  try {
    const res = await fetch(DEBUG_URL);
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBrowser() {
  if (browser?.connected) {
    if (!page || page.isClosed()) {
      page = await browser.newPage();
      await initPage();
    }
    return;
  }

  if (await isDebuggerUp()) {
    try {
      browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${PORT}`,
        defaultViewport: null,
      });
      page = (await browser.pages())[0] || (await browser.newPage());
      await initPage();
      return;
    } catch (err) {
      console.error(`[zhizhen] connect to running Chrome failed: ${err.message}`);
    }
  }

  const exe = findChrome();
  if (!exe) {
    throw new Error(
      "未找到本机 Chrome/Edge。请安装 Chrome，或用环境变量 ZHIZHEN_CHROME_PATH 指定 chrome.exe 路径。"
    );
  }
  await ensureDirs();
  const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE_DIR}`];
  if (HEADED) {
    args.push("--window-size=1440,900", "--window-position=120,80");
  } else {
    args.push("--headless=new");
  }
  const child = spawn(exe, args, { detached: true, stdio: "ignore" });
  child.unref();

  for (let i = 0; i < 60; i++) {
    if (await isDebuggerUp()) break;
    await sleep(500);
  }
  browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${PORT}`,
    defaultViewport: null,
  });
  page = (await browser.pages())[0] || (await browser.newPage());
  await initPage();
}

async function initPage() {
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(90000);
  try {
    profileUserAgent = await page.evaluate(() => navigator.userAgent);
  } catch {
    profileUserAgent = null;
  }
}

async function gotoTarget(url, opts = {}) {
  await ensureBrowser();
  const nav = page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  try {
    await nav;
  } catch {
    /* continue; some pages fire beforeunload dialogs */
  }
  await sleep(800);
  if (!page.url().includes("ss.zhizhen.com") && page.url().startsWith("http")) {
    throw new Error(`导航被跳转离开超星站点：${page.url()}。可能是 IP 不在校园网授权范围或需要登录。`);
  }
  return page.url();
}

function checkZhizhenAuth() {
  const inPage = (browser?.connected && page && !page.isClosed()) ? page : null;
  return inPage
    ? page.evaluate(() => {
        const body = document.body?.innerText || "";
        const m = body.match(/欢迎来自\s*([^\n\s|]+)[^\n]*/);
        return m ? m[1] : null;
      })
    : Promise.resolve(null);
}

/* ---------------- cache helpers ---------------- */

function hash(str) {
  return createHash("md5").update(str).digest("hex");
}

async function cacheGet(dir, key, ttlMs) {
  const file = path.join(CACHE_DIR, dir, `${hash(key)}.json`);
  try {
    const raw = await fs.readFile(file, "utf8");
    const data = JSON.parse(raw);
    if (Date.now() - (data._savedAt || 0) < ttlMs) return data;
  } catch {
    /* miss */
  }
  return null;
}

async function cachePut(dir, key, data) {
  const file = path.join(CACHE_DIR, dir, `${hash(key)}.json`);
  await ensureDirs();
  await fs.writeFile(file, JSON.stringify({ ...data, _savedAt: Date.now() }, null, 2), "utf8");
}

async function cacheList() {
  const out = [];
  for (const sub of ["search", "detail"]) {
    const dir = path.join(CACHE_DIR, sub);
    try {
      const files = await fs.readdir(dir);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        try {
          const raw = JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
          out.push({
            类型: sub,
            查询: raw.query || raw.title || "",
            记录数: raw.records ? raw.records.length : 1,
            抓取时间: new Date(raw._savedAt).toLocaleString("zh-CN"),
            文件: path.join(dir, f),
          });
        } catch { /* skip broken */ }
      }
    } catch { /* no dir yet */ }
  }
  return out;
}

/* ---------------- parsers (run inside page) ---------------- */

const SEARCH_PARSE_FN = () => {
  const norm = (s) =>
    (s || "").replace(/\u00A0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();

  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  const parseRow = (row) => {
    const right = row.querySelector(".zyList_right");
    const raw = norm(right?.innerText || "");
    const out = {};

    const card = right?.querySelector(".card_name");
    const typeM = (card?.innerText || "").match(/\[([^\]]+)\]/);
    if (typeM) out.类型 = typeM[1];

    const titleA = Array.from(right?.querySelectorAll("a") || []).find(
      (a) => /\/detail_/.test(a.getAttribute("href") || "") && !/#refdetail/.test(a.getAttribute("href") || "") && norm(a.innerText)
    );
    if (titleA) {
      out.标题 = norm(titleA.innerText);
      out.详情链接 = titleA.href.split("#")[0];
    }

    const FIELD_DISPLAY = {
      作者: "作者", 发明人: "发明人", 出处: "出处", 作者机构: "作者机构",
      申请号: "申请号", 申请日期: "申请日期", 申请人: "申请人", 公开号: "公开号",
      学位名称: "学位名称", 学位授予单位: "学位授予单位", 导师: "导师", 专业: "专业",
      主题词: "主题词", 关键词: "关键词", 摘要: "摘要", 获取: "获取",
      被引量: "被引量", 点击量: "点击量", isbn: "ISBN", issn: "ISSN",
      刊名: "刊名", 期刊名: "期刊名", 年份: "年份", 卷号: "卷号", 期号: "期号",
      页码: "页码", 专利类型: "专利类型", 分类号: "分类号", 基金: "基金",
      中图分类号: "中图分类号", 馆藏: "馆藏",
    };
    const SKIP = new Set(["收藏", "AI翻译", "更多", "全部展开", "收起", ""]);
    const lines = raw.split("\n").map((l) => l.trim());
    const canon = (l) => l.replace(/[：:\s]/g, "").toLowerCase();
    let cur = null;
    for (const line of lines) {
      if (SKIP.has(line)) {
        cur = null;
        continue;
      }
      const colonIdx = Math.min(
        line.indexOf("：") === -1 ? Infinity : line.indexOf("："),
        line.indexOf(":") === -1 ? Infinity : line.indexOf(":")
      );
      const prefix = colonIdx === Infinity ? line : line.slice(0, colonIdx);
      const disp =
        FIELD_DISPLAY[canon(line)] || FIELD_DISPLAY[canon(prefix)] || null;
      if (disp) {
        cur = { disp, parts: [] };
        out[disp] = cur;
        if (colonIdx !== Infinity && line.slice(colonIdx + 1).trim()) {
          cur.parts.push(line.slice(colonIdx + 1).trim());
        }
        continue;
      }
      if (cur) cur.parts.push(line);
      else cur = null;
    }
    for (const k of Object.keys(out)) {
      if (out[k] && Array.isArray(out[k].parts)) {
        const v = out[k].parts.join(" ").replace(/^[：:]+/, "").replace(/\s{2,}/g, " ").trim();
        if (v) out[k] = v;
        else delete out[k];
      }
    }
    const citedM = raw.match(/被引量[：:]\s*([\d,]+)/);
    const clickM = raw.match(/点击量[：:]\s*([\d,]+)/);
    if (citedM && !out.被引量) out.被引量 = citedM[1];
    if (clickM && !out.点击量) out.点击量 = clickM[1];
    if (typeof out.被引量 === "string" && /点击量/.test(out.被引量)) {
      out.被引量 = out.被引量.replace(/点击量[：:]\s*[\d,]+/g, "").trim();
    }
    const gtM = out.获取;
    if (gtM && /被引量|点击量/.test(gtM)) {
      out.获取 = gtM.replace(/被引量[：:]\s*[\d,]+\s*|点击量[：:]\s*[\d,]+/g, "").replace(/\s{2,}/g, " ").trim() || undefined;
      if (!out.获取) delete out.获取;
    }

    const goread = Array.from(row.querySelectorAll('a[href*="goread"]'))
      .filter(visible)
      .map((a) => ({ 来源: norm(a.innerText) || "全文", 链接: a.href }))
      .filter((x) => x.来源 && x.来源 !== "更多");
    if (goread.length) out.全文获取 = goread;
    return out;
  };

  const rows = Array.from(document.querySelectorAll(".searchLIst .zyList")).map(parseRow).filter((r) => r.标题);
  const body = norm(document.body.innerText);
  const totalM = body.match(/返回\s*([\d,]+)\s*条结果/);
  const tabs = {};
  document.querySelectorAll(".sort_bx h3").forEach((h) => {
    const t = norm(h.innerText).replace(/\n+/g, "").trim();
    const m = t.match(/^(.*?)\s*([\d,]+)\s*[（(]\S*/);
    if (m && m[1]) tabs[m[1].trim()] = parseInt(m[2].replace(/,/g, ""), 10);
    else if (t) tabs[t] = null;
  });
  return {
    rows,
    total: totalM ? parseInt(totalM[1].replace(/,/g, ""), 10) : null,
    typeCounts: tabs,
    url: location.href,
  };
};

const DETAIL_PARSE_FN = () => {
  const norm = (s) =>
    (s || "").replace(/\u00A0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const bodyFull = norm(document.body.innerText);

  const out = {
    页面标题: document.title.replace(/\s*_超星发现系统\s*$/, ""),
    网址: location.href,
  };

  const typeM = bodyFull.match(/\[([^\]]+)\]/);
  if (typeM) out.类型 = typeM[1];
  const citedM = bodyFull.match(/被引量[：:]\s*([\d,]+)/);
  const clickM = bodyFull.match(/点击量[：:]\s*([\d,]+)/);
  if (citedM) out.被引量 = citedM[1];
  if (clickM) out.点击量 = clickM[1];

  const TAIL_MARKERS = ["免责声明", "参考文献与引证文献", "相关文献", "全国馆藏", "知识关联",
    "你的专属学术AI助手", "编辑部相关信息", "共引期刊等", "参考期刊等", "引证期刊等", "引证图书（", "同被引"];
  let cut = Infinity;
  for (const mk of TAIL_MARKERS) {
    const i = bodyFull.indexOf(mk);
    if (i !== -1 && i < cut) cut = i;
  }
  const body = bodyFull.slice(0, cut);

  const FIELD_LABELS = new Set([
    "作者", "作者单位", "发明人", "申请人", "申请号", "申请日期", "公开号", "公开日期",
    "出处", "刊名", "期刊名", "影响因子", "年份", "卷号", "期号", "页码", "ISSN", "ISBN",
    "书名", "出版社", "学位名称", "学位授予单位", "导师", "专业",
    "授予年份", "主题词", "关键词", "分类号", "本科生分类", "研究生分类", "摘要", "基金",
    "重要收录", "专利类型", "代理机构", "法律状态", "DOI", "获取途径", "馆藏信息", "公开日期",
  ]);

  const lines = body.split("\n");
  const known = (l) => {
    const t = l.replace(/[：:]\s*$/, "").trim();
    if (FIELD_LABELS.has(t)) return t;
    if (t === "I S S N") return "ISSN";
    if (t === "I S B N") return "ISBN";
    return null;
  };
  let cur = null;
  for (const line of lines) {
    const k = known(line);
    if (k) {
      cur = k;
      if (!out[cur]) out[cur] = [];
      continue;
    }
    if (!cur) continue;
    const t = line.trim();
    if (!t || /^(全部展开|收起)$/.test(t)) continue;
    const bucket = out[cur];
    bucket.push(t);
  }
  for (const k of Object.keys(out)) {
    if (Array.isArray(out[k])) {
      let v = out[k].join("；").replace(/；+/g, "；").replace(/^；|；$/g, "").trim();
      v = v.replace(/(?:^|；)\s*(免责声明|更多)\s*/g, "；").replace(/；+/g, "；").replace(/^；|；$/g, "").trim();
      v = v.replace(/\s+免责声明[\s\S]*$/, "").trim();
      if (v) out[k] = v;
      else delete out[k];
    }
  }
  const gt = out.获取途径;
  if (typeof gt === "string") {
    out.获取途径 = gt.replace(/；?\s*更多\s*$/, "").trim() || undefined;
    if (!out.获取途径) delete out.获取途径;
  }

  const fulltext = Array.from(document.querySelectorAll('a[href*="goread"]'))
    .filter(visible)
    .map((a) => ({ 来源: norm(a.innerText) || "全文", 链接: a.href }))
    .filter((x) => x.来源 && x.来源 !== "更多");
  if (fulltext.length) out.全文获取 = fulltext;

  const refs = [];
  const allLines = bodyFull.split("\n").map((l) => l.trim());
  const inRefZone = allLines.filter((l) => /^\[\d+\]\s*/.test(l));
  if (inRefZone.length) out.引证或参考文献 = inRefZone.slice(0, 40);

  const authM = bodyFull.match(/欢迎来自\s*([^\n|]+?)\s*(?:\||$)/);
  if (authM) out.机构授权 = authM[1].trim();
  return out;
};

const TEXT_DUMP_FN = (max) => {
  const body = (document.body.innerText || "").replace(/\n{2,}/g, "\n").trim();
  return { url: location.href, title: document.title, text: body.slice(0, max) };
};

function isNavErr(e) {
  const m = String(e?.message || e || "");
  return /context was destroyed|context destroyed|execution context|Target closed|navigating to|navigation/.test(m);
}

async function evalRetry(fn, args, { tries = 4, waitMs = 900 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await page.evaluate(fn, ...(args || []));
    } catch (err) {
      lastErr = err;
      if (!isNavErr(err)) throw err;
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

async function waitForResultStable(prevText, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const now = await page.evaluate(() => {
        const el = document.querySelector(".searchLIst");
        return el ? el.innerText.slice(0, 300) : "";
      });
      if (now && now !== prevText) {
        await sleep(1400);
        return true;
      }
    } catch {
      /* mid-navigation, keep waiting */
    }
    await sleep(400);
  }
  return false;
}

async function expandAllAbstract() {
  try {
    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll("a, span, div, p")).filter(
        (el) => el.innerText?.trim() === "全部展开" && (el.offsetWidth || el.offsetHeight)
      );
      const el = els[0];
      if (el) {
        const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
        el.click && el.click();
      }
    });
    await sleep(700);
  } catch { /* noop */ }
}

async function pageFingerprint() {
  return page.evaluate(() => {
    const el = document.querySelector(".searchLIst");
    return el ? el.innerText.slice(0, 300) : "";
  });
}

/* ---------------- tool implementations ---------------- */

async function doSearch({ query, content_type, page_no, sort, field, year_from, year_to }) {
  const isort = sort && SORT_CODES[sort] ? SORT_CODES[sort] : null;
  const url = SEARCH_URL(query, { isort, field, year_from, year_to });
  await gotoTarget(url);

  if (content_type && content_type !== "全部") {
    const before = await pageFingerprint();
    const clicked = await page.evaluate((t) => {
      const hs = Array.from(document.querySelectorAll(".sort_bx h3"));
      const h = hs.find((x) => (x.innerText || "").trim().startsWith(t));
      if (!h) return false;
      h.click();
      return true;
    }, content_type);
    if (!clicked) {
      return { ok: false, error: `类型 Tab「${content_type}」不存在。可选：全部/期刊/图书/报纸/学位论文/会议论文/专利/标准 等` };
    }
    await waitForResultStable(before);
  }

  if (page_no > 1) {
    const before = await pageFingerprint();
    const ok = await page.evaluate((n) => {
      if (typeof pageUtil?.pages !== "function") return false;
      pageUtil.pages(String(n));
      return true;
    }, page_no);
    if (!ok) return { ok: false, error: "分页函数不可用" };
    await waitForResultStable(before);
  }

  await sleep(300);
  await expandAllAbstract();
  const parsed = await evalRetry(SEARCH_PARSE_FN);
  const org = await evalRetry(() => {
    const m = (document.body.innerText || "").match(/欢迎来自\s*([^\n|]+?)\s*(?:\||$)/);
    return m ? m[1].trim() : null;
  });
  const records = parsed.rows.map((r, i) => ({ 序号: i + 1, ...r }));

  return {
    ok: true,
    meta: {
      检索词: query,
      内容类型: content_type || "全部",
      排序: sort || "default",
      字段: field || "全部字段",
      ...(year_from != null || year_to != null
        ? { 年份范围: `${year_from ?? ""}~${year_to ?? ""}` }
        : {}),
      页码: page_no,
      总条数: parsed.total,
      各类型计数: parsed.typeCounts,
      机构: org,
      解析条数: records.length,
    },
    records,
  };
}

async function doDetail({ detail_url }) {
  await gotoTarget(detail_url);
  await sleep(400);
  await expandAllAbstract();
  const parsed = await evalRetry(DETAIL_PARSE_FN);
  return { ok: true, detail: parsed };
}

/* ---------------- compact output helpers ---------------- */

const SOURCE_KEYS = ["全文获取", "获取", "获取途径"];

function sourceNames(r) {
  const pick = SOURCE_KEYS.map((k) => r?.[k]).find((v) => Array.isArray(v) ? v.length : v);
  const names = [];
  if (Array.isArray(pick)) {
    pick.forEach((x) => x && x.来源 && names.push(String(x.来源)));
  } else if (typeof pick === "string") {
    names.push(...pick.split(/\s+/));
  }
  const uniq = [...new Set(names.map((n) => n.replace(/\s*更多\s*$/, "")).filter((n) => n && n !== "更多"))];
  return uniq.join("、");
}

function cleanDetailUrl(u) {
  return String(u || "").split("?")[0].split("#")[0];
}

function compactSearchRecord(r, includeLinks) {
  const o = {
    序号: r.序号,
    类型: r.类型,
    标题: r.标题,
    作者: r.作者 || r.发明人,
    出处: r.出处,
    年份: r.年份,
    关键词: r.关键词 || r.主题词,
    摘要: r.摘要,
    被引量: r.被引量,
    详情链接: cleanDetailUrl(r.详情链接) || undefined,
    全文来源: sourceNames(r) || undefined,
  };
  if (includeLinks && Array.isArray(r.全文获取) && r.全文获取.length) {
    o.全文链接 = r.全文获取;
  }
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

function buildSearchPayload(data, { limit, includeLinks, cachedAt } = {}) {
  const all = data.records || [];
  const records = all.map((r) => compactSearchRecord(r, includeLinks)).slice(0, limit ?? all.length);
  const meta = data.meta || {};
  const payload = {
    ok: true,
    检索词: meta.检索词 ?? data.query,
    内容类型: meta.内容类型 || "全部",
    排序: meta.排序 || "default",
    字段: meta.字段 || "全部字段",
    ...(meta.年份范围 ? { 年份范围: meta.年份范围 } : {}),
    页码: meta.页码 || 1,
    总条数: meta.总条数 ?? null,
    返回条数: records.length,
    全文来源较多时可阅读record的详情链接获取完整信息: "摘要为平台截断版，需深入理解时对选中记录调用 zhizhen_detail",
    records,
  };
  if (includeLinks) payload.提示 = "已开启 include_links，records 含完整全文入口链接";
  if (cachedAt) payload.缓存时间 = cachedAt;
  return payload;
}

function compactDetailRecord(d, includeLinks) {
  const o = {
    标题: d.页面标题,
    类型: d.类型,
    被引量: d.被引量,
    作者: d.作者,
    作者单位: d.作者单位,
    出处: [d.期刊名 || d.刊名 || d.书名, d.年份, d.卷号 ? `${d.卷号}` : "", d.期号 ? `${d.期号}` : "", d.页码]
      .filter(Boolean)
      .join(" "),
    关键词: d.关键词,
    摘要: d.摘要,
    基金: d.基金,
    重要收录: d.重要收录,
    全文来源: sourceNames(d) || undefined,
    引证或参考文献: Array.isArray(d.引证或参考文献) ? d.引证或参考文献.slice(0, 8) : undefined,
  };
  if (includeLinks) {
    if (Array.isArray(d.全文获取) && d.全文获取.length) o.全文链接 = d.全文获取;
  }
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === "") delete o[k];
  return o;
}

function buildDetailPayload(data, { includeLinks, cachedAt } = {}) {
  const payload = {
    ok: true,
    ...compactDetailRecord(data.detail || data, includeLinks),
  };
  if (cachedAt) payload.缓存时间 = cachedAt;
  return payload;
}

/* ---------------- MCP server ---------------- */

const server = new McpServer({ name: "zhizhen-db", version: "1.1.0" });

server.tool(
  "zhizhen_search",
  "在超星发现系统（大连理工大学图书馆资源发现平台 ss.zhizhen.com）检索文献，返回精简题录：标题/类型/作者/出处/关键词/截断摘要/被引量/全文来源名/详情链接。可选排序(sort)、字段限定(field)、年份范围(year_from/year_to)。每页最多 15 条；扩大覆盖面的推荐做法：换更窄的检索词、同一检索词换 sort 再查一次取并集、或自行传 page 翻页（收窄检索词通常优于深翻页）。为省 token 默认不返回长 URL 链接（include_links=true 才带）。摘要为列表页截断版，需完整摘要时用 zhizhen_detail。结果自动缓存 7 天，重复检索读缓存。",
  {
    query: z.string().describe("检索词（支持多个词、支持逻辑 关键词 或 任意内容，如：氧化锌 光催化）"),
    content_type: z
      .enum(["全部", "期刊", "图书", "报纸", "学位论文", "会议论文", "专利", "标准", "科技成果", "年鉴"])
      .optional()
      .describe("限定文献内容类型，默认全部"),
    sort: z
      .enum(["default", "collection", "date_desc", "date_asc", "cited", "relevance"])
      .optional()
      .describe(
        "排序方式：default=站点默认排序, collection=馆藏优先, date_desc=出版日期降序(最新在前), date_asc=出版日期升序, cited=引文量降序(高被引在前), relevance=相关性。查经典用 cited，查最新动态用 date_desc"
      ),
    field: z
      .enum(["全部字段", "题名", "主题", "关键词", "作者", "作者单位", "摘要"])
      .optional()
      .describe("限定检索字段，默认全部字段。检索词太宽泛时用『题名』可显著提高精度"),
    year_from: z
      .number()
      .int()
      .min(1000)
      .max(2027)
      .optional()
      .describe("出版年份下限（与网页高级检索语义一致，查近年进展时常配合 year_to 使用）"),
    year_to: z.number().int().min(1000).max(2027).optional().describe("出版年份上限"),
    page: z
      .number()
      .int()
      .min(1)
      .max(99)
      .optional()
      .describe("结果页码，默认第 1 页（每页 15 条）。需要更多结果可自行传 page=2、3… 翻页"),
    limit: z.number().int().min(1).max(15).optional().describe("只返回前 N 条，默认 10 条以省 token"),
    include_links: z.boolean().optional().describe("true 时附带每条记录的完整全文入口链接（goread URL，较长，默认省略）"),
    force_refresh: z.boolean().optional().describe("true 时忽略本地缓存强制重新检索，默认使用 7 天内的缓存"),
  },
  async ({ query, content_type, page, limit, include_links, force_refresh, sort, field, year_from, year_to }) => {
    try {
      const page_no = page || 1;
      const lim = limit ?? 10;
      const links = !!include_links;
      if (year_from != null && year_to != null && year_from > year_to) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ ok: false, error: "year_from 不能大于 year_to" }) },
          ],
        };
      }
      const keyObj = { query, content_type: content_type || "", page: page_no };
      if (sort && sort !== "default") keyObj.sort = sort;
      if (field && field !== "全部字段") keyObj.field = field;
      if (year_from != null) keyObj.yf = year_from;
      if (year_to != null) keyObj.yt = year_to;
      const key = JSON.stringify(keyObj);
      if (!force_refresh) {
        const hit = await cacheGet("search", key, SEARCH_TTL_MS);
        if (hit) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    来源: "本地缓存",
                    ...buildSearchPayload(hit, {
                      limit: lim,
                      includeLinks: links,
                      cachedAt: new Date(hit._savedAt).toLocaleString("zh-CN"),
                    }),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
      }
      const res = await doSearch({ query, content_type, page_no, sort, field, year_from, year_to });
      if (!res.ok) {
        return { content: [{ type: "text", text: JSON.stringify(res) }] };
      }
      await cachePut("search", key, res);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { 来源: "实时抓取", ...buildSearchPayload(res, { limit: lim, includeLinks: links }) },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2),
          },
        ],
      };
    }
  }
);

server.tool(
  "zhizhen_detail",
  "打开超星发现的文献详情页（先检索拿到详情链接），返回精简版完整信息：标题/类型/作者及单位/出处(刊名 年 卷期 页码)/关键词/完整摘要/基金/重要收录/引证或参考文献(至多8条)。为省 token 不返回长全文链接（include_links=true 才带）。结果缓存 30 天。",
  {
    detail_url: z.string().describe("检索结果里记录的『详情链接』，形如 https://ss.zhizhen.com/detail_xxxxxxxx?"),
    include_links: z.boolean().optional().describe("true 时附带全文入口链接（goread URL，较长，默认省略）"),
    force_refresh: z.boolean().optional().describe("true 时忽略缓存强制重新抓取详情页"),
  },
  async ({ detail_url, include_links, force_refresh }) => {
    try {
      if (!/ss\.zhizhen\.com\/detail_/.test(detail_url)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: "detail_url 必须是 ss.zhizhen.com 的 detail_ 详情链接" }),
            },
          ],
        };
      }
      const links = !!include_links;
      if (!force_refresh) {
        const hit = await cacheGet("detail", detail_url, DETAIL_TTL_MS);
        if (hit) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { 来源: "本地缓存", ...buildDetailPayload(hit, { includeLinks: links, cachedAt: new Date(hit._savedAt).toLocaleString("zh-CN") }) },
                  null,
                  2
                ),
              },
            ],
          };
        }
      }
      const res = await doDetail({ detail_url });
      if (!res.ok) return { content: [{ type: "text", text: JSON.stringify(res) }] };
      await cachePut("detail", detail_url, res);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { 来源: "实时抓取", ...buildDetailPayload(res, { includeLinks: links }) },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2) },
        ],
      };
    }
  }
);

server.tool(
  "zhizhen_status",
  "检查超星发现 MCP 的浏览器与网络状态：浏览器是否在运行、当前页面、校园网机构授权情况（应显示『欢迎来自xx大学的朋友』）、本地缓存目录与缓存条目。",
  {},
  async () => {
    try {
      await ensureBrowser();
      let info;
      try {
        info = await page.evaluate(TEXT_DUMP_FN, 600);
      } catch {
        info = null;
      }
      const org = info ? (info.text.match(/欢迎来自\s*([^\n|]+?)\s*(?:\||$)/) || [])[1]?.trim() : null;
      const list = await cacheList();
      const ver = await page.evaluate(() => navigator.userAgent);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                浏览器: "Chrome(专用实例，窗口常驻)",
                浏览器版本: ver,
                当前网址: info?.url || null,
                机构授权: org || "未识别（需校园网）",
                缓存目录: CACHE_DIR,
                缓存条目数: list.length,
                缓存明细: list.slice(-15),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2) },
        ],
      };
    }
  }
);

server.tool(
  "zhizhen_browse",
  "通用浏览器工具：让 MCP 的专用 Chrome 打开任意超星站点页面（ss.zhizhen.com 或 goread 全文跳转页），返回页面正文文本前若干字符，用于人工排查/走未收录的页面。",
  {
    url: z.string().describe("要打开的 https://ss.zhizhen.com/... 页面链接"),
    max_chars: z.number().int().min(500).max(20000).optional().describe("返回正文最大字符数，默认 6000"),
  },
  async ({ url, max_chars }) => {
    try {
      if (!/^https:\/\/(ss\.)?zhizhen\.com\//.test(url) && !url.startsWith("https://ss.zhizhen.com")) {
        url = url.replace(/^https?:\/\/[^/]+/, "https://ss.zhizhen.com");
      }
      await gotoTarget(url);
      const max = max_chars || 6000;
      const info = await page.evaluate(TEXT_DUMP_FN, max);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, url: info.url, 标题: info.title, 正文: info.text }, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2) },
        ],
      };
    }
  }
);

await fs.mkdir(CACHE_DIR, { recursive: true }).catch(() => {});
const transport = new StdioServerTransport();
await server.connect(transport);

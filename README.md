# zhizhen-db-mcp

把**超星发现系统（ss.zhizhen.com，大连理工大学图书馆资源发现平台）**变成 AI 助手可用的论文数据库的 Model Context Protocol (MCP) 服务器。

AI 通过本 MCP 驱动一个专用 Chrome 实例：自动进入学校发现系统 → 检索论文 → 返回结构化题录 → 需要时展开详情页拿完整摘要 → 结果**本地缓存**，重复检索不再访问浏览器。

> ⚠️ 仅供本校师生个人学习使用。校园网 IP 授权即可访问（页面顶部显示「欢迎来自大连理工大学的朋友」）。请遵守图书馆电子资源使用规范，避免高频抓取。

---

## 功能

| 工具 | 作用 |
|---|---|
| `zhizhen_search` | 检索文献，返回精简题录：标题/类型/作者/出处/关键词/截断摘要/被引量/全文来源名/详情链接。支持 `content_type`（期刊/学位论文/会议论文/专利…）、`sort`（排序）、`field`（字段限定）、`year_from`/`year_to`（年份）、`page`、`limit`、`include_links` |
| `zhizhen_detail` | 打开详情页，返回完整信息：作者单位、刊名年卷期页码、完整摘要、基金、重要收录、引证或参考文献（≤8 条） |
| `zhizhen_status` | 检查浏览器/校园网机构授权状态/缓存清单 |
| `zhizhen_browse` | 兜底：打开任意 ss.zhizhen.com 页面并返回正文文本 |

### zhizhen_search 检索参数（v1.1.0 新增排序/字段/年份）

| 参数 | 取值 | 说明 |
|---|---|---|
| `sort` | `default` / `collection` / `date_desc` / `date_asc` / `cited` / `relevance` | 排序：站点默认 / 馆藏优先 / 出版日期降序（最新在前）/ 升序 / 引文量降序（经典高被引在前）/ 相关性 |
| `field` | `全部字段` / `题名` / `主题` / `关键词` / `作者` / `作者单位` / `摘要` | 字段限定；检索词太宽泛时用 `题名` 可显著提高精度 |
| `year_from` / `year_to` | 整数年份 | 出版年份范围，语义与网页高级检索一致 |
| `page` | 1~99 | 每页 15 条；扩大覆盖可自行翻页，但收窄检索词通常优于深翻页 |

**推荐检索策略**：综述/调研类需求，同一检索词换 `sort`（`cited` + `date_desc` + 默认）跑多次取并集去重，覆盖面远大于单次 top-10；查近年进展加 `year_from`。

### 省 token 设计

- 默认**不返回** goread 全文链接等长 URL（每个 300+ 字符），只返回来源名；需要时传 `include_links: true`
- 默认 `limit: 10` 条（每页最多 15）
- 检索结果缓存 7 天、详情缓存 30 天（JSON 存本地），缓存命中零浏览器开销
- 摘要为列表页截断版；需要完整摘要时对选中记录调用 `zhizhen_detail`

---

## 环境要求

- Windows（Chrome 路径检测为 Windows 常规位置）
- Node.js ≥ 18
- Google Chrome 或 Edge
- 校园网（页面按 IP 识别机构，无需账号登录）

## 快速开始（opencode）

```bash
# 1. 克隆或解压到本机，例如 D:\zhizhen-db-mcp
git clone <你的仓库地址> D:\zhizhen-db-mcp
cd D:\zhizhen-db-mcp
npm install
```

```jsonc
// 2. 在你的 opencode.json 的 "mcp" 里加：
"zhizhen-db": {
  "type": "local",
  "command": ["node", "D:/zhizhen-db-mcp/server.js"],
  "enabled": true,
  "environment": {
    "ZHIZHEN_CACHE_DIR": "D:/文献库/zhizhen_cache"
  }
}
```

3. 重启 opencode。之后直接说「帮我查一下 XX 方向的论文」「总结这篇」，AI 会自动调用本 MCP。

## 其他 MCP 客户端（Claude Desktop 等）

```json
{
  "mcpServers": {
    "zhizhen-db": {
      "command": "node",
      "args": ["D:/zhizhen-db-mcp/server.js"],
      "env": {
        "ZHIZHEN_CACHE_DIR": "D:/文献库/zhizhen_cache"
      }
    }
  }
}
```

---

## 运行机制（了解即可）

- 首次调用时启动**一个独立的可见 Chrome 窗口**（专用 profile，登录态/机构授权持久化），之后所有会话复用该实例，不重复弹窗
- 通过 CDP（默认端口 9333）控制；Chrome 由本进程 detach 启动，opencode 退出后窗口仍常驻，下次自动重连
- 若机器重启后没有 Chrome 在跑，下次调用自动重新拉起
- 浏览器 profile 在 `browser-profile/`（不要上传/提交），缓存 JSON 在 `ZHIZHEN_CACHE_DIR`

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ZHIZHEN_CACHE_DIR` | `D:\文献库\zhizhen_cache` | 检索/详情缓存目录 |
| `ZHIZHEN_PROFILE_DIR` | `./browser-profile` | Chrome 专用 profile 目录 |
| `ZHIZHEN_DEBUG_PORT` | `9333` | CDP 调试端口（被占用时改） |
| `ZHIZHEN_CHROME_PATH` | 自动探测 | 指定 chrome.exe / msedge.exe 路径 |
| `ZHIZHEN_HEADLESS` | 窗口模式 | 设 `1` 切无头模式 |

## 常见问题

- **报「未找到本机 Chrome/Edge」**：设 `ZHIZHEN_CHROME_PATH` 指向浏览器可执行文件
- **页面不显示「欢迎来自xx大学」/检索不到全文**：不在校园网授权范围内，需要连校园网或学校 VPN
- **端口被占用**：换 `ZHIZHEN_DEBUG_PORT`
- **改了代码不生效**：MCP 配置只在客户端启动时加载，改完需重启客户端

---

## 目录结构

```
zhizhen-db-mcp/
├── server.js          # MCP 服务器（唯一入口）
├── test-client.mjs    # 调试客户端（node test-client.mjs status|search|detail）
├── package.json
└── README.md
```

## License

MIT

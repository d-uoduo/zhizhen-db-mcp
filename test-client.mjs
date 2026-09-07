import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./server.js", import.meta.url))],
  env: { ...process.env, ZHIZHEN_CACHE_DIR: "D:/文献库/zhizhen_cache" },
});

const client = new Client({ name: "zhizhen-db-test", version: "0.1.0" });
await client.connect(transport);

const which = process.argv[2] || "status";
const arg = process.argv[3] || "";

if (which === "status") {
  const r = await client.callTool({ name: "zhizhen_status", arguments: {} });
  console.log(r.content[0].text);
} else if (which === "search") {
  const argsObj = { query: arg, content_type: "期刊" };
  if (process.env.REFRESH === "1") argsObj.force_refresh = true;
  if (process.env.LINKS === "1") argsObj.include_links = true;
  if (process.env.LIMIT) argsObj.limit = parseInt(process.env.LIMIT, 10);
  const r = await client.callTool({ name: "zhizhen_search", arguments: argsObj });
  const txt = r.content[0].text;
  console.log("BYTES=" + Buffer.byteLength(txt, "utf8") + " CHARS=" + txt.length);
  const data = JSON.parse(txt);
  if (!data.ok) {
    console.log(txt);
    process.exit(1);
  }
  console.log(JSON.stringify({
    ok: data.ok, 来源: data.来源, 检索词: data.meta?.检索词, 类型: data.meta?.内容类型,
    总条数: data.meta?.总条数, 各类型: data.meta?.各类型计数, 机构: data.meta?.机构,
    records: data.records?.slice(0, 2),
  }, null, 2));
  const url = data.records?.[0]?.详情链接;
  console.log("DETAIL_URL=" + (url || ""));
} else if (which === "detail") {
  const argsDetail = { detail_url: arg };
  if (process.env.REFRESH === "1") argsDetail.force_refresh = true;
  if (process.env.LINKS === "1") argsDetail.include_links = true;
  const r = await client.callTool({ name: "zhizhen_detail", arguments: argsDetail });
  const txt = r.content[0].text;
  console.log("BYTES=" + Buffer.byteLength(txt, "utf8") + " CHARS=" + txt.length);
  const d = JSON.parse(txt);
  console.log(JSON.stringify({ ...d }, null, 2));
}

await client.close();
process.exit(0);

#!/usr/bin/env node
"use strict";
/**
 * 이음맵 로컬 테스트 서버 (의존성 없음, Node.js 18 이상)
 *
 *   npm start            .env.local 의 인증키로 실제 서울시 API 호출
 *   npm run mock         tests/fixtures 의 모의 XML로 화면만 확인 (인증키 불필요)
 *
 * 옵션
 *   --port=3000
 *   --mock                       모의 데이터 사용 (화면에 "테스트용 모의 데이터"로 표시)
 *   --mock-fail=lift,toilet      해당 서비스만 인증키 오류(INFO-100)를 흉내 냄
 *   --mock-timeout=helper        해당 서비스만 응답 지연(시간 초과)을 흉내 냄
 *
 * 배포(Vercel)에서는 이 파일을 사용하지 않습니다.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v === undefined ? true : v];
}));
const PORT = Number(args.port || process.env.PORT || 3000);
const MOCK = Boolean(args.mock || args["mock-fail"] || args["mock-timeout"]);
const listArg = (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
const MOCK_FAIL = new Set(listArg(args["mock-fail"]));
const MOCK_TIMEOUT = new Set(listArg(args["mock-timeout"]));

// .env.local → .env 순서로 읽되, 이미 설정된 환경변수는 덮어쓰지 않음
for (const file of [".env.local", ".env"]) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined && value !== "") process.env[m[1]] = value;
  }
}

const { createHandler, _internal } = require(path.join(ROOT, "api", "facilities.js"));
const TYPE_BY_SERVICE = Object.fromEntries(Object.values(_internal.SERVICES).map((s) => [s.service, s.type]));

function mockFetch(url, init = {}) {
  const service = String(url).split("/xml/")[1].split("/")[0];
  const type = TYPE_BY_SERVICE[service];
  if (MOCK_TIMEOUT.has(type)) {
    return new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  }
  const file = MOCK_FAIL.has(type) ? "error-INFO-100.xml" : `${service}.xml`;
  const body = fs.readFileSync(path.join(ROOT, "tests", "fixtures", file), "utf8");
  return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "text/xml; charset=utf-8" } }));
}

const handler = createHandler(MOCK
  ? { fetchImpl: mockFetch, getEnv: () => ({ SEOUL_API_KEY: "MOCKKEY" }), mock: true, requestTimeoutMs: 3000, totalBudgetMs: 5000 }
  : {});

// 정적 파일은 화이트리스트만 제공 (.env.local 등이 노출되지 않도록)
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
};

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  try {
    if (pathname === "/api/facilities" || pathname === "/api/facilities/") {
      return await handler(req, res);
    }
    const entry = STATIC[pathname];
    if (entry && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(200, { "Content-Type": entry[1], "Cache-Control": "no-store" });
      return res.end(req.method === "HEAD" ? undefined : fs.readFileSync(path.join(ROOT, entry[0])));
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (err) {
    console.error("[dev-server]", err && err.message);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Internal error");
  }
});

server.listen(PORT, () => {
  const configured = Object.values(_internal.SERVICES)
    .map((s) => `${s.label}:${(process.env[s.envKey] || process.env.SEOUL_API_KEY) ? "키 있음" : "키 없음"}`)
    .join(" · ");
  console.log(`\n이음맵 로컬 서버: http://localhost:${PORT}`);
  console.log(MOCK
    ? `모드: 모의 데이터 (실제 API를 호출하지 않음)${MOCK_FAIL.size ? ` · 실패 흉내: ${[...MOCK_FAIL].join(",")}` : ""}${MOCK_TIMEOUT.size ? ` · 지연 흉내: ${[...MOCK_TIMEOUT].join(",")}` : ""}`
    : `모드: 실제 서울시 API · ${configured}`);
  console.log("종료: Ctrl + C\n");
});

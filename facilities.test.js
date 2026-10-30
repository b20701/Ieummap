"use strict";
// 서버 프록시(api/facilities.js) 자동 테스트 — 실제 서울시 API는 호출하지 않습니다.
// 실행: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createHandler, _internal } = require("../api/facilities.js");

const FIX = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const KEY = "TESTKEY1234567890abcdef";
const LIFT_KEY = "LIFTKEY0987654321";

function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: "",
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.body = b || ""; this.ended = true; },
  };
}
async function call(handler, url, method = "GET") {
  const res = fakeRes();
  await handler({ method, url }, res);
  return { status: res.statusCode, headers: res.headers, json: res.body ? JSON.parse(res.body) : null, raw: res.body };
}
function xmlResponse(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/xml" } });
}
function silentLogger() {
  const lines = [];
  return { lines, error: (...a) => lines.push(a.join(" ")), warn: (...a) => lines.push(a.join(" ")), log: (...a) => lines.push(a.join(" ")) };
}
function seoulPage(service, total, start, end) {
  const rows = [];
  for (let i = start; i <= Math.min(end, total); i++) {
    rows.push(`<row><stnNm>역${i % 50}</stnNm><lineNm>${(i % 8) + 1}호선</lineNm><fcltNo>F${i}</fcltNo><oprtngSitu>M</oprtngSitu></row>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?><${service}><list_total_count>${total}</list_total_count><RESULT><CODE>INFO-000</CODE><MESSAGE>정상 처리되었습니다</MESSAGE></RESULT>${rows.join("")}</${service}>`;
}

test("XML 파싱: 서울 열린데이터광장 표준 형식(row, RESULT/CODE)", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><getWksnElvtr><list_total_count>2</list_total_count><RESULT><CODE>INFO-000</CODE><MESSAGE><![CDATA[정상 처리되었습니다]]></MESSAGE></RESULT>
    <row><stnNm>시청</stnNm><oprtngSitu>M</oprtngSitu><dtlPstn>12번 출입구 &amp; 시청광장 방향</dtlPstn><vcntEntrcNo></vcntEntrcNo></row>
    <row><stnNm>강남</stnNm><oprtngSitu>S</oprtngSitu><dtlPstn>대합실</dtlPstn><vcntEntrcNo/></row></getWksnElvtr>`;
  const p = _internal.parseSeoulXml(xml);
  assert.equal(p.kind, "xml");
  assert.equal(p.format, "seoul");
  assert.equal(p.code, "INFO-000");
  assert.equal(p.totalCount, 2);
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].dtlPstn, "12번 출입구 & 시청광장 방향", "엔티티(&amp;) 해석");
  assert.equal(p.rows[0].vcntEntrcNo, "", "빈 태그는 빈 문자열");
  assert.equal(p.rows[1].vcntEntrcNo, "", "자기 닫힘 태그도 빈 문자열");
});

test("XML 파싱: 실제 응답과 같은 형식(resultCode 00 / NORMAL_CODE, pageNo·numOfRows·totalCount)", () => {
  const p = _internal.parseSeoulXml(FIX("getWksnElvtr.xml"));
  assert.equal(p.format, "datago");
  assert.equal(p.code, "00");
  assert.equal(p.message, "NORMAL_CODE");
  assert.equal(p.totalCount, 9, "pageNo(1)·numOfRows(1000)가 아니라 totalCount를 읽어야 함");
  assert.equal(p.rows.length, 9);
  assert.equal(p.rows[0].stnNm, "시청");
  assert.equal(p.rows[0].bgngFlr, "B1");
  assert.equal(p.rows[2].dtlPstn, "12번 출입구 & 시청광장 방향");
});

test("XML 파싱: 공공데이터포털 형식(item, resultCode)", () => {
  const p = _internal.parseSeoulXml(FIX("getWksnWhclCharge.xml"));
  assert.equal(p.format, "datago");
  assert.equal(p.code, "00");
  assert.equal(p.totalCount, 2);
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[1].stnNm, "강남");
});

test("XML 파싱: 오류 응답(INFO-100)과 HTML 응답 구분", () => {
  const p = _internal.parseSeoulXml(FIX("error-INFO-100.xml"));
  assert.equal(p.code, "INFO-100");
  assert.match(p.message, /인증키가 유효하지 않습니다/);
  assert.equal(p.rows.length, 0);
  assert.equal(_internal.parseSeoulXml("<!DOCTYPE html><html><body>점검</body></html>").kind, "html");
  assert.equal(_internal.parseSeoulXml("").kind, "empty");
});

test("정상 호출: 응답 JSON 구조와 캐시 헤더", async () => {
  const urls = [];
  const h = createHandler({ getEnv: () => ({ SEOUL_API_KEY: KEY }), fetchImpl: async (u) => { urls.push(u); return xmlResponse(FIX("getWksnElvtr.xml")); }, logger: silentLogger() });
  const r = await call(h, "/api/facilities?type=elevator");
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.service, "getWksnElvtr");
  assert.equal(r.json.count, 9);
  assert.equal(r.json.records[0].stnNm, "시청");
  assert.match(r.headers["cache-control"], /s-maxage=300/);
  assert.equal(urls[0], `http://openapi.seoul.go.kr:8088/${KEY}/xml/getWksnElvtr/1/1000/`);
  assert.ok(!r.raw.includes(KEY), "응답 본문에 인증키가 없어야 함");
});

test("다섯 서비스 모두 올바른 서비스명으로 호출", async () => {
  const seen = [];
  const h = createHandler({ getEnv: () => ({ SEOUL_API_KEY: KEY }), fetchImpl: async (u) => { const s = u.split("/xml/")[1].split("/")[0]; seen.push(s); return xmlResponse(FIX(`${s}.xml`)); }, logger: silentLogger() });
  for (const type of ["elevator", "charger", "lift", "helper", "toilet"]) {
    const r = await call(h, `/api/facilities?type=${type}`);
    assert.equal(r.status, 200, type);
    assert.ok(r.json.count > 0, type);
  }
  assert.deepEqual(seen, ["getWksnElvtr", "getWksnWhclCharge", "getWksnWhcllift", "getWksnHelper", "getWksnRstrm"]);
});

test("서비스별 인증키가 공통 키보다 우선", async () => {
  const urls = [];
  const h = createHandler({ getEnv: () => ({ SEOUL_API_KEY: KEY, SEOUL_API_KEY_LIFT: LIFT_KEY }), fetchImpl: async (u) => { urls.push(u); return xmlResponse(seoulPage("x", 1, 1, 1)); }, logger: silentLogger() });
  await call(h, "/api/facilities?type=lift");
  await call(h, "/api/facilities?type=elevator");
  assert.ok(urls[0].includes(`/${LIFT_KEY}/xml/getWksnWhcllift/`));
  assert.ok(urls[1].includes(`/${KEY}/xml/getWksnElvtr/`));
});

test("1000건 초과 시 페이지를 나눠 모두 수집", async () => {
  const ranges = [];
  const h = createHandler({
    getEnv: () => ({ SEOUL_API_KEY: KEY }), logger: silentLogger(),
    fetchImpl: async (u) => { const [, s, e] = u.match(/\/(\d+)\/(\d+)\/$/); ranges.push(`${s}-${e}`); return xmlResponse(seoulPage("getWksnElvtr", 2345, +s, +e)); },
  });
  const r = await call(h, "/api/facilities?type=elevator");
  assert.equal(r.json.count, 2345);
  assert.equal(r.json.totalCount, 2345);
  assert.equal(r.json.partial, false);
  assert.deepEqual(ranges.sort(), ["1-1000", "1001-2000", "2001-3000"]);
});

// 실제 응답(2026-10, 이용자 제공 PDF)과 같은 공공데이터포털 형식: resultCode 00 / NORMAL_CODE, pageNo·numOfRows·totalCount
function datagoPage(total, pageNo, numOfRows) {
  const items = [];
  const from = (pageNo - 1) * numOfRows + 1;
  for (let i = from; i <= Math.min(from + numOfRows - 1, total); i++) {
    items.push(`<item><fcltNo>${1040000 + i}</fcltNo><fcltNm>승강기)엘리베이터-역${i % 50} 외부#1</fcltNm><lineNm>${(i % 8) + 1}호선</lineNm><stnNm>역${i % 50}</stnNm><oprtngSitu>M</oprtngSitu></item>`);
  }
  return `<response><header><resultCode>00</resultCode><resultMsg>NORMAL_CODE</resultMsg></header><body><items>${items.join("")}</items><pageNo>${pageNo}</pageNo><numOfRows>${numOfRows}</numOfRows><totalCount>${total}</totalCount></body></response>`;
}
const gateway = {
  // 시작/끝 번호를 페이지로 올바르게 바꿔 주는 게이트웨이
  range: (s, e) => [Math.floor((s - 1) / (e - s + 1)) + 1, e - s + 1],
  // 시작번호를 pageNo, 끝번호를 numOfRows로 그대로 넘기는 게이트웨이
  page: (s, e) => [s, e],
  // 범위를 무시하고 항상 1페이지만 주는 게이트웨이
  broken: () => [1, 1000],
};
for (const [name, map] of Object.entries(gateway)) {
  test(`공공데이터포털 형식 페이지 처리: 게이트웨이 방식 '${name}'`, async () => {
    const reqs = [];
    const h = createHandler({
      getEnv: () => ({ SEOUL_API_KEY: KEY }), logger: silentLogger(), requestTimeoutMs: 300, totalBudgetMs: 3000,
      fetchImpl: async (u) => { const [, s, e] = u.match(/\/(\d+)\/(\d+)\/$/); reqs.push(`${s}-${e}`); const [p, n] = map(+s, +e); return xmlResponse(datagoPage(2345, p, n)); },
    });
    const r = await call(h, "/api/facilities?type=elevator");
    assert.equal(r.status, 200);
    assert.equal(r.json.format, "datago");
    if (name === "broken") {
      assert.equal(r.json.count, 1000);
      assert.equal(r.json.partial, true);
      assert.equal(r.json.warning.code, "PAGINATION_UNSUPPORTED");
      assert.match(r.json.warning.operatorAction, /1001\/2000/);
    } else {
      assert.equal(r.json.count, 2345, `요청: ${reqs.join(", ")}`);
      assert.equal(r.json.partial, false);
      assert.equal(r.json.pagingMode, name);
    }
  });
}

test("중간 페이지 실패 시 받은 데이터와 경고(partial)를 반환", async () => {
  const h = createHandler({
    getEnv: () => ({ SEOUL_API_KEY: KEY }), logger: silentLogger(),
    fetchImpl: async (u) => { const [, s, e] = u.match(/\/(\d+)\/(\d+)\/$/); if (s === "1001") return xmlResponse("<RESULT><CODE>ERROR-500</CODE><MESSAGE>서버 오류</MESSAGE></RESULT>"); return xmlResponse(seoulPage("getWksnElvtr", 1500, +s, +e)); },
  });
  const r = await call(h, "/api/facilities?type=elevator");
  assert.equal(r.status, 200);
  assert.equal(r.json.partial, true);
  assert.equal(r.json.count, 1000);
  assert.match(r.json.warning.cause, /1,500건 중 1,000건/);
  assert.match(r.headers["cache-control"], /s-maxage=60/);
});

test("인증키 없음 → 503 CONFIG_MISSING_KEY, 운영자 안내 포함", async () => {
  let called = false;
  const h = createHandler({ getEnv: () => ({}), fetchImpl: async () => { called = true; }, logger: silentLogger() });
  const r = await call(h, "/api/facilities?type=helper");
  assert.equal(r.status, 503);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, "CONFIG_MISSING_KEY");
  assert.equal(r.json.error.kind, "config");
  assert.match(r.json.error.operatorAction, /SEOUL_API_KEY/);
  assert.match(r.json.error.operatorAction, /재배포/);
  assert.ok(r.json.error.userAction.length > 0);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(called, false, "키가 없으면 외부 호출을 하지 않음");
});

test("환경변수에 URL 전체를 넣은 경우 → CONFIG_KEY_LOOKS_LIKE_URL (키 비노출)", async () => {
  const h = createHandler({ getEnv: () => ({ SEOUL_API_KEY: `http://openapi.seoul.go.kr:8088/${KEY}/xml/getWksnElvtr/1/1000/` }), fetchImpl: async () => { throw new Error("should not call"); }, logger: silentLogger() });
  const r = await call(h, "/api/facilities?type=elevator");
  assert.equal(r.json.error.code, "CONFIG_KEY_LOOKS_LIKE_URL");
  assert.ok(!r.raw.includes(KEY));
});

test("서울시 INFO-100 → 502 auth 오류, 응답·로그에 인증키 없음", async () => {
  const logger = silentLogger();
  const h = createHandler({ getEnv: () => ({ SEOUL_API_KEY: KEY }), fetchImpl: async () => xmlResponse(FIX("error-INFO-100.xml")), logger });
  const r = await call(h, "/api/facilities?type=toilet");
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, "SEOUL_INFO-100");
  assert.equal(r.json.error.kind, "auth");
  assert.equal(r.json.error.retryable, false);
  assert.match(r.json.error.cause, /INFO-100/);
  assert.match(r.json.error.operatorAction, /SEOUL_API_KEY/);
  assert.ok(!r.raw.includes(KEY));
  assert.ok(logger.lines.length > 0 && logger.lines.every((l) => !l.includes(KEY)), "로그에도 키 없음");
});

test("INFO-200(데이터 없음)은 오류가 아니라 0건", async () => {
  const h = createHandler({ getEnv: () => ({ SEOUL_API_KEY: KEY }), fetchImpl: async () => xmlResponse("<RESULT><CODE>INFO-200</CODE><MESSAGE>해당하는 데이터가 없습니다.</MESSAGE></RESULT>"), logger: silentLogger() });
  const r = await call(h, "/api/facilities?type=charger");
  assert.equal(r.status, 200);
  assert.equal(r.json.count, 0);
});

test("응답 지연 → 504 UPSTREAM_TIMEOUT", async () => {
  const h = createHandler({
    getEnv: () => ({ SEOUL_API_KEY: KEY }), logger: silentLogger(), requestTimeoutMs: 80, totalBudgetMs: 300,
    fetchImpl: (u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))),
  });
  const r = await call(h, "/api/facilities?type=lift");
  assert.equal(r.status, 504);
  assert.equal(r.json.error.code, "UPSTREAM_TIMEOUT");
  assert.match(r.json.error.operatorAction, /icn1/);
});

test("네트워크 오류 → 502 UPSTREAM_UNREACHABLE (1회 재시도)", async () => {
  let n = 0;
  const h = createHandler({
    getEnv: () => ({ SEOUL_API_KEY: KEY }), logger: silentLogger(), requestTimeoutMs: 200, totalBudgetMs: 2000,
    fetchImpl: async () => { n++; throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) }); },
  });
  const r = await call(h, "/api/facilities?type=elevator");
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, "UPSTREAM_UNREACHABLE");
  assert.match(r.json.error.cause, /ENOTFOUND/);
  assert.equal(n, 2);
});

test("HTML(점검 페이지 등) 응답 → UPSTREAM_NOT_XML", async () => {
  const h = createHandler({ getEnv: () => ({ SEOUL_API_KEY: KEY }), logger: silentLogger(), requestTimeoutMs: 200, totalBudgetMs: 2000, fetchImpl: async () => xmlResponse("<!DOCTYPE html><html><body>시스템 점검 중</body></html>") });
  const r = await call(h, "/api/facilities?type=elevator");
  assert.equal(r.json.error.code, "UPSTREAM_NOT_XML");
});

test("HTTP 오류 상태 → UPSTREAM_HTTP_503", async () => {
  const h = createHandler({ getEnv: () => ({ SEOUL_API_KEY: KEY }), logger: silentLogger(), requestTimeoutMs: 200, totalBudgetMs: 2000, fetchImpl: async () => xmlResponse("busy", 503) });
  const r = await call(h, "/api/facilities?type=elevator");
  assert.equal(r.json.error.code, "UPSTREAM_HTTP_503");
});

test("잘못된 type → 400, POST → 405", async () => {
  const h = createHandler({ getEnv: () => ({ SEOUL_API_KEY: KEY }), fetchImpl: async () => { throw new Error("no"); }, logger: silentLogger() });
  assert.equal((await call(h, "/api/facilities?type=escalator")).status, 400);
  assert.equal((await call(h, "/api/facilities?type=elevator", "POST")).status, 405);
});

test("상태 확인(type 없음): 설정 여부만 반환하고 키 값은 반환하지 않음", async () => {
  const h = createHandler({ getEnv: () => ({ SEOUL_API_KEY_ELEVATOR: KEY, SEOUL_API_KEY_LIFT: LIFT_KEY }), fetchImpl: async () => { throw new Error("no"); }, logger: silentLogger() });
  const r = await call(h, "/api/facilities");
  assert.equal(r.status, 200);
  const byType = Object.fromEntries(r.json.services.map((s) => [s.type, s]));
  assert.equal(byType.elevator.configured, true);
  assert.equal(byType.elevator.keyEnv, "SEOUL_API_KEY_ELEVATOR");
  assert.equal(byType.charger.configured, false);
  assert.ok(!r.raw.includes(KEY) && !r.raw.includes(LIFT_KEY));
});

test("같은 요청은 캐시되어 외부 API를 다시 호출하지 않음", async () => {
  let n = 0;
  const h = createHandler({ getEnv: () => ({ SEOUL_API_KEY: KEY }), fetchImpl: async () => { n++; return xmlResponse(FIX("getWksnRstrm.xml")); }, logger: silentLogger() });
  await call(h, "/api/facilities?type=toilet");
  const r = await call(h, "/api/facilities?type=toilet");
  assert.equal(n, 1);
  assert.equal(r.json.cached, true);
});

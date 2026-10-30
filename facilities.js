"use strict";
/**
 * 이음맵 서버 프록시 — 서울 열린데이터광장(서울교통공사 교통약자 이용정보) Open API
 *
 * GET /api/facilities?type=elevator|charger|lift|helper|toilet
 *   → 해당 시설 데이터 전체(페이지 자동 수집)를 JSON으로 반환
 * GET /api/facilities
 *   → 다섯 서비스의 설정 상태(인증키 설정 여부만, 값은 절대 반환하지 않음)
 *
 * 인증키는 서버 환경변수에서만 읽습니다.
 *   SEOUL_API_KEY            공통 인증키
 *   SEOUL_API_KEY_ELEVATOR   (선택) 서비스별 인증키. 설정하면 공통 키보다 우선합니다.
 *   SEOUL_API_KEY_CHARGER / _LIFT / _HELPER / _TOILET
 *
 * 의존성 없이 Node.js 18+ 내장 fetch만 사용합니다.
 */

const SERVICES = Object.freeze({
  elevator: { type: "elevator", service: "getWksnElvtr", label: "엘리베이터", envKey: "SEOUL_API_KEY_ELEVATOR", dataset: "OA-22740" },
  charger: { type: "charger", service: "getWksnWhclCharge", label: "휠체어 급속충전기", envKey: "SEOUL_API_KEY_CHARGER", dataset: "OA-22745" },
  lift: { type: "lift", service: "getWksnWhcllift", label: "휠체어 리프트", envKey: "SEOUL_API_KEY_LIFT", dataset: "OA-22743" },
  helper: { type: "helper", service: "getWksnHelper", label: "교통약자 도우미", envKey: "SEOUL_API_KEY_HELPER", dataset: "OA-22748" },
  toilet: { type: "toilet", service: "getWksnRstrm", label: "장애인 화장실", envKey: "SEOUL_API_KEY_TOILET", dataset: "OA-22741" },
});

const DEFAULTS = Object.freeze({
  baseUrl: "http://openapi.seoul.go.kr:8088", // 서울시 Open API는 HTTP(8088)만 제공 → 브라우저 대신 서버에서 호출
  pageSize: 1000, // 서울시 Open API 1회 최대 요청 건수
  maxPages: 30,
  requestTimeoutMs: 8000,
  totalBudgetMs: 25000, // vercel.json maxDuration(30초)보다 짧게
  pageConcurrency: 3,
  cacheTtlMs: 5 * 60 * 1000, // 엘리베이터 상태는 수시~5분 단위로 갱신됨
});

const COMMON_ENV = "SEOUL_API_KEY";
const VERCEL_ENV_HINT = "Vercel 프로젝트 → Settings → Environment Variables";

/* ------------------------------------------------------------------ */
/* XML 파싱                                                            */
/* ------------------------------------------------------------------ */

const ENTITY_MAP = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeXmlText(raw) {
  if (raw == null) return "";
  let text = String(raw);
  // CDATA는 그대로 꺼내고, 나머지는 엔티티를 해석
  const parts = [];
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let last = 0;
  let m;
  while ((m = cdata.exec(text))) {
    parts.push(decodeEntities(text.slice(last, m.index)));
    parts.push(m[1]);
    last = m.index + m[0].length;
  }
  parts.push(decodeEntities(text.slice(last)));
  return parts.join("").trim();
}

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const v = ENTITY_MAP[ent.toLowerCase()];
    return v === undefined ? whole : v;
  });
}

function firstTagText(xml, tagNames) {
  for (const tag of tagNames) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
    const m = xml.match(re);
    if (m) return decodeXmlText(m[1]);
  }
  return null;
}

function parseRecordBlock(block) {
  const record = {};
  const child = /<([A-Za-z_][\w.-]*)(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;
  let m;
  while ((m = child.exec(block))) {
    const key = m[1];
    if (Object.prototype.hasOwnProperty.call(record, key)) continue;
    record[key] = m[2] === undefined ? "" : decodeXmlText(m[2]);
  }
  return record;
}

/**
 * 서울 열린데이터광장 형식(<row>, <RESULT><CODE>)과
 * 공공데이터포털 형식(<item>, <resultCode>)을 모두 처리합니다.
 */
function parseSeoulXml(text) {
  const xml = String(text || "").replace(/^﻿/, "").trim();
  if (!xml) return { kind: "empty" };
  if (/^<!doctype html|^<html|<html[\s>]/i.test(xml.slice(0, 500))) return { kind: "html" };
  if (!xml.startsWith("<")) return { kind: "not-xml" };

  const resultBlock = xml.match(/<RESULT(?:\s[^>]*)?>([\s\S]*?)<\/RESULT>/i);
  let code = null;
  let message = null;
  let format = "unknown";
  if (resultBlock) {
    format = "seoul";
    code = firstTagText(resultBlock[1], ["CODE"]);
    message = firstTagText(resultBlock[1], ["MESSAGE"]);
  }
  if (code === null) {
    const c = firstTagText(xml, ["resultCode"]);
    if (c !== null) {
      format = "datago";
      code = c;
      message = firstTagText(xml, ["resultMsg"]);
    }
  }
  if (code === null) {
    // 공공데이터포털 게이트웨이 오류 형식 (OpenAPI_ServiceResponse)
    const c = firstTagText(xml, ["returnReasonCode"]);
    if (c !== null) {
      format = "datago-gateway";
      code = c;
      message = firstTagText(xml, ["returnAuthMsg", "errMsg"]);
    }
  }

  const totalText = firstTagText(xml, ["list_total_count", "totalCount"]);
  const totalCount = totalText !== null && /^\d+$/.test(totalText) ? Number(totalText) : null;

  const rows = [];
  const rowRe = /<(row|item)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = rowRe.exec(xml))) {
    const rec = parseRecordBlock(m[2]);
    if (Object.keys(rec).length) rows.push(rec);
  }
  if (rows.length && format === "unknown") format = /<row[\s>]/i.test(xml) ? "seoul" : "datago";

  return { kind: "xml", format, code, message, totalCount, rows };
}

/* ------------------------------------------------------------------ */
/* 오류 정의: 원인 / 이용자 해결 방법 / 운영자 해결 방법을 분리             */
/* ------------------------------------------------------------------ */

class ProxyError extends Error {
  constructor(info) {
    super(info.cause);
    this.info = info;
  }
}

const USER_RETRY = "잠시 후 ‘다시 불러오기’를 눌러 주세요. 계속되면 역무원·운영기관 안내를 확인해 주세요.";
const USER_REPORT = "서비스 설정 문제라 이용자가 해결할 수는 없어요. 운영자에게 알려 주세요.";

function upstreamCodeInfo(code, message, ctx) {
  const c = String(code || "").trim().toUpperCase();
  const env = ctx.keyEnv || COMMON_ENV;
  const base = { upstreamCode: c || null, upstreamMessage: message || null };
  const auth = (cause, action) => ({
    ...base, code: `SEOUL_${c}`, kind: "auth", status: 502, retryable: false,
    title: "인증키 문제로 서울시 API가 요청을 거부했어요",
    cause, userAction: USER_REPORT, operatorAction: action,
  });
  const request = (cause, action) => ({
    ...base, code: `SEOUL_${c}`, kind: "request", status: 502, retryable: false,
    title: "서울시 API 요청 형식에 문제가 있어요",
    cause, userAction: USER_REPORT, operatorAction: action,
  });
  const upstream = (cause, action) => ({
    ...base, code: `SEOUL_${c || "UNKNOWN"}`, kind: "upstream", status: 502, retryable: true,
    title: "서울시 API 서버에 일시적인 문제가 있어요",
    cause, userAction: USER_RETRY, operatorAction: action,
  });

  switch (c) {
    case "INFO-100":
      return auth("서울시 Open API가 인증키를 유효하지 않다고 응답했습니다 (INFO-100).",
        `${VERCEL_ENV_HINT}에서 ${env} 값이 열린데이터광장에서 발급받은 인증키와 같은지 확인하세요. 앞뒤 공백이나 URL 전체를 붙여 넣지 않았는지도 확인하고, 수정 후에는 재배포(Redeploy)해야 적용됩니다.`);
    case "INFO-300":
      return auth("관리자에 의해 인증키 사용이 제한되었습니다 (INFO-300).",
        `서울 열린데이터광장 마이페이지 → 인증키 관리에서 ${env}에 넣은 키의 상태를 확인하거나 새 키를 발급받으세요.`);
    case "INFO-400":
      return auth("이 인증키에 해당 서비스 사용 권한이 없습니다 (INFO-400).",
        `열린데이터광장에서 ${ctx.service} 데이터셋(${ctx.dataset}) 사용 권한을 확인하세요. 서비스마다 다른 키를 받았다면 ${ctx.envKey}에 해당 서비스 전용 키를 넣으세요.`);
    case "ERROR-337":
      return { ...upstream("서울시 Open API의 일일 호출 한도를 초과했습니다 (ERROR-337).",
        "호출 한도는 보통 다음 날 초기화됩니다. 캐시 시간이 너무 짧지 않은지 확인하세요."), kind: "quota", retryable: false,
        title: "오늘의 데이터 호출 한도를 넘었어요", userAction: "내일 다시 확인해 주세요. 급하면 역무원·운영기관 안내를 이용해 주세요." };
    case "ERROR-310":
      return request("서울시 Open API가 해당 서비스를 찾지 못했습니다 (ERROR-310).",
        `서비스명 ${ctx.service}가 바뀌었을 수 있습니다. 열린데이터광장 ${ctx.dataset} 페이지의 요청 주소를 확인해 api/facilities.js의 SERVICES를 수정하세요.`);
    case "ERROR-300": case "ERROR-301": case "ERROR-331": case "ERROR-332":
    case "ERROR-333": case "ERROR-334": case "ERROR-335": case "ERROR-336":
      return request(`서울시 Open API가 요청 값이 잘못되었다고 응답했습니다 (${c}).`,
        `요청 주소 형식(인증키/xml/${ctx.service}/시작/끝)과 페이지 범위(최대 1000건)를 확인하세요. 응답 메시지: ${message || "없음"}`);
    case "ERROR-500": case "ERROR-600": case "ERROR-601":
      return upstream(`서울시 Open API 서버 내부 오류입니다 (${c}).`,
        "서울 열린데이터광장 공지사항에서 점검 여부를 확인하세요. 오래 지속되면 열린데이터광장 Q&A로 문의하세요.");
    // 공공데이터포털 형식 코드
    case "30": case "SERVICE_KEY_IS_NOT_REGISTERED_ERROR":
      return auth("등록되지 않은 인증키라는 응답을 받았습니다 (30).", `${VERCEL_ENV_HINT}의 ${env} 값을 확인하세요.`);
    case "31": case "DEADLINE_HAS_EXPIRED_ERROR":
      return auth("인증키 활용 기간이 만료되었습니다 (31).", "인증키 활용 기간을 연장하거나 새로 발급받으세요.");
    case "20": case "SERVICE_ACCESS_DENIED_ERROR":
      return auth("서비스 접근이 거부되었습니다 (20).", `${ctx.service} 사용 승인 여부를 확인하세요.`);
    case "22": case "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR":
      return { ...upstream("서비스 요청 한도를 초과했습니다 (22).", "다음 날 다시 시도하거나 한도 상향을 신청하세요."),
        kind: "quota", retryable: false, title: "오늘의 데이터 호출 한도를 넘었어요", userAction: "내일 다시 확인해 주세요." };
    case "10": case "11": case "12":
      return request(`요청 파라미터 또는 서비스 주소 오류입니다 (${c}).`, `서비스명 ${ctx.service}와 요청 형식을 확인하세요.`);
    default:
      return upstream(`서울시 Open API가 오류 코드를 반환했습니다 (${c || "코드 없음"}${message ? `: ${message}` : ""}).`,
        "응답 메시지를 확인하고, 계속되면 열린데이터광장에 문의하세요.");
  }
}

function isSuccessCode(code) {
  const c = String(code || "").trim().toUpperCase();
  return c === "INFO-000" || c === "00" || c === "0" || c === "NORMAL_SERVICE" || c === "NORMAL SERVICE.";
}
function isNoDataCode(code) {
  const c = String(code || "").trim().toUpperCase();
  return c === "INFO-200" || c === "03" || c === "NODATA_ERROR";
}

function configError(code, cause, operatorAction) {
  return new ProxyError({
    code, kind: "config", status: 503, retryable: false,
    title: "서버에 데이터 연결 설정이 되어 있지 않아요",
    cause, userAction: USER_REPORT, operatorAction,
  });
}

/* ------------------------------------------------------------------ */
/* 인증키                                                              */
/* ------------------------------------------------------------------ */

function resolveKey(meta, env) {
  const specific = typeof env[meta.envKey] === "string" ? env[meta.envKey].trim() : "";
  const common = typeof env[COMMON_ENV] === "string" ? env[COMMON_ENV].trim() : "";
  const keyEnv = specific ? meta.envKey : common ? COMMON_ENV : null;
  const key = specific || common;
  if (!key) {
    throw configError("CONFIG_MISSING_KEY",
      `서버 환경변수에 서울시 Open API 인증키(${COMMON_ENV} 또는 ${meta.envKey})가 없습니다.`,
      `${VERCEL_ENV_HINT}에 ${COMMON_ENV}(공통) 또는 ${meta.envKey}(이 서비스 전용)를 추가하고 Production에 체크한 뒤 재배포(Redeploy)하세요. 로컬에서는 .env.local 파일에 넣으세요.`);
  }
  if (/openapi\.seoul\.go\.kr|https?:|\//i.test(key)) {
    throw configError("CONFIG_KEY_LOOKS_LIKE_URL",
      `${keyEnv} 환경변수에 인증키가 아니라 URL이 들어 있습니다.`,
      `${keyEnv}에는 요청 주소의 "8088/" 뒤부터 "/xml" 앞까지, 인증키 부분만 넣으세요. 수정 후 재배포하세요.`);
  }
  if (!/^[A-Za-z0-9]+$/.test(key)) {
    throw configError("CONFIG_INVALID_KEY",
      `${keyEnv} 환경변수 값에 인증키에 쓰이지 않는 문자(공백·따옴표 등)가 들어 있습니다.`,
      `${keyEnv} 값을 따옴표 없이 영문·숫자 인증키만 남기고 다시 저장한 뒤 재배포하세요.`);
  }
  return { key, keyEnv };
}

/* ------------------------------------------------------------------ */
/* 호출                                                                */
/* ------------------------------------------------------------------ */

function redact(text, key) {
  if (!text) return text;
  let out = String(text);
  if (key) out = out.split(key).join("***");
  return out.replace(/(openapi\.seoul\.go\.kr:8088\/)[^/]+/gi, "$1***");
}

function buildUrl(baseUrl, key, service, start, end) {
  return `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(key)}/xml/${service}/${start}/${end}/`;
}

async function fetchPage(opts, ctx, start, end) {
  const { fetchImpl, baseUrl, requestTimeoutMs } = opts;
  const url = buildUrl(baseUrl, ctx.key, ctx.service, start, end);
  const remaining = ctx.deadline - Date.now();
  if (remaining <= 500) {
    throw new ProxyError(timeoutInfo(ctx, requestTimeoutMs));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(requestTimeoutMs, remaining));
  let response;
  let text;
  try {
    response = await fetchImpl(url, { headers: { Accept: "application/xml, text/xml" }, signal: controller.signal });
    text = await response.text();
  } catch (err) {
    if (err && (err.name === "AbortError" || controller.signal.aborted)) {
      throw new ProxyError(timeoutInfo(ctx, requestTimeoutMs));
    }
    const netCode = (err && err.cause && err.cause.code) || (err && err.code) || "";
    throw new ProxyError({
      code: "UPSTREAM_UNREACHABLE", kind: "network", status: 502, retryable: true,
      title: "서버가 서울시 API에 연결하지 못했어요",
      cause: `서버에서 서울시 Open API(openapi.seoul.go.kr:8088)에 연결하지 못했습니다${netCode ? ` (${netCode})` : ""}.`,
      userAction: USER_RETRY,
      operatorAction: "서울 열린데이터광장 점검 공지를 확인하세요. 계속되면 Vercel Functions 로그에서 오류 코드를 확인하고, vercel.json의 regions가 icn1(서울)인지 확인하세요.",
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new ProxyError({
      code: `UPSTREAM_HTTP_${response.status}`, kind: "upstream", status: 502, retryable: response.status >= 500 || response.status === 429,
      title: "서울시 API 서버가 오류 상태로 응답했어요",
      cause: `서울시 Open API가 HTTP ${response.status} 상태로 응답했습니다.`,
      userAction: USER_RETRY,
      operatorAction: "잠시 후에도 계속되면 열린데이터광장 공지사항을 확인하세요.",
    });
  }

  const parsed = parseSeoulXml(text);
  if (parsed.kind !== "xml") {
    throw new ProxyError({
      code: "UPSTREAM_NOT_XML", kind: "upstream", status: 502, retryable: true,
      title: "서울시 API가 예상과 다른 응답을 보냈어요",
      cause: parsed.kind === "html"
        ? "서울시 Open API가 데이터 대신 웹페이지(HTML)를 반환했습니다. 점검 중이거나 주소가 바뀌었을 수 있습니다."
        : "서울시 Open API 응답을 XML로 해석하지 못했습니다.",
      userAction: USER_RETRY,
      operatorAction: `열린데이터광장 ${ctx.dataset} 페이지에서 샘플 URL을 브라우저로 열어 응답 형식을 확인하세요.`,
    });
  }

  if (parsed.code !== null && !isSuccessCode(parsed.code)) {
    if (isNoDataCode(parsed.code)) return { rows: [], totalCount: 0, format: parsed.format, noData: true };
    throw new ProxyError(upstreamCodeInfo(parsed.code, redact(parsed.message, ctx.key), ctx));
  }
  if (parsed.code === null && !parsed.rows.length) {
    throw new ProxyError({
      code: "UPSTREAM_UNEXPECTED", kind: "upstream", status: 502, retryable: true,
      title: "서울시 API 응답에서 데이터를 찾지 못했어요",
      cause: "XML 응답에 결과 코드와 시설 항목(row/item)이 모두 없습니다.",
      userAction: USER_RETRY,
      operatorAction: `열린데이터광장 ${ctx.dataset} 페이지의 샘플 응답과 비교해 응답 구조가 바뀌었는지 확인하세요.`,
    });
  }
  return { rows: parsed.rows, totalCount: parsed.totalCount, format: parsed.format };
}

function timeoutInfo(ctx, ms) {
  return {
    code: "UPSTREAM_TIMEOUT", kind: "timeout", status: 504, retryable: true,
    title: "서울시 API 응답이 너무 늦어요",
    cause: `서울시 Open API가 ${Math.round(ms / 1000)}초 안에 응답하지 않았습니다.`,
    userAction: USER_RETRY,
    operatorAction: "vercel.json의 regions가 icn1(서울)로 배포되었는지 확인하세요(Deployment → Functions 탭). 계속되면 열린데이터광장 점검 여부를 확인하세요.",
  };
}

async function fetchPageWithRetry(opts, ctx, start, end) {
  try {
    return await fetchPage(opts, ctx, start, end);
  } catch (err) {
    const retryable = err instanceof ProxyError && err.info.retryable;
    if (!retryable || ctx.deadline - Date.now() < opts.requestTimeoutMs + 500) throw err;
    await new Promise((r) => setTimeout(r, 400));
    return fetchPage(opts, ctx, start, end);
  }
}

/**
 * 2페이지 이후 요청 주소를 만드는 방식
 *  - range: 서울 열린데이터광장 표준 (시작번호/끝번호) → /1001/2000/
 *  - page : 서울시 게이트웨이가 공공데이터포털 API의 pageNo/numOfRows로 그대로 넘기는 경우 → /2/1000/
 * 실제 응답(2026-10 확인)은 공공데이터포털 형식(resultCode 00, pageNo·numOfRows·totalCount)이라
 * 어느 쪽인지 알 수 없으므로 2페이지에서 새 데이터가 오는 방식을 골라 나머지 페이지에 씁니다.
 */
// 마지막 페이지도 1,000건 단위로 요청합니다. (끝번호가 전체 건수보다 커도 서울시 API는 있는 만큼만 돌려줍니다.
// 예: 전체 21건인 도우미를 /1/1000/ 으로 요청해 정상 응답을 받음. 단위를 자르면 페이지 변환 게이트웨이에서 어긋남)
function pageRange(mode, page, size) {
  return mode === "page" ? [page, size] : [(page - 1) * size + 1, page * size];
}
const rowSig = (r) => JSON.stringify(r);

async function collectService(opts, meta, keyInfo) {
  const ctx = { ...meta, key: keyInfo.key, keyEnv: keyInfo.keyEnv, deadline: Date.now() + opts.totalBudgetMs };
  const size = opts.pageSize;
  const first = await fetchPageWithRetry(opts, ctx, 1, size);
  const seen = new Set();
  let rows = [];
  const addRows = (list) => {
    let added = 0;
    for (const r of list) {
      const sig = rowSig(r);
      if (seen.has(sig)) continue; // 겹치는 범위로 생긴 중복 제거
      seen.add(sig);
      rows.push(r);
      added++;
    }
    return added;
  };
  addRows(first.rows);
  const total = first.totalCount !== null ? first.totalCount : rows.length;
  let warning = null;
  let pagingMode = null;

  if (!first.noData && total > rows.length) {
    const lastPage = Math.min(Math.ceil(total / size), opts.maxPages);
    let failed = null;

    // 2페이지: 표준 방식 → 새 데이터가 없으면 페이지 번호 방식으로 한 번 더
    for (const mode of ["range", "page"]) {
      if (lastPage < 2) break;
      try {
        const [s, e] = pageRange(mode, 2, size);
        const page = await fetchPageWithRetry(opts, ctx, s, e);
        if (addRows(page.rows) > 0) { pagingMode = mode; failed = null; break; }
      } catch (err) {
        failed = failed || err;
      }
    }

    // 3페이지 이후: 확인된 방식으로 병렬 수집
    if (pagingMode && lastPage > 2) {
      const pagesToFetch = [];
      for (let p = 3; p <= lastPage; p++) pagesToFetch.push(p);
      let cursor = 0;
      const worker = async () => {
        while (cursor < pagesToFetch.length && !failed) {
          const p = pagesToFetch[cursor++];
          try {
            const [s, e] = pageRange(pagingMode, p, size);
            const page = await fetchPageWithRetry(opts, ctx, s, e);
            addRows(page.rows);
          } catch (err) {
            failed = failed || err;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(opts.pageConcurrency, pagesToFetch.length) }, worker));
    }

    if (failed || rows.length < total) {
      const info = failed instanceof ProxyError ? failed.info : null;
      warning = {
        code: info ? info.code : pagingMode ? "PARTIAL_DATA" : "PAGINATION_UNSUPPORTED",
        title: "일부 데이터만 불러왔어요",
        cause: `전체 ${total.toLocaleString("ko-KR")}건 중 ${rows.length.toLocaleString("ko-KR")}건만 받았습니다.${info ? ` (${info.cause})` : !pagingMode ? " 2페이지 요청에서 새 데이터를 받지 못했습니다." : ""}`,
        userAction: "찾는 역의 정보가 없으면 잠시 후 다시 불러와 주세요.",
        operatorAction: info
          ? info.operatorAction
          : !pagingMode
            ? `서울시 게이트웨이가 ${ctx.service}의 1,000건 이후 페이지를 어떤 주소로 주는지 확인이 필요합니다. 브라우저에서 …/xml/${ctx.service}/1001/2000/ 과 …/xml/${ctx.service}/2/1000/ 을 열어 비교해 보세요.`
            : "페이지 수 제한(maxPages)과 응답 시간을 확인하세요.",
      };
    }
  }

  return {
    ok: true,
    type: meta.type,
    label: meta.label,
    service: meta.service,
    dataset: meta.dataset,
    format: first.format,
    pagingMode,
    totalCount: total,
    count: rows.length,
    partial: Boolean(warning),
    warning,
    fetchedAt: new Date().toISOString(),
    records: rows,
  };
}

/* ------------------------------------------------------------------ */
/* HTTP 핸들러                                                          */
/* ------------------------------------------------------------------ */

function send(res, status, body, cacheControl) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cacheControl || "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(body));
}

function createHandler(options = {}) {
  const opts = {
    ...DEFAULTS,
    fetchImpl: options.fetchImpl || ((...args) => globalThis.fetch(...args)),
    getEnv: options.getEnv || (() => process.env),
    logger: options.logger || console,
    mock: Boolean(options.mock),
    ...pick(options, ["baseUrl", "pageSize", "maxPages", "requestTimeoutMs", "totalBudgetMs", "pageConcurrency", "cacheTtlMs"]),
  };
  const cache = new Map();
  const inflight = new Map();

  return async function facilitiesHandler(req, res) {
    const method = (req.method || "GET").toUpperCase();
    if (method === "OPTIONS" || method === "HEAD") {
      res.statusCode = 204;
      res.setHeader("Allow", "GET");
      return res.end();
    }
    if (method !== "GET") {
      res.setHeader("Allow", "GET");
      return send(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", kind: "request", title: "지원하지 않는 요청 방식입니다", cause: "GET 요청만 지원합니다.", userAction: "", operatorAction: "" } });
    }

    const url = new URL(req.url || "/", "http://localhost");
    const type = (url.searchParams.get("type") || "").trim().toLowerCase();
    const env = opts.getEnv() || {};

    if (!type || type === "status") {
      return send(res, 200, {
        ok: true,
        mock: opts.mock || undefined,
        region: env.VERCEL_REGION || null,
        services: Object.values(SERVICES).map((s) => {
          const specific = typeof env[s.envKey] === "string" && env[s.envKey].trim();
          const common = typeof env[COMMON_ENV] === "string" && env[COMMON_ENV].trim();
          return { type: s.type, label: s.label, service: s.service, dataset: s.dataset, configured: Boolean(specific || common), keyEnv: specific ? s.envKey : common ? COMMON_ENV : null };
        }),
      });
    }

    const meta = SERVICES[type];
    if (!meta) {
      return send(res, 400, { ok: false, type, error: { code: "BAD_TYPE", kind: "request", status: 400, title: "알 수 없는 시설 종류입니다", cause: `type=${type.slice(0, 20)} 는 지원하지 않습니다.`, userAction: "", operatorAction: `type은 ${Object.keys(SERVICES).join(", ")} 중 하나여야 합니다.` } });
    }

    let keyInfo;
    try {
      keyInfo = resolveKey(meta, env);
    } catch (err) {
      return sendError(res, meta, err, opts, null);
    }

    const cacheKey = `${type}:${keyInfo.keyEnv}`;
    const hit = cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) {
      return send(res, 200, { ...hit.payload, cached: true }, "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
    }

    try {
      let job = inflight.get(cacheKey);
      if (!job) {
        job = collectService(opts, meta, keyInfo).finally(() => inflight.delete(cacheKey));
        inflight.set(cacheKey, job);
      }
      const payload = await job;
      if (opts.mock) payload.mock = true;
      if (!payload.partial) cache.set(cacheKey, { payload, expires: Date.now() + opts.cacheTtlMs });
      const cc = payload.partial ? "public, max-age=30, s-maxage=60" : "public, max-age=60, s-maxage=300, stale-while-revalidate=600";
      return send(res, 200, payload, cc);
    } catch (err) {
      return sendError(res, meta, err, opts, keyInfo.key);
    }
  };
}

function sendError(res, meta, err, opts, key) {
  let info;
  if (err instanceof ProxyError) {
    info = err.info;
  } else {
    info = {
      code: "PROXY_INTERNAL", kind: "internal", status: 500, retryable: true,
      title: "데이터 서버 내부 오류가 발생했어요",
      cause: "프록시 처리 중 예기치 않은 오류가 발생했습니다.",
      userAction: USER_RETRY,
      operatorAction: "Vercel → Deployment → Logs(Functions)에서 오류 내용을 확인하세요.",
    };
  }
  const safe = JSON.parse(redact(JSON.stringify(info), key));
  try {
    const detail = err instanceof ProxyError ? "" : ` ${redact(err && err.stack ? err.stack : String(err), key)}`;
    opts.logger.error(`[ieummap] ${meta.service} ${safe.code}: ${safe.cause}${detail}`);
  } catch { /* 로그 실패는 무시 */ }
  return send(res, safe.status || 502, {
    ok: false,
    type: meta.type,
    label: meta.label,
    service: meta.service,
    dataset: meta.dataset,
    error: safe,
  });
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

const handler = createHandler();
module.exports = handler;
module.exports.createHandler = createHandler;
module.exports._internal = { parseSeoulXml, upstreamCodeInfo, resolveKey, redact, buildUrl, SERVICES, DEFAULTS };

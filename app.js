const REPORTS_KEY = "ieummap-reports-v2";
// v6까지 인증키가 포함된 API URL을 브라우저에 저장하던 키 — 남아 있으면 지웁니다.
const LEGACY_URL_KEYS = ["ieummap-elevator-api-url-v1","ieummap-charger-api-url-v1","ieummap-lift-api-url-v1","ieummap-helper-api-url-v1","ieummap-toilet-api-url-v1"];
// 서울시 Open API는 서버 프록시(api/facilities.js)를 통해서만 호출합니다. 인증키는 브라우저에 없습니다.
const API_ENDPOINT = "/api/facilities";
const CLIENT_TIMEOUT_MS = 35000;
const SERVICES = [
  {type:"elevator",service:"getWksnElvtr",label:"엘리베이터",icon:"↕"},
  {type:"charger",service:"getWksnWhclCharge",label:"휠체어 급속충전기",icon:"⚡"},
  {type:"lift",service:"getWksnWhcllift",label:"휠체어 리프트",icon:"↗"},
  {type:"helper",service:"getWksnHelper",label:"교통약자 도우미",icon:"✚"},
  {type:"toilet",service:"getWksnRstrm",label:"장애인 화장실",icon:"♿"}
];
const SERVICE_BY_TYPE = Object.fromEntries(SERVICES.map(s=>[s.type,s]));
const $ = id => document.getElementById(id);
let currentStation = "시청역";
let liveRecords = [];
let liveLoaded = false;
let lastFetchAt = null;
let mockMode = false;
let loadRun = 0;
const recordsByType = {};
const serviceState = {};
SERVICES.forEach(s=>{recordsByType[s.type]=[];serviceState[s.type]={status:"idle"};});

/* ---------- 저장소 (브라우저 저장 공간이 막혀 있어도 화면은 동작) ---------- */
function storageGet(k){try{return localStorage.getItem(k)}catch{return null}}
function storageSet(k,v){try{localStorage.setItem(k,v);return true}catch{return false}}
function storageRemove(k){try{localStorage.removeItem(k)}catch{}}
// No sample data is presented as real-world station information.
// Reports entered by the user are stored locally in this browser.
function readReports(){ try{const v=JSON.parse(storageGet(REPORTS_KEY)||"[]");return Array.isArray(v)?v:[]}catch{return []} }
function saveReports(items){return storageSet(REPORTS_KEY,JSON.stringify(items))}

/* ---------- 공통 ---------- */
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
// "서울역", "서울", "충정로역(경기대입구)" 등 표기 차이를 맞춥니다.
function norm(s){return String(s||"").replace(/\s+/g,"").replace(/역(?=\(|$)/,"").toLowerCase()}
function stationKeys(name){const raw=String(name||"");const full=norm(raw);const base=norm(raw.replace(/\([^)]*\)/g,""));return full===base?[full]:[full,base]}
function sameStation(a,b){const B=stationKeys(b);return stationKeys(a).some(k=>k&&B.includes(k))}
function withYeok(name){const t=String(name||"").trim().replace(/\s+/g," ");if(!t)return "";const m=t.match(/^(.*?)(\(.*\))$/);const head=m?m[1]:t,tail=m?m[2]:"";return /역$/.test(head)?t:`${head}역${tail}`}
function stamp(d){if(!d)return "미확인";return new Intl.DateTimeFormat("ko-KR",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).format(d)}
function setConnection(state,text){const pill=$("connectionPill");pill.className=`connection-pill ${state}`;pill.innerHTML=`<i></i> ${esc(text)}`}
function trustLabel(item){
  if(item._userReport) return '<span class="trust-tag community">미확인 제보</span>';
  if(item._mock) return '<span class="trust-tag community">테스트용 모의 데이터</span>';
  if(item._live) return '<span class="trust-tag official">공식 API</span>';
  return '<span class="trust-tag community">확인 필요</span>';
}

/* ---------- API 필드 매칭 ---------- */
// 서울교통공사 교통약자 이용정보 API 필드: stnNm(역명) lineNm(호선) dtlPstn(상세위치) oprtngSitu(운영상황) fcltNm(시설명) …
// 서울 열린데이터광장은 같은 항목을 STN_NM처럼 대문자·밑줄로 줄 수도 있어, 비교할 때 대소문자와 _를 무시합니다.
function nk(key){return String(key||"").replace(/[_\s-]/g,"").toLowerCase()}
function fieldKey(record,names){const keys=Object.keys(record||{}).filter(k=>!k.startsWith("_"));for(const n of names){const k=keys.find(x=>nk(x)===nk(n));if(k)return k}return null}
function val(record,name){const k=fieldKey(record,[name]);return k?String(record[k]??"").trim():""}
function recordStation(record){
  const key=fieldKey(record,["stnNm","stationNm","stationName","statnNm","stnKrNm"])
    ||Object.keys(record||{}).find(k=>!k.startsWith("_")&&/역명|역이름|역사명|stationname|sttnnm|statnnm|^stnnm/.test(nk(k)));
  return key ? String(record[key]??"").trim() : "";
}
function allRecordText(record){return Object.entries(record||{}).filter(([k])=>!k.startsWith("_")).map(([k,v])=>`${k} ${v??""}`).join(" ")}
function getField(record,patterns){
  const key=Object.keys(record||{}).find(k=>!k.startsWith("_")&&patterns.some(p=>p.test(k)||p.test(nk(k))));
  return key ? record[key] : "";
}
const SITU_CODES={
  M:{label:"사용 가능",cls:"ok"},S:{label:"보수 중",cls:"down"},T:{label:"운행 중지",cls:"down"},
  I:{label:"점검 중",cls:"down"},B:{label:"공사 중",cls:"down"},D:{label:"삭제된 시설",cls:"down"}
};
function isDeleted(record){return val(record,"oprtngSitu").toUpperCase()==="D"}
function statusFor(record){
  const code=val(record,"oprtngSitu").toUpperCase();
  if(SITU_CODES[code])return {...SITU_CODES[code],code};
  const value=String(getField(record,[/운영여부/i,/가동여부/i,/운행상태/i,/운영상태/i,/status/i,/oprtng.?situ/i,/use.?yn/i,/가동상태/i])||"").trim();
  const moving=record._type==="elevator"||record._type==="lift";
  if(!value)return {label:moving?"운행 상태 확인 필요":"상태 정보 없음",cls:"unknown"};
  if(/고장|중지|운휴|점검|미운영|불가|정지|보수|공사|^N$|^NO$|DOWN|FALSE/i.test(value))return {label:value,cls:"down"};
  if(/정상|운영|가동|운행|가능|^Y$|YES|UP|TRUE/i.test(value))return {label:value,cls:"ok"};
  return {label:value,cls:"unknown"};
}
const FIELD_LABELS={stnNm:"역명",lineNm:"호선",dtlPstn:"상세 위치",oprtngSitu:"운영 상태",fcltNm:"시설명",fcltNo:"시설번호",crtrYmd:"기준일",mngNo:"관리번호",stnCd:"역 코드",stnNo:"역 번호",pscpNope:"정원",pscpWht:"적재 하중",vcntEntrcNo:"인근 출입구",elvtrSn:"일련번호",telno:"전화번호"};
const TOKEN_LABELS={stn:"역",nm:"명",line:"호선",dtl:"상세",pstn:"위치",oprtng:"운영",situ:"상태",fclt:"시설",no:"번호",crtr:"기준",ymd:"일자",mng:"관리",cd:"코드",bgng:"시작",bgn:"시작",end:"종료",flr:"층",grnd:"지상",udgd:"지하",se:"구분",pscp:"정원",nope:"인원",wht:"중량",vcnt:"인근",entrc:"출입구",elvtr:"엘리베이터",sn:"일련번호",telno:"전화번호",tel:"전화",hr:"시간",tm:"시각",cnt:"개수",qty:"수량",gate:"게이트",inot:"내외",addr:"주소",rmrk:"비고",yn:"여부",whcl:"휠체어",chrg:"충전",use:"이용",info:"정보",lc:"위치",plc:"장소",wd:"평일",sat:"토요일",hldy:"휴일",psblty:"가능",psb:"가능",knd:"종류",ty:"유형"};
const FIELD_LABELS_N=Object.fromEntries(Object.entries(FIELD_LABELS).map(([k,v])=>[nk(k),v]));
function fieldLabel(key){
  if(FIELD_LABELS_N[nk(key)])return FIELD_LABELS_N[nk(key)];
  if(/[가-힣]/.test(key))return key;
  const tokens=key.replace(/([a-z0-9])([A-Z])/g,"$1 $2").toLowerCase().split(/[\s_]+/).filter(Boolean);
  return tokens.length&&tokens.every(t=>TOKEN_LABELS[t])?tokens.map(t=>TOKEN_LABELS[t]).join(" "):key;
}
function formatValue(key,value){
  const v=String(value??"").trim();
  if(/ymd$/i.test(key)&&/^\d{8}$/.test(v))return `${v.slice(0,4)}.${v.slice(4,6)}.${v.slice(6)}`;
  const k=nk(key);
  if(k==="pscpnope"&&/^\d+$/.test(v))return `${v}명`;
  if(k==="pscpwht"&&/^\d+$/.test(v))return `${Number(v).toLocaleString("ko-KR")}kg`;
  // 실제 값 예: "2", "1,10" (여러 출입구)
  if(k==="vcntentrcno"&&/^\d+(-\d+)?(\s*,\s*\d+(-\d+)?)*$/.test(v))return `${v.split(/\s*,\s*/).join(", ")}번 출입구`;
  return v;
}
// 실제 층 값은 "지하"+"B1", "지상"+"4" 형태로 옵니다 → "지하 1층", "지상 4층"
function floorText(se,flr){
  const f=String(flr||"").trim();if(!f)return "";
  const s=String(se||"").trim();
  if(/층/.test(f))return f;
  const basement=f.match(/^B(\d+)$/i);
  if(basement)return `지하 ${basement[1]}층`;
  const n=(f.match(/^(\d+)F$/i)||[])[1]||f;
  if(/지하|udgd|^u$|^b$/i.test(s))return `지하 ${n}층`;
  if(/지상|grnd|^g$/i.test(s))return `지상 ${n}층`;
  return `${s?s+" ":""}${n}층`;
}
// 교통약자 도우미 등: 전화번호 필드(이름 미확인)를 값 형태로 찾아 바로 걸 수 있게 표시
function phoneOf(r){
  for(const [k,v] of Object.entries(r||{})){
    if(k.startsWith("_"))continue;
    const digits=String(v??"").replace(/[\s()-]/g,"");
    if(/^0\d{8,10}$/.test(digits))return {key:k,digits,text:formatPhone(digits)};
  }
  return null;
}
function formatPhone(d){
  if(/^02\d{7,8}$/.test(d))return d.length===9?`02-${d.slice(2,5)}-${d.slice(5)}`:`02-${d.slice(2,6)}-${d.slice(6)}`;
  if(d.length===11)return `${d.slice(0,3)}-${d.slice(3,7)}-${d.slice(7)}`;
  if(d.length===10)return `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`;
  return d;
}
function floorRange(r){const b=floorText(val(r,"bgngFlrGrndUdgdSe"),val(r,"bgngFlr"));const e=floorText(val(r,"endFlrGrndUdgdSe"),val(r,"endFlr"));return b&&e?`${b} ↔ ${e}`:""}
const HIDDEN_FIELDS=new Set(["stnnm","linenm","dtlpstn","fcltnm","oprtngsitu","bgngflr","endflr","bgngflrgrndudgdse","endflrgrndudgdse","stncd","stnno","mngno","fcltno","elvtrsn"]);

/* ---------- 역별 시설 ---------- */
function findRecordsForStation(){
  const out=[];
  for(const s of SERVICES){
    const list=recordsByType[s.type]||[];
    if(!list.length)continue;
    if(list.some(r=>recordStation(r))){
      out.push(...list.filter(r=>sameStation(recordStation(r),currentStation)));
    }else{
      // 역 이름 필드를 찾지 못한 데이터셋만 전체 텍스트로 찾습니다.
      const target=norm(currentStation);
      out.push(...list.filter(r=>norm(allRecordText(r)).includes(target)));
    }
  }
  return out.filter(r=>!isDeleted(r));
}
// 실제 시설명 예: "승강기)엘리베이터-동묘앞 1-1번 출구측 외부#1", "건축)대합실화장실-동묘앞(1) B1", "전동휠체어 충전설비-"
const TYPE_KEYWORD={elevator:"엘리베이터",charger:"충전",lift:"리프트",helper:"도우미",toilet:"화장실"};
function cleanName(name){return String(name||"").trim().replace(/^[가-힣A-Za-z]{1,6}\)\s*/,"").replace(/[-\s]+$/,"").trim()}
function facilityTitle(r,category){
  const name=cleanName(getField(r,[/^fcltNm$/i,/시설명/i,/엘리베이터명/i,/설비명/i,/승강기명/i,/elevator.?name/i,/elvtr.?nm/i,/충전기명/i,/화장실명/i]));
  if(!name)return category;
  return norm(name).includes(norm(TYPE_KEYWORD[r._type]||category))?name:`${category} · ${name}`;
}
function facilityCard(r){
  const category=r._category||"시설";
  const icon=(SERVICE_BY_TYPE[r._type]||{}).icon||"•";
  const phone=phoneOf(r);
  const place=String(getField(r,[/^dtlPstn$/i,/설치위치/i,/시설위치/i,/상세설명/i,/위치정보/i,/위치/i,/location/i,/detail/i,/설명/i])||"").trim();
  const location=place||(phone?`도움 요청 전화 ${phone.text}`:"위치 항목을 API에서 확인할 수 없습니다.");
  const line=val(r,"lineNm")||String(getField(r,[/호선/i,/노선/i,/^line/i])||"").trim();
  const status=statusFor(r);
  const range=floorRange(r);
  const tags=[];
  if(range)tags.push(["운행 구간",range]);
  for(const [k,v] of Object.entries(r)){
    if(k.startsWith("_")||HIDDEN_FIELDS.has(nk(k))||v===null||String(v).trim()==="")continue;
    if(phone&&k===phone.key)continue;
    if(r._category&&/역명|역이름|station.?name/i.test(k))continue;
    tags.push([fieldLabel(k),formatValue(k,v)]);
  }
  const call=phone?`<a class="detail-tag phone-link" href="tel:${esc(phone.digits)}"><strong>전화 걸기</strong> ${esc(phone.text)}</a>`:"";
  const detail=call+tags.slice(0,6).map(([k,v])=>`<span class="detail-tag"><strong>${esc(k)}</strong> ${esc(v)}</span>`).join("");
  const source=r._mock?"로컬 테스트 파일":"서울 열린데이터광장";
  const checked=stamp((serviceState[r._type]||{}).fetchedAt||lastFetchAt);
  return `<article class="facility-card"><div class="facility-main"><span class="facility-icon">${icon}</span><div class="facility-copy"><h4>${esc(facilityTitle(r,category))}</h4><p>${esc(location)}${line?` · ${esc(line)}`:""}</p></div><span class="status-chip ${status.cls}">${esc(status.label)}</span></div><div class="facility-details">${trustLabel(r)}<span class="detail-tag"><strong>출처</strong> ${esc(source)}</span><span class="detail-tag"><strong>조회</strong> ${esc(checked)}</span></div>${detail?`<div class="facility-details">${detail}</div>`:""}</article>`;
}
function sortRecords(list){
  const order=Object.fromEntries(SERVICES.map((s,i)=>[s.type,i]));
  return list.slice().sort((a,b)=>(order[a._type]-order[b._type])||val(a,"lineNm").localeCompare(val(b,"lineNm"),"ko",{numeric:true})||val(a,"fcltNm").localeCompare(val(b,"fcltNm"),"ko",{numeric:true}));
}
function errorDetails(e){
  if(!e)return "";
  return `<dl class="cause-list"><dt>원인</dt><dd>${esc(e.cause)}</dd><dt>해결 방법</dt><dd>${esc(e.userAction||"잠시 후 다시 시도해 주세요.")}</dd>${e.operatorAction?`<dt>운영자 확인</dt><dd>${esc(e.operatorAction)}</dd>`:""}${e.upstreamMessage?`<dt>서울시 응답</dt><dd>${esc(e.upstreamMessage)}</dd>`:""}</dl>`;
}
function failedServices(){return SERVICES.filter(s=>serviceState[s.type].status==="error")}
function loadingServices(){return SERVICES.filter(s=>serviceState[s.type].status==="loading"||serviceState[s.type].status==="idle")}
function updateCategoryOptions(matches){
  const sel=$("categoryFilter");
  const counts={};matches.forEach(r=>{counts[r._type]=(counts[r._type]||0)+1});
  [...sel.options].forEach(opt=>{
    if(opt.value==="all"){opt.textContent=liveLoaded?`전체 (${matches.length})`:"전체";return}
    const s=SERVICE_BY_TYPE[opt.value];const st=serviceState[opt.value].status;
    opt.textContent=st==="ok"?`${s.label} (${counts[opt.value]||0})`:st==="error"?`${s.label} (불러오기 실패)`:`${s.label} (불러오는 중)`;
  });
}
function renderNotice(){
  const box=$("facilityNotice");
  const failed=failedServices(), loading=loadingServices();
  const partial=SERVICES.filter(s=>serviceState[s.type].status==="ok"&&serviceState[s.type].partial);
  if(!liveLoaded||(!failed.length&&!loading.length&&!partial.length)){box.classList.add("hidden");box.innerHTML="";return}
  let html="";
  if(failed.length){
    const first=serviceState[failed[0].type].error||{};
    html=`<span class="notice-icon">!</span><div><b>${esc(failed.map(s=>s.label).join(" · "))} 정보를 불러오지 못했어요</b><p>${esc(first.title||"")}${failed.length>1?" 등":""}. 다른 시설 정보는 정상적으로 표시됩니다.</p><button type="button" class="link-button" data-open-status>원인과 해결 방법 보기</button></div>`;
  }else if(partial.length){
    html=`<span class="notice-icon">!</span><div><b>${esc(partial.map(s=>s.label).join(" · "))} 정보는 일부만 불러왔어요</b><p>찾는 시설이 없으면 잠시 후 다시 불러와 주세요.</p><button type="button" class="link-button" data-open-status>자세히 보기</button></div>`;
  }else{
    html=`<span class="notice-icon loading-dot"></span><div><b>나머지 시설 정보를 불러오는 중이에요</b><p>${esc(loading.map(s=>s.label).join(" · "))}</p></div>`;
  }
  box.innerHTML=html;box.classList.remove("hidden");
}
function renderElevators(){
  const matches=findRecordsForStation();
  const elevators=matches.filter(r=>r._type==="elevator");
  const elvState=serviceState.elevator.status;
  $("elevatorCount").textContent=elvState==="ok"?elevators.length:elvState==="error"?"—":"…";
  $("elevatorSub").textContent=liveLoaded?`이 역 전체 시설 ${matches.length}건 중`:"이 역의 엘리베이터 정보";
  $("elevatorBar").style.width=elvState==="ok"?`${Math.min(100,elevators.length*16)}%`:"0%";
  updateCategoryOptions(matches);
  renderNotice();
  if(!liveLoaded){
    const failed=failedServices();
    const allFailed=failed.length===SERVICES.length;
    $("dataSourceBadge").className="source-badge demo";
    $("dataSourceBadge").textContent=allFailed?"연결 실패":"불러오는 중";
    $("trustCount").textContent=allFailed?"연결 실패":"불러오는 중";
    if(!allFailed){
      $("elevatorList").innerHTML=`<div class="empty-state"><span class="empty-icon loading-icon">↻</span><b>시설 정보를 불러오는 중이에요</b><p>서울시 공공데이터를 서버에서 받아오고 있어요. 잠시만 기다려 주세요.</p></div>`;
      return;
    }
    const errs=failed.map(s=>serviceState[s.type].error||{});
    const same=errs.every(e=>e.code===errs[0].code);
    const e=errs[0];
    $("elevatorList").innerHTML=`<div class="empty-state error-state"><span class="empty-icon">!</span><b>${esc(e.title||"시설 정보를 불러오지 못했어요")}</b>${errorDetails(e)}${same?"":`<p>서비스마다 원인이 다를 수 있어요. ‘연결 상태 보기’에서 확인해 주세요.</p>`}<div class="empty-actions"><button type="button" class="button button-green" data-reload>다시 불러오기 <span>↻</span></button><button type="button" class="button button-outline" data-open-status>연결 상태 보기</button></div></div>`;
    return;
  }
  $("dataSourceBadge").className=mockMode?"source-badge demo":"source-badge live";
  $("dataSourceBadge").textContent=mockMode?"테스트용 모의 데이터":"서울 공공데이터";
  $("trustCount").textContent=matches.length?(mockMode?"모의 데이터":"공식 출처"):"자료 없음";
  const cat=$("categoryFilter").value;
  const shown=sortRecords(cat==="all"?matches:matches.filter(r=>r._type===cat));
  if(!shown.length){
    const s=SERVICE_BY_TYPE[cat];
    if(s&&serviceState[cat].status==="error"){
      const e=serviceState[cat].error||{};
      $("elevatorList").innerHTML=`<div class="empty-state error-state"><span class="empty-icon">!</span><b>${esc(s.label)} 정보를 불러오지 못했어요</b>${errorDetails(e)}<div class="empty-actions"><button type="button" class="button button-green" data-reload>다시 불러오기 <span>↻</span></button></div></div>`;
      return;
    }
    const what=s?s.label:"시설";
    $("elevatorList").innerHTML=`<div class="empty-state"><span class="empty-icon">⌕</span><b>${esc(currentStation)} ${esc(what)} 데이터가 없어요</b><p>API가 반환한 자료에서 이 역을 찾지 못했습니다. 역명 표기를 확인하거나 자동완성 목록에서 역을 골라 보세요. 서울교통공사 운영 구간만 포함되며, ‘정보 없음’은 시설이 없다는 뜻이 아닙니다.</p></div>`;
    return;
  }
  $("elevatorList").innerHTML=shown.map(r=>facilityCard(r)).join("");
}

/* ---------- 이용자 제보 (이 브라우저에만 저장) ---------- */
function getStationReports(){return readReports().filter(r=>sameStation(r.station,currentStation))}
function renderReports(){
  const reports=getStationReports();
  const type=$("issueFilter").value, trust=$("trustFilter").value;
  const filtered=reports.filter(r=>{
    const elevator=String(r.type).includes("엘리베이터");
    return (type==="all"||(type==="elevator"?elevator:!elevator)) &&
      (trust==="all"||(trust==="community"&&!r.verified)||(trust==="checked"&&r.verified));
  });
  $("issueCount").textContent=reports.length;
  $("issueBar").style.width=`${Math.min(100,reports.length*18)}%`;
  $("emptyIssues").classList.toggle("hidden",filtered.length>0);
  $("issueList").innerHTML=filtered.map(r=>`<article class="report-item"><div class="report-item-head"><span class="report-icon">${String(r.type).includes("엘리베이터")?"↕":"!"}</span><div><h4>${esc(r.type)}</h4><p class="location">${esc(r.location)} · ${esc(r.when||"시점 미기록")}</p></div>${r.verified?'<span class="trust-tag checked">확인 기록 있음</span>':'<span class="trust-tag community">미확인 제보</span>'}</div><p class="desc">${esc(r.description)}</p><div class="report-meta"><span class="detail-tag">출처: 이용자 제보</span><span class="detail-tag">상태: ${r.verified?"확인 기록 있음":"검토 전"}</span><span class="detail-tag">이 기기에만 저장</span></div></article>`).join("");
}

/* ---------- 화면 갱신 ---------- */
function renderStationView(){
  $("stationName").textContent=currentStation;
  const matches=findRecordsForStation();
  const lines=[...new Set(matches.map(r=>val(r,"lineNm")).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"ko",{numeric:true}));
  const failedAll=failedServices().length===SERVICES.length;
  $("stationMeta").textContent=liveLoaded
    ?`${mockMode?"테스트용 모의 데이터":"서울교통공사 공공데이터"} · 시설 ${matches.length}건${lines.length?` · ${lines.join(" · ")}`:""}`
    :failedAll?"공공데이터 연결 실패 · 시설 정보 미표시":"공공데이터 불러오는 중…";
  $("lastUpdated").textContent=lastFetchAt?stamp(lastFetchAt):"아직 조회 전";
  renderElevators();renderReports();
}
function renderStation(name){
  currentStation=withYeok(name)||currentStation;
  $("reportStation").value=currentStation;
  renderStationView();
}
function searchResultMessage(){
  if(liveLoaded){
    const n=findRecordsForStation().length;
    return n?`${currentStation} 시설 정보 ${n}건을 찾았어요.`:`${currentStation} 데이터를 찾지 못했어요. 자동완성 목록에서 역을 골라 보세요.`;
  }
  return failedServices().length===SERVICES.length?"시설 데이터를 불러오지 못했어요. ⚙ 데이터 연결 상태를 확인해 주세요.":"시설 정보를 불러오는 중이에요. 잠시 후 결과가 표시돼요.";
}
function updateConnection(){
  const st=SERVICES.map(s=>serviceState[s.type].status);
  const ok=st.filter(x=>x==="ok").length, loading=st.filter(x=>x==="loading"||x==="idle").length, total=SERVICES.length;
  if(loading&&!ok)setConnection("loading","데이터 불러오는 중");
  else if(loading)setConnection("loading",`불러오는 중 ${ok}/${total}`);
  else if(ok===total)setConnection("connected",mockMode?"모의 데이터 연결됨":"공공데이터 연결됨");
  else if(ok)setConnection("partial",`일부 연결됨 ${ok}/${total}`);
  else setConnection("error","데이터 연결 실패");
}
/* ---------- 필드 이름 보기 (실제 응답의 필드 이름 확인용) ---------- */
const FIELD_ROLES={stnnm:"역명 · 검색에 사용",linenm:"호선",dtlpstn:"상세 위치",fcltnm:"시설명 · 카드 제목",oprtngsitu:"운영 상태",bgngflr:"운행 구간(시작 층)",endflr:"운행 구간(끝 층)",bgngflrgrndudgdse:"운행 구간(시작 지상/지하)",endflrgrndudgdse:"운행 구간(끝 지상/지하)"};
function fieldSummary(type){
  const list=(recordsByType[type]||[]).slice(0,200);
  const keys=[];const example={};
  for(const r of list)for(const [k,v] of Object.entries(r)){
    if(k.startsWith("_"))continue;
    if(!keys.includes(k))keys.push(k);
    if(example[k]===undefined&&String(v??"").trim()!=="")example[k]=String(v).trim();
  }
  const phone=list.map(phoneOf).find(Boolean);
  return keys.map(k=>{
    const n=nk(k);
    let role=FIELD_ROLES[n];
    if(!role&&phone&&phone.key===k)role="전화 걸기";
    if(!role&&HIDDEN_FIELDS.has(n))role="표시 안 함(내부 번호)";
    if(!role){const label=fieldLabel(k);role=label===k?"미확인 · 원래 이름으로 표시":label}
    return {key:k,role,example:(example[k]||"").slice(0,40),unknown:role.startsWith("미확인")};
  });
}
function fieldListHtml(s){
  const rows=fieldSummary(s.type);
  if(!rows.length)return "";
  const unknown=rows.filter(r=>r.unknown).length;
  return `<details class="field-list"><summary>필드 이름 ${rows.length}개 보기${unknown?` · 미확인 ${unknown}개`:""}</summary><div class="field-table"><table><thead><tr><th>필드 이름</th><th>화면에서</th><th>예시 값</th></tr></thead><tbody>${rows.map(r=>`<tr class="${r.unknown?"unknown":""}"><td><code>${esc(r.key)}</code></td><td>${esc(r.role)}</td><td>${esc(r.example)}</td></tr>`).join("")}</tbody></table></div><button type="button" class="link-button" data-copy-fields="${esc(s.type)}">필드 이름 복사</button></details>`;
}
async function copyFields(type){
  const s=SERVICE_BY_TYPE[type];
  const text=[`[${s.label}] ${s.service}`,...fieldSummary(type).map(r=>`${r.key}\t${r.example}`)].join("\n");
  const box=$("apiStatus");
  try{await navigator.clipboard.writeText(text);box.textContent=`${s.label} 필드 이름을 복사했어요. 메시지에 붙여 넣어 보내 주세요.`}
  catch{box.textContent="자동 복사가 막혀 있어요. 표를 길게 눌러 선택하거나 화면을 캡처해 주세요."}
  box.classList.remove("hidden","error");
}
function renderServiceStatus(){
  $("serviceStatusList").innerHTML=SERVICES.map(s=>{
    const st=serviceState[s.type];
    let chip,detail="";
    if(st.status==="ok"){
      chip='<span class="status-chip ok">연결됨</span>';
      detail=`<small>${st.count.toLocaleString("ko-KR")}건${st.total&&st.total!==st.count?` / 전체 ${st.total.toLocaleString("ko-KR")}건`:""} · ${esc(stamp(st.fetchedAt))} 기준${st.mock?" · 모의 데이터":""}</small>${st.warning?`<p class="service-warning">${esc(st.warning.title)}</p>${errorDetails(st.warning)}`:""}${fieldListHtml(s)}`;
    }else if(st.status==="error"){
      chip='<span class="status-chip down">실패</span>';
      detail=`<p class="service-warning">${esc((st.error||{}).title||"불러오지 못했어요")}</p>${errorDetails(st.error)}`;
    }else{
      chip='<span class="status-chip unknown">불러오는 중</span>';
      detail="<small>서버에서 받아오는 중…</small>";
    }
    return `<article class="service-row ${st.status}"><span class="facility-icon">${s.icon}</span><div class="service-copy"><b>${esc(s.label)}</b><span class="service-code">${esc(s.service)}</span>${detail}</div>${chip}</article>`;
  }).join("");
  const ok=SERVICES.filter(s=>serviceState[s.type].status==="ok");
  const busy=loadingServices().length>0;
  const box=$("apiStatus");
  box.classList.remove("hidden","error");
  if(busy){box.textContent="데이터를 불러오는 중입니다…";return}
  const stations=new Set(liveRecords.map(recordStation).filter(Boolean).map(norm)).size;
  if(ok.length){
    box.textContent=`${SERVICES.length}종 중 ${ok.length}종 연결 · 시설 ${liveRecords.length.toLocaleString("ko-KR")}건 · 역 ${stations.toLocaleString("ko-KR")}곳을 검색 목록에 추가했어요.`;
    if(ok.length<SERVICES.length)box.classList.add("error");
  }else{
    box.classList.add("error");
    box.textContent="데이터를 불러오지 못했어요. 위의 원인과 해결 방법을 확인해 주세요.";
  }
}
function updateStationOptions(){
  const names=new Map();
  liveRecords.forEach(r=>{const n=recordStation(r);if(n&&!names.has(norm(n)))names.set(norm(n),withYeok(n))});
  const list=[...names.values()].sort((a,b)=>a.localeCompare(b,"ko"));
  $("stationOptions").innerHTML=list.map(name=>`<option value="${esc(name)}">`).join("");
  return list.length;
}
function refreshAll(){
  liveRecords=SERVICES.flatMap(s=>recordsByType[s.type]);
  const okStates=SERVICES.map(s=>serviceState[s.type]).filter(st=>st.status==="ok");
  liveLoaded=okStates.length>0;
  mockMode=okStates.some(st=>st.mock);
  const times=okStates.map(st=>st.fetchedAt).filter(Boolean).map(d=>d.getTime());
  lastFetchAt=times.length?new Date(Math.max(...times)):null;
  updateStationOptions();
  updateConnection();
  renderStationView();
  renderServiceStatus();
}

/* ---------- 데이터 불러오기 (서버 프록시) ---------- */
const CLIENT_ERRORS={
  FILE_PROTOCOL:{title:"파일로 직접 열어서 데이터를 불러올 수 없어요",cause:"index.html을 파일(file://)로 직접 열면 서버 기능(/api/facilities)을 사용할 수 없습니다.",userAction:"배포된 공개 주소(https://…)로 접속해 주세요.",operatorAction:"로컬에서는 프로젝트 폴더에서 npm start(실제 API) 또는 npm run mock(모의 데이터)을 실행한 뒤 http://localhost:3000 으로 접속하세요."},
  NETWORK:{title:"데이터 서버에 연결하지 못했어요",cause:"인터넷 연결이 끊겼거나 데이터 서버가 응답하지 않습니다.",userAction:"와이파이·모바일 데이터 연결을 확인한 뒤 ‘다시 불러오기’를 눌러 주세요.",operatorAction:"배포 주소 뒤에 /api/facilities 를 붙여 열었을 때 JSON이 보이는지 확인하세요."},
  CLIENT_TIMEOUT:{title:"응답이 너무 오래 걸려요",cause:`데이터 서버가 ${CLIENT_TIMEOUT_MS/1000}초 안에 응답하지 않았습니다.`,userAction:"잠시 후 ‘다시 불러오기’를 눌러 주세요.",operatorAction:"Vercel → Deployments → Logs에서 함수 실행 시간을 확인하세요."},
  API_NOT_FOUND:{title:"데이터 서버 기능을 찾을 수 없어요",cause:"/api/facilities 주소가 없습니다(404). 서버 기능 없이 화면 파일만 배포된 상태입니다.",userAction:"서비스 설정 문제라 운영자에게 알려 주세요.",operatorAction:"Vercel에 api/facilities.js가 함께 배포됐는지 확인하세요. GitHub Pages 같은 정적 호스팅에서는 서버 기능이 동작하지 않습니다."},
  FUNCTION_TIMEOUT:{title:"데이터 서버의 실행 시간이 초과됐어요",cause:"서버 함수가 제한 시간 안에 끝나지 못했습니다(504).",userAction:"잠시 후 ‘다시 불러오기’를 눌러 주세요.",operatorAction:"vercel.json의 regions(icn1)·maxDuration 설정이 적용됐는지와 Functions 로그를 확인하세요."},
  SERVER_ERROR:{title:"데이터 서버에 오류가 있어요",cause:"데이터 서버가 오류 상태(5xx)로 응답했습니다.",userAction:"잠시 후 ‘다시 불러오기’를 눌러 주세요.",operatorAction:"Vercel → Deployments → Logs에서 오류 내용을 확인하세요."},
  BAD_RESPONSE:{title:"데이터 서버 응답을 해석하지 못했어요",cause:"/api/facilities가 데이터(JSON) 대신 다른 내용을 보냈습니다.",userAction:"서비스 설정 문제라 운영자에게 알려 주세요.",operatorAction:"호스팅의 리다이렉트·대체 페이지 설정이 /api 경로를 가로채지 않는지 확인하세요."}
};
function clientError(code,status){return {code,kind:"client",status:status||null,...CLIENT_ERRORS[code]}}
function httpErrorCode(status){if(status===404)return "API_NOT_FOUND";if(status===504)return "FUNCTION_TIMEOUT";if(status>=500)return "SERVER_ERROR";return "BAD_RESPONSE"}
function normalizeError(e,status){
  if(!e||typeof e!=="object")return clientError(httpErrorCode(status),status);
  return {code:e.code||"UNKNOWN",kind:e.kind||"",title:e.title||"데이터를 불러오지 못했어요",cause:e.cause||"원인을 알 수 없는 오류입니다.",userAction:e.userAction||"잠시 후 다시 시도해 주세요.",operatorAction:e.operatorAction||"",upstreamMessage:e.upstreamMessage||""};
}
async function fetchWithTimeout(url,ms){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),ms);
  try{return await fetch(url,{headers:{Accept:"application/json"},signal:controller.signal})}
  finally{clearTimeout(timer)}
}
async function loadService(s,run){
  let state, records=[];
  try{
    const res=await fetchWithTimeout(`${API_ENDPOINT}?type=${encodeURIComponent(s.type)}`,CLIENT_TIMEOUT_MS);
    const text=await res.text();
    let body=null;try{body=JSON.parse(text)}catch{}
    if(!body||typeof body!=="object")state={status:"error",error:clientError(httpErrorCode(res.status),res.status)};
    else if(!res.ok||!body.ok)state={status:"error",error:normalizeError(body.error,res.status)};
    else{
      records=(Array.isArray(body.records)?body.records:[]).filter(r=>r&&typeof r==="object").map(r=>({...r,_live:true,_mock:!!body.mock,_category:s.label,_type:s.type}));
      state={status:"ok",count:records.length,total:Number(body.totalCount)||records.length,fetchedAt:body.fetchedAt?new Date(body.fetchedAt):new Date(),partial:!!body.partial,warning:body.warning||null,mock:!!body.mock};
    }
  }catch(err){
    state={status:"error",error:clientError(err&&err.name==="AbortError"?"CLIENT_TIMEOUT":"NETWORK")};
  }
  if(run!==loadRun)return;
  recordsByType[s.type]=records;
  serviceState[s.type]=state;
  refreshAll();
}
async function loadAllFacilities(){
  const run=++loadRun;
  $("reloadData").disabled=true;
  SERVICES.forEach(s=>{serviceState[s.type]={status:"loading"}});
  refreshAll();
  if(location.protocol==="file:"){
    SERVICES.forEach(s=>{recordsByType[s.type]=[];serviceState[s.type]={status:"error",error:clientError("FILE_PROTOCOL")}});
  }else{
    await Promise.all(SERVICES.map(s=>loadService(s,run)));
  }
  if(run!==loadRun)return;
  $("reloadData").disabled=false;
  refreshAll();
  const stationCount=$("stationOptions").options.length;
  $("searchMessage").textContent=liveLoaded&&!$("stationSearch").value
    ?`${stationCount.toLocaleString("ko-KR")}개 역 정보를 불러왔어요. 역을 검색하거나 빠른 검색을 선택하세요.`
    :searchResultMessage();
}

/* ---------- 연결 상태 창 ---------- */
let lastFocus=null;
function openSettings(){lastFocus=document.activeElement;$("settingsModal").classList.remove("hidden");renderServiceStatus();$("closeSettings").focus()}
function closeSettings(){$("settingsModal").classList.add("hidden");if(lastFocus&&lastFocus.focus)lastFocus.focus()}

/* ---------- 이벤트 ---------- */
$("openSettings").addEventListener("click",openSettings);
$("closeSettings").addEventListener("click",closeSettings);
$("closeSettingsBottom").addEventListener("click",closeSettings);
document.querySelectorAll("[data-close]").forEach(el=>el.addEventListener("click",closeSettings));
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!$("settingsModal").classList.contains("hidden"))closeSettings()});
document.addEventListener("click",e=>{
  if(e.target.closest("[data-open-status]"))openSettings();
  if(e.target.closest("[data-reload]"))loadAllFacilities();
  const copy=e.target.closest("[data-copy-fields]");
  if(copy)copyFields(copy.dataset.copyFields);
});
$("reloadData").addEventListener("click",()=>loadAllFacilities());
$("searchForm").addEventListener("submit",e=>{e.preventDefault();const name=$("stationSearch").value.trim();if(!name){$("searchMessage").textContent="역 이름을 입력해 주세요.";return;}renderStation(name);$("searchMessage").textContent=searchResultMessage();});
document.querySelectorAll("[data-station]").forEach(btn=>btn.addEventListener("click",()=>{$("stationSearch").value=btn.dataset.station;renderStation(btn.dataset.station);$("searchMessage").textContent=searchResultMessage();}));
$("categoryFilter").addEventListener("change",renderElevators);
$("issueFilter").addEventListener("change",renderReports);$("trustFilter").addEventListener("change",renderReports);
$("reportForm").addEventListener("submit",e=>{
  e.preventDefault();
  const report={id:Date.now(),station:withYeok($("reportStation").value),location:$("reportLocation").value.trim(),type:$("reportType").value,when:$("reportWhen").value,description:$("reportDescription").value.trim(),verified:false,createdAt:new Date().toISOString()};
  if(!report.station||!report.location||!report.type||!report.description||!$("privacyConfirm").checked)return;
  const reports=readReports();reports.unshift(report);
  if(!saveReports(reports)){ $("reportFeedback").textContent="저장에 실패했어요. 브라우저 저장 공간(사생활 보호 모드 등)을 확인해 주세요.";$("reportFeedback").classList.remove("hidden");return;}
  $("stationSearch").value=report.station;renderStation(report.station);
  $("reportFeedback").textContent="제보가 이 기기의 브라우저에 저장됐어요. 검토 전까지 ‘미확인 제보’로 표시되며 다른 이용자에게는 보이지 않아요.";
  $("reportFeedback").classList.remove("hidden");$("reportForm").reset();$("reportStation").value=currentStation;
});

/* ---------- 시작 ---------- */
LEGACY_URL_KEYS.forEach(storageRemove);
renderStation(currentStation);
loadAllFacilities();

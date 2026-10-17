const main = document.querySelector("main");
const dialog = document.querySelector("dialog");
const message = document.querySelector("#message");
let messageTimer;
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[character]));
}
function toast(value) {
  message.textContent = value;
  message.classList.add("visible");
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => message.classList.remove("visible"), 6500);
}
async function api(path, method = "GET", body) {
  if (!navigator.onLine) throw new Error("目前離線：只能查看介面，操作尚未送出，請連線後重試。");
  let response;
  try {
    response = await fetch("/api" + path, {method, headers: {"Content-Type":"application/json","X-Requested-With":"portfolio"},
      body: body === undefined ? undefined : JSON.stringify(body), cache:"no-store"});
  } catch {
    throw new Error("無法連上伺服器，操作未確認；請重新整理確認狀態後再試。");
  }
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "資料格式不正確，請檢查所有欄位。");
  return result;
}
function renderIdentity(user) {
  document.querySelector("#identity").textContent = user ? user.nickname : "訪客";
  document.querySelector("#auth").classList.toggle("hidden", Boolean(user));
  document.querySelector("#logout").classList.toggle("hidden", !user);
}
document.querySelector("#auth").addEventListener("click", () => dialog.showModal());
document.querySelector("#close-auth").addEventListener("click", () => dialog.close());
function offlineState() {
  document.querySelector("#offline").classList.toggle("hidden", navigator.onLine);
}
addEventListener("online", offlineState);
addEventListener("offline", offlineState);
offlineState();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
let installPrompt;
addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  installPrompt = event;
  document.querySelector("#install").classList.remove("hidden");
});
document.querySelector("#install").addEventListener("click", async () => {
  if (installPrompt) await installPrompt.prompt();
  document.querySelector("#install").classList.add("hidden");
});
document.querySelector("#auth-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(event.target));
    await api(button.dataset.mode === "register" ? "/register" : "/login", "POST", values);
    dialog.close();
    event.target.reset();
    await load();
    toast("已登入；這是全新作品集示範系統，請勿使用其他網站的真實密碼。");
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});
document.querySelector("#logout").addEventListener("click", async () => {
  try { await api("/logout","POST"); location.hash=""; clearPrivateState(); await load(); } catch (error) { toast(error.message); }
});


let user=null;
let events=[];
let selected=null;
let notifications=[];
let screen=new URLSearchParams(location.hash.slice(1)).get("screen")||"discover";
let sport="",searchText="",selectedDay="";
let onlyJoinable=false,includePast=false,detailOpened=new URLSearchParams(location.hash.slice(1)).has("event");
let formDraft=null;
let announcementDrafts={};
let confirmation=null;
let serverOffset=0;
let loading=false;
let loadSequence=0;
const stateLabels={recruiting:"招募中",ready:"已達成團門檻",at_risk:"缺人・待補位",locked:"已截止成團",canceled:"已取消",settled:"已結算"};
const registrationLabels={confirmed:"已確認",waiting:"排隊候補",offered:"名額已保留，待接受",expired:"候補邀請已逾時",canceled:"已退出／取消",checked_in:"已簽到"};
const auditLabels={created:"建立活動",demo_created:"建立虛構示範",joined_confirmed:"確認報名",joined_waiting:"加入候補",left:"成員退出",offer_created:"發出限時保留",offer_expired:"保留邀請逾時",offer_accepted:"候補本人接受",quorum_locked:"截止確認成團",event_canceled:"活動取消",checked_in:"主辦記錄出席",settled:"建立結算紀錄",announcement_published:"發布主辦公告"};
function localDate(seconds){const date=new Date(seconds*1000);return date.getFullYear()+"-"+String(date.getMonth()+1).padStart(2,"0")+"-"+String(date.getDate()).padStart(2,"0");}
function timeLabel(seconds){return new Date(seconds*1000).toLocaleTimeString("zh-TW",{hour:"2-digit",minute:"2-digit",hour12:false});}
function dateLabel(seconds){return new Date(seconds*1000).toLocaleDateString("zh-TW",{month:"numeric",day:"numeric",weekday:"short"});}
function when(seconds){return dateLabel(seconds)+" "+timeLabel(seconds);}
function localTime(hours){const date=new Date(Date.now()+hours*3600000);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);}
function makeRequestId(){return Array.from(crypto.getRandomValues(new Uint8Array(16)),value=>value.toString(16).padStart(2,"0")).join("");}
function stateBadge(item){return '<span class="state '+item.state+'">'+stateLabels[item.state]+'</span>';}
function court(sportName,classes=""){
  const basketball=sportName==="籃球";
  return `<svg class="${classes}" viewBox="0 0 120 90" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="8" y="7" width="104" height="76"/><path d="M60 7V83"/>${basketball?'<circle cx="60" cy="45" r="12"/><path d="M8 24H26V66H8M112 24H94V66H112M8 12a36 36 0 010 66M112 12a36 36 0 000 66"/>':'<path d="M8 22H112M8 68H112M36 7V83M84 7V83"/><path d="M60 7V83" stroke-dasharray="4 4"/>'}</svg>`;
}
function poster(item){
  const category={"籃球":"basketball","羽球":"badminton","排球":"volleyball","桌球":"tabletennis"}[item.sport]||"";
  const label={"籃球":"BASKETBALL","羽球":"BADMINTON","排球":"VOLLEYBALL","桌球":"TABLE TENNIS"}[item.sport]||"PICKUP";
  return '<span class="sport-poster '+category+'">'+court(item.sport)+'<span>'+label+'</span></span>';
}
function eventRow(item){
  return `<button class="event-row ${selected?.id===item.id?"active":""}" data-action="select" data-id="${escapeHtml(item.id)}">${poster(item)}<div><div class="event-meta">${stateBadge(item)}${screen==="mine"?'<span class="caption">'+(item.is_host?"我主辦":registrationLabels[item.my_status]||"未報名")+"</span>":""}</div><h3>${escapeHtml(item.title)}</h3><p>${timeLabel(item.starts_at)} — ${timeLabel(item.ends_at)} · ${escapeHtml(item.sport)}</p><p>${escapeHtml(item.venue)}</p></div><div class="roster-amount">${item.confirmed}<span class="caption"> / ${item.capacity}</span><small>${item.minimum} 人成團 · ${item.waiting} 人候補</small><span class="fee">${item.estimated_cost===null?"費用待人數確認":"暫估 $"+item.estimated_cost+" / 人"}</span></div></button>`;
}
function weekStrip(){
  const now=new Date();
  const days=Array.from({length:7},(unused,index)=>{const day=new Date(now);day.setDate(day.getDate()+index);return day;});
  return '<div class="week-strip" aria-label="依活動日期篩選"><button class="day '+(!selectedDay?"active":"")+'" data-action="day" data-date=""><span>查看</span><b>全部</b></button>'+days.map((day,index)=>{const value=localDate(day.getTime()/1000);return `<button class="day ${selectedDay===value?"active":""}" data-action="day" data-date="${value}" aria-pressed="${selectedDay===value}"><span>${index===0?"今天":day.toLocaleDateString("zh-TW",{weekday:"short"})}</span><b>${day.getDate()}</b></button>`;}).join("")+'</div>';
}
function discoveryTools(){
  return `<section class="discovery-tools">${weekStrip()}<div class="filters"><div class="sports" aria-label="運動篩選">${["","羽球","籃球","排球","桌球","其他"].map(value=>`<button class="sport-chip ${sport===value?"active":""}" data-action="sport" data-sport="${value}" aria-pressed="${sport===value}">${value||"全部運動"}</button>`).join("")}</div><form id="search-events" class="search"><label class="hidden" for="event-search">搜尋名稱或場地</label><input id="event-search" name="query" maxlength="100" placeholder="搜尋名稱或場地" value="${escapeHtml(searchText)}"><button class="outline">搜尋</button></form></div><div class="filter-checks"><label class="check"><input id="filter-joinable" type="checkbox" ${onlyJoinable?"checked":""}>只看仍可報名的球局</label>${screen==="discover"?`<label class="check"><input id="filter-past" type="checkbox" ${includePast?"checked":""}>包含過去活動</label>`:""}<span class="caption">時間依你的裝置時區顯示 · ${Intl.DateTimeFormat().resolvedOptions().timeZone}</span></div></section>`;
}
function eventFeed(){
  const visible=selectedDay?events.filter(item=>localDate(item.starts_at)===selectedDay):events;
  let currentDate="";
  return `<div class="feed-label"><span>${screen==="mine"?"我主辦或曾報名的活動":"選一場適合自己的臨打"}</span><span>${visible.length} 場${loading?" · 更新中":""}</span></div>${visible.map(item=>{
    const day=localDate(item.starts_at);
    let title="";
    if(day!==currentDate){currentDate=day;title='<h2 class="date-heading">'+dateLabel(item.starts_at)+'</h2>';}
    return title+eventRow(item);
  }).join("")||'<div class="empty"><h3>這裡先留一個空檔。</h3><p>目前條件下沒有球局。試著切換日期、運動或搜尋條件；也可以自己開一場。</p><button class="outline" data-action="clear-filters">清除篩選</button></div>'}`;
}
function eventDetail(){
  if(!selected)return '<section class="detail"><div class="detail-empty"><strong>R↗</strong><h3>選一場球局。</h3><p class="muted">成團門檻、候補與費用，<br>在決定參加前先看清楚。</p></div></section>';
  const item=selected,mine=item.mine;
  const now=Date.now()+serverOffset;
  const open=["recruiting","ready","at_risk"].includes(item.state);
  const canJoin=open&&(!mine||["expired","canceled"].includes(mine.status));
  const canLeave=mine&&["confirmed","waiting","offered"].includes(mine.status)&&now<item.starts_at*1000&&!["canceled","settled"].includes(item.state);
  const draft=announcementDrafts[item.id]?.text||"";
  return `<section class="detail" id="event-detail" tabindex="-1"><div class="detail-top"><button class="back-button" data-action="back">← 返回球局清單</button><div class="detail-kicker"><span>MATCH DETAILS</span>${stateBadge(item)}</div>${court(item.sport,"detail-court")}<h2>${escapeHtml(item.title)}</h2><p>${when(item.starts_at)} — ${timeLabel(item.ends_at)}<br>${escapeHtml(item.venue)}</p></div><div class="detail-body"><div class="scoreboard"><div><small>確認 / 名額上限</small><b>${item.confirmed}<span class="caption"> / ${item.capacity}</span></b></div><div><small>成團門檻</small><b>${item.minimum}<span class="caption"> 人</span></b></div><div><small>暫估每人上限</small><b>${item.estimated_cost===null?"—":"$"+item.estimated_cost}</b></div></div><progress class="capacity-bar" max="${item.capacity}" value="${item.confirmed}" aria-label="確認人數"></progress>
  <div class="status-note ${item.state==="at_risk"?"warning":""}"><strong>${item.state==="at_risk"?"還差 "+Math.max(0,item.minimum-item.confirmed)+" 人確認，這一場才算成團。":item.state==="ready"?"已達門檻，仍要留意截止前是否有人退出。":item.state==="canceled"?"這場已取消，請勿前往。":item.state==="locked"?"截止時已達門檻，開場前若退出導致不足仍會取消。":item.state==="settled"?"出席與分攤紀錄已保存。":"還差 "+Math.max(0,item.minimum-item.confirmed)+" 人確認。"}</strong>確認截止 ${when(item.cutoff_at)}。候補保留名額不算成團人數；截止仍不足則取消。</div>
  ${mine?`<div class="my-status"><span class="caption">我的報名</span><strong>${registrationLabels[mine.status]}</strong>${mine.status==="waiting"?'目前等待順位 '+mine.queue_position+'（不含已保留名額）':""}${mine.status==="offered"?`<span class="countdown" data-deadline="${mine.deadline}"></span><span class="caption">請在 ${when(mine.deadline)} 前本人接受。倒數僅供提示，以伺服器狀態為準。</span>`:""}</div>`:""}
  <div class="detail-actions">${canJoin?'<button data-action="join">報名這場・額滿時排候補</button>':""}${mine?.status==="offered"?'<button data-action="accept">接受這個保留名額</button>':""}${canLeave?'<button class="outline" data-action="leave">退出／放棄候補</button>':""}<button class="quiet" data-action="refresh">更新這場狀態 ↻</button></div><div class="detail-links"><button class="quiet" data-action="share">複製活動連結 ↗</button><a href="/api/events/${escapeHtml(item.id)}/calendar.ics">加入行事曆</a></div>
  <div class="detail-section"><h3 class="section-heading">先把規則說清楚</h3><div class="fact-line"><span>場地總費</span><p>NT$ ${item.total_cost}。結束後依已簽到者分攤，餘數依報名順序每人最多差 $1；不代收款。</p></div><div class="fact-line"><span>候補期限</span><p>${item.offer_minutes} 分鐘內本人接受，最晚不超過截止。逾期釋給下一位，重排從隊尾開始。</p></div><div class="fact-line"><span>備案</span><p>${escapeHtml(item.backup_plan)}</p></div><div class="fact-line"><span>主辦</span><p>${escapeHtml(item.host_name)}</p></div></div>
  ${item.announcements?`<div class="detail-section"><h3 class="section-heading">主辦公告</h3>${item.announcements.length?'<ul class="announcements">'+item.announcements.map(note=>'<li class="announcement">'+escapeHtml(note.text)+'<small>'+when(note.created)+'</small></li>').join("")+"</ul>":'<p class="muted">目前沒有新公告。</p>'}${item.is_host&&!["canceled","settled"].includes(item.state)?`<form id="announcement-form" class="form-stack"><label>有場地或集合方式要提醒？<textarea name="text" minlength="3" maxlength="500" required placeholder="例如：改在場館北門集合，請提前 10 分鐘到。">${escapeHtml(draft)}</textarea></label><button class="outline">發布公告並寫入站內通知</button><span class="caption">僅主辦人與曾報名帳號能查看；沒有 Email 或背景推播。</span></form>`:""}</div>`:""}
  ${item.roster?`<div class="detail-section"><h3 class="section-heading">這場的球友</h3><p class="caption">只對主辦與曾報名者顯示暱稱，不公開電話、學號或帳號。</p>${item.roster.map(person=>`<div class="member-row"><span class="avatar" aria-hidden="true">${escapeHtml(Array.from(person.nickname)[0]||"友")}</span><span>${escapeHtml(person.nickname)}</span><span class="member-state">${registrationLabels[person.status]}</span>${item.is_host&&person.status==="confirmed"&&item.state==="locked"&&now>=(item.starts_at-1800)*1000&&now<=(item.ends_at+86400)*1000?`<button class="outline" data-action="check-in" data-id="${escapeHtml(person.user_id)}">記錄簽到</button>`:""}</div>`).join("")}</div>`:""}
  ${item.settlement?`<div class="detail-section"><h3 class="section-heading">出席後的分攤</h3><p class="notice">已結算 NT$ ${item.settlement.total}，未進行收款；這份紀錄不再更改。</p>${item.settlement.people.map(person=>`<div class="settlement-row"><span>${escapeHtml(person.nickname)}</span><b>$ ${person.amount}</b></div>`).join("")}<div class="button-row"><button class="quiet" data-action="export">下載分攤紀錄 JSON ↗</button></div></div>`:""}
  ${item.is_host?`<div class="detail-section"><h3 class="section-heading">主辦工具</h3><p class="caption">簽到限已截止成團，在開始前 30 分鐘至結束後 24 小時記錄。結束後至少一名簽到才可結算。</p><div class="button-row">${item.state==="locked"&&now>=item.ends_at*1000?'<button data-action="settle">依已簽到者結算</button>':""}${(open||item.state==="locked")&&now<item.starts_at*1000?'<button class="danger" data-action="cancel">取消這場活動</button>':""}</div><details><summary>活動流程紀錄</summary><ul class="audit-list">${item.audit.map(entry=>'<li>'+when(entry.created)+" · "+(auditLabels[entry.action]||escapeHtml(entry.action))+"</li>").join("")}</ul></details></div>`:""}
  </div></section>`;
}
function createView(){
  const values=formDraft||{title:"",sport:"羽球",venue:"",starts_at:localTime(26),ends_at:localTime(28),cutoff_at:localTime(24),offer_minutes:15,capacity:6,minimum:4,total_cost:600,backup_plan:""};
  return `<div class="board-heading"><div><p class="eyebrow">HOST A GAME</p><h1>空一個場，約一群人。</h1><p class="muted">先把人數、截止與費用說清楚，開場前少一點來回確認。</p></div></div><div class="create-layout"><section class="create-panel"><form id="create-event">
  <div class="form-block"><div class="step-label"><span class="step-number">01</span> 先說這一場</div><div class="form-grid"><label class="full">活動名稱<input name="title" maxlength="70" value="${escapeHtml(values.title)}" placeholder="下課後，羽球雙打" required></label><label>運動<select name="sport">${["羽球","籃球","排球","桌球","其他"].map(value=>'<option '+(values.sport===value?"selected":"")+">"+value+"</option>").join("")}</select></label><label>公開場地<input name="venue" maxlength="120" value="${escapeHtml(values.venue)}" placeholder="場館名稱與場號，勿填私人住址" required></label></div></div>
  <div class="form-block"><div class="step-label"><span class="step-number">02</span> 時間與成團門檻</div><div class="form-grid"><label>開始時間<input type="datetime-local" name="starts_at" value="${escapeHtml(values.starts_at)}" required></label><label>結束時間<input type="datetime-local" name="ends_at" value="${escapeHtml(values.ends_at)}" required></label><label>確認成團截止<input type="datetime-local" name="cutoff_at" value="${escapeHtml(values.cutoff_at)}" required></label><label>候補回覆期限（分鐘）<input type="number" name="offer_minutes" min="1" max="120" value="${values.offer_minutes}" required></label><label>最多收幾人？<input type="number" name="capacity" min="2" max="32" value="${values.capacity}" required></label><label>最少幾人才能打？<input type="number" name="minimum" min="2" max="32" value="${values.minimum}" required></label></div></div>
  <div class="form-block"><div class="step-label"><span class="step-number">03</span> 費用與備案</div><div class="form-stack"><label>場地總費用（NT$，不是每人價格）<input name="total_cost" type="number" min="0" max="100000" value="${values.total_cost}" required></label><label>下雨、場館關閉或缺人時怎麼辦？<textarea name="backup_plan" maxlength="300" placeholder="請明確寫下改場地或取消方式。" required>${escapeHtml(values.backup_plan)}</textarea></label><p class="caption">活動名稱、場地與備案會公開。主辦人不會自動佔名額，要參加也請自行報名。</p><button>發布這場球局</button></div></div></form></section><aside class="rules-sidebar"><h3>這幾條，球友都看得到。</h3><ol><li>只有已確認的人數算成團。</li><li>額滿後依序候補，不設付費插隊。</li><li>名額釋出後，本人限時接受才加入。</li><li>截止不足取消；開場前退出造成不足，也會取消。</li><li>結束後依主辦記錄的出席分攤，不自動罰款或收費。</li></ol><p class="notice">建立表單草稿只保留在這次頁面記憶體。切換頁籤可保留，關閉或重整不保留。</p><p>這不是場館預約工具，請先自行確認場地。站內通知不是緊急聯絡方式。</p></aside></div>`;
}
function updateCounters(){
  document.querySelectorAll("[data-deadline]").forEach(element=>{
    const seconds=Math.max(0,Math.ceil((Number(element.dataset.deadline)*1000-Date.now()-serverOffset)/1000));
    element.textContent=seconds?String(Math.floor(seconds/60)).padStart(2,"0")+":"+String(seconds%60).padStart(2,"0"):"期限已到，請更新狀態";
  });
}
function render(){
  renderIdentity(user);
  document.querySelectorAll("[data-screen]").forEach(button=>button.setAttribute("aria-current",button.dataset.screen===screen?"page":"false"));
  const unseen=notifications.filter(note=>!note.seen).length;
  document.querySelector("#notification-count").textContent=unseen>9?"9+":String(unseen);
  document.querySelector("#notification-count").classList.toggle("hidden",!unseen||!user);
  main.classList.toggle("detail-mode",detailOpened);
  if(screen==="create"){main.innerHTML=createView();return;}
  if(screen==="mine"&&!user){main.innerHTML='<div class="empty"><h2>把你的球局，放在一起。</h2><p>登入後就能查看自己主辦、已報名與候補中的活動。</p><button data-action="auth">登入查看我的球局</button></div>';return;}
  main.innerHTML=`<div class="board-heading"><div><p class="eyebrow">${screen==="mine"?"YOUR MATCHES":"THE WEEK AHEAD"}</p><h1>${screen==="mine"?"我的球局，不再散在聊天裡。":"這週，約一場。"}</h1><p class="muted">${screen==="mine"?"主辦、參加、候補，這裡看清楚。":"先看成團狀態，再決定要不要出門。"}</p></div><div class="board-caption">候補名額需要本人再次確認。<br>未確認的保留，不會湊成團人數。</div></div>${discoveryTools()}<div class="board"><section class="feed" aria-label="球局清單">${eventFeed()}</section>${eventDetail()}</div>`;
  updateCounters();
}
async function load(eventId, selectFirst=false){
  const requestSequence=++loadSequence;
  const priorId=eventId||new URLSearchParams(location.hash.slice(1)).get("event")||selected?.id;
  loading=true;
  const resolved=await api("/me").catch(()=>null);
  if(requestSequence!==loadSequence)return;
  user=resolved;
  if(!user){notifications=[];selected=null;clearSensitiveDialogs();if(screen==="mine")events=[];render();}
  const parameters=new URLSearchParams({sport,q:searchText,include_past:String(includePast),only_joinable:String(onlyJoinable)});
  let listed=screen==="mine"?(user?await api("/my-events"):[]):await api("/events?"+parameters);
  if(screen==="mine"){
    listed=listed.filter(item=>(!sport||item.sport===sport)&&(!searchText||(item.title+" "+item.venue).toLowerCase().includes(searchText.toLowerCase()))&&(!onlyJoinable||["recruiting","ready","at_risk"].includes(item.state)));
  }
  if(requestSequence!==loadSequence)return;
  events=listed;
  const visible=selectedDay?events.filter(item=>localDate(item.starts_at)===selectedDay):events;
  const chosen=selectFirst?visible[0]?.id:priorId||visible[0]?.id;
  const nextSelected=chosen?await api("/events/"+chosen):null;
  if(requestSequence!==loadSequence)return;
  selected=nextSelected;
  if(selected)serverOffset=selected.server_time*1000-Date.now();
  const nextNotifications=user?await api("/notifications"):[];
  if(requestSequence!==loadSequence)return;
  notifications=nextNotifications;
  loading=false;
  document.querySelector("#live-update").classList.add("hidden");render();
}
async function setScreen(next){
  screen=next;detailOpened=false;
  location.hash="screen="+screen;
  await load(undefined,true);
}
function clearSensitiveDialogs(){
  document.querySelectorAll("dialog[open]").forEach(target=>target.close());
  document.querySelector("#notifications-dialog").innerHTML="";
  confirmation=null;
}
function clearPrivateState(){loadSequence++;user=null;selected=null;notifications=[];events=[];formDraft=null;announcementDrafts={};screen="discover";detailOpened=false;clearSensitiveDialogs();render();}
function requestConfirmation(text,callback){
  confirmation=callback;document.querySelector("#confirm-description").textContent=text;document.querySelector("#confirm-dialog").showModal();
}
document.querySelector("#confirm-yes").addEventListener("click",async()=>{
  const callback=confirmation;confirmation=null;document.querySelector("#confirm-dialog").close();
  try{if(callback)await callback();}catch(error){toast(error.message);}
});
function notificationsView(){
  const target=document.querySelector("#notifications-dialog");
  target.innerHTML=`<button class="dialog-close" data-close="notifications-dialog" aria-label="關閉通知">×</button><p class="eyebrow">ON THE SIDELINES</p><h2 id="notes-title">站內通知</h2><p class="caption">須開啟頁面查看；沒有背景推播或 Email。</p><ul class="notes-list">${notifications.map(note=>`<li class="note-item ${note.seen?"":"unread"}"><p>${escapeHtml(note.message)}</p><small>${when(note.created)}</small><br><button class="outline small" data-action="notification" data-id="${note.id}" data-event="${escapeHtml(note.event)}">${note.seen?"查看活動":"標為已讀並查看活動"}</button></li>`).join("")||'<li class="empty">目前沒有通知。</li>'}</ul>`;
  target.showModal();
}
async function mutate(action,identifier){
  const eventId=selected.id;
  const endpoint=action==="check-in"?"check-in/"+identifier:action;
  try{
    await api("/events/"+eventId+"/"+endpoint,"POST");await load(eventId);
    toast({join:"報名已處理，請確認自己的實際狀態。",accept:"已接受名額，現在算正式確認參加。",leave:"已退出，釋出空位會依規則補位。",cancel:"這場已取消，站內通知已寫入；請另行聯絡球友。",settle:"分攤紀錄已保存，未進行收款。","check-in":"已記錄這位球友出席。"}[action]||"已更新");
  }catch(error){
    if(["join","accept","leave"].includes(action))await load(eventId).catch(()=>{});
    throw error;
  }
}
async function handleAction(button){
  const action=button.dataset.action;
  if(action==="auth"){dialog.showModal();return;}
  if(action==="back"){detailOpened=false;render();return;}
  if(action==="select"){
    detailOpened=true;location.hash="screen="+screen+"&event="+button.dataset.id;await load(button.dataset.id);
    document.querySelector("#event-detail")?.focus({preventScroll:true});
    if(matchMedia("(max-width:820px)").matches)window.scrollTo({top:0,behavior:"instant"});return;
  }
  if(action==="day"){selectedDay=button.dataset.date;detailOpened=false;location.hash="screen="+screen;await load(undefined,true);return;}
  if(action==="sport"){sport=button.dataset.sport;detailOpened=false;location.hash="screen="+screen;await load(undefined,true);return;}
  if(action==="clear-filters"){sport="";searchText="";selectedDay="";onlyJoinable=false;includePast=false;location.hash="screen="+screen;await load(undefined,true);return;}
  if(action==="refresh"){await load(selected?.id);toast("已取得伺服器最新狀態。");return;}
  if(action==="share"){
    const link=location.origin+"/#screen=discover&event="+selected.id;
    try{await navigator.clipboard.writeText(link);toast("活動連結已複製。");}catch{toast("可複製網址列中的活動連結。");}
    return;
  }
  if(!user){dialog.showModal();return;}
  if(action==="notifications"){notifications=await api("/notifications");notificationsView();return;}
  if(action==="notification"){
    await api("/notifications/"+button.dataset.id+"/read","POST");document.querySelector("#notifications-dialog").close();
    detailOpened=true;location.hash="screen="+screen+"&event="+button.dataset.event;await load(button.dataset.event);return;
  }
  if(action==="cancel"){requestConfirmation("這場將標記為取消，不能恢復。會寫入站內通知，但不代表球友已收到；請另行聯絡。確認取消？",()=>mutate("cancel"));return;}
  if(action==="leave"){requestConfirmation("確認退出這場？你的名額可能立刻保留給候補。截止後退出導致人數不足時，整場會取消。",()=>mutate("leave"));return;}
  if(action==="settle"){requestConfirmation("將依目前已簽到名單建立不可修改的費用分攤紀錄；這不會收款。請先確認出席是否完整。",()=>mutate("settle"));return;}
  if(action==="export"){
    const url=URL.createObjectURL(new Blob([JSON.stringify(selected.settlement,null,2)],{type:"application/json"}));
    const anchor=document.createElement("a");anchor.href=url;anchor.download="rallyready-settlement.json";anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;
  }
  await mutate(action,button.dataset.id);
}
document.addEventListener("click",async event=>{
  const close=event.target.closest("[data-close]");if(close){document.getElementById(close.dataset.close).close();return;}
  const navigation=event.target.closest("[data-screen]");
  if(navigation){try{await setScreen(navigation.dataset.screen);}catch(error){toast(error.message);}return;}
  const button=event.target.closest("[data-action]");if(!button)return;
  button.disabled=true;try{await handleAction(button);}catch(error){toast(error.message);}finally{button.disabled=false;}
});
main.addEventListener("change",async event=>{
  if(event.target.id==="filter-joinable")onlyJoinable=event.target.checked;
  else if(event.target.id==="filter-past")includePast=event.target.checked;
  else return;
  try{location.hash="screen="+screen;await load(undefined,true);}catch(error){toast(error.message);}
});
main.addEventListener("input",event=>{
  if(event.target.closest("#create-event"))formDraft=Object.fromEntries(new FormData(document.querySelector("#create-event")));
  if(event.target.closest("#announcement-form"))announcementDrafts[selected.id]={text:event.target.value,request_id:makeRequestId()};
});
main.addEventListener("submit",async event=>{
  event.preventDefault();
  const button=event.submitter;button.disabled=true;
  try{
    const values=Object.fromEntries(new FormData(event.target));
    if(event.target.id==="search-events"){searchText=values.query.trim();location.hash="screen="+screen;await load(undefined,true);return;}
    if(!user){dialog.showModal();return;}
    if(event.target.id==="create-event"){
      formDraft={...values};
      for(const key of ["capacity","minimum","total_cost","offer_minutes"])values[key]=Number(values[key]);
      for(const key of ["starts_at","ends_at","cutoff_at"])values[key]=new Date(values[key]).toISOString();
      const result=await api("/events","POST",values);
      formDraft=null;screen="mine";detailOpened=true;location.hash="screen=mine&event="+result.id;await load(result.id);toast("球局已發布。主辦人要參加，也請自行報名。");
    }else if(event.target.id==="announcement-form"){
      const eventId=selected.id;
      const draft=announcementDrafts[eventId]||{text:values.text,request_id:makeRequestId()};
      announcementDrafts[eventId]=draft;
      await api("/events/"+eventId+"/announcements","POST",draft);
      delete announcementDrafts[eventId];await load(eventId);toast("公告已發布，已寫入參與者的站內通知。");
    }
  }catch(error){toast(error.message);}finally{button.disabled=false;}
});
setInterval(updateCounters,1000);
setInterval(async()=>{
  if(!user||document.visibilityState!=="visible"||document.querySelector("dialog[open]"))return;
  try{
    const notes=await api("/notifications");
    const previous=new Set(notifications.map(note=>note.id));
    const fresh=notes.filter(note=>!previous.has(note.id)&&!note.seen).length;
    if(fresh){const button=document.querySelector("#live-update");button.textContent="有 "+fresh+" 則新通知・更新";button.classList.remove("hidden");}
    const count=notes.filter(note=>!note.seen).length;
    document.querySelector("#notification-count").textContent=count>9?"9+":String(count);
    document.querySelector("#notification-count").classList.toggle("hidden",!count);
  }catch{}
},30000);
load().catch(error=>{loading=false;render();toast(error.message);});


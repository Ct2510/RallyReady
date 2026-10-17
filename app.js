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
  try { await api("/logout","POST"); location.hash=""; await load(); } catch (error) { toast(error.message); }
});

let user=null;
let events=[];
let selected=null;
let notifications=[];
const stateLabels={recruiting:"招募中",ready:"已達成團門檻",at_risk:"人數不足，需補位",locked:"已截止成團",canceled:"已取消",settled:"已結算"};
const registrationLabels={confirmed:"已確認",waiting:"排隊候補",offered:"限時保留，待接受",expired:"邀請已逾時",canceled:"已退出／取消",checked_in:"已簽到"};
function when(seconds) { return new Date(seconds*1000).toLocaleString("zh-TW",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",hour12:false}); }
function localTime(hours) {
  const date=new Date(Date.now()+hours*3600000);
  return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
}
function createForm() {
  return `<details ${events.length?"":"open"}><summary>主辦一場新活動</summary><form id="create-event" class="form-grid">
  <label class="full">活動名稱<input name="title" placeholder="週五下課羽球臨打" maxlength="70" required></label>
  <label>運動<select name="sport"><option>羽球</option><option>籃球</option><option>排球</option><option>桌球</option><option>其他</option></select></label>
  <label>地點<input name="venue" placeholder="體育館 A 場" maxlength="120" required></label>
  <label>開始時間<input type="datetime-local" name="starts_at" required value="${localTime(26)}"></label>
  <label>結束時間<input type="datetime-local" name="ends_at" required value="${localTime(28)}"></label>
  <label>成團確認截止<input type="datetime-local" name="cutoff_at" required value="${localTime(24)}"></label>
  <label>候補回覆期限（分鐘）<input type="number" name="offer_minutes" min="1" max="120" value="15" required></label>
  <label>最多人數<input type="number" name="capacity" min="2" max="32" value="6" required></label>
  <label>成團最低人數<input type="number" name="minimum" min="2" max="32" value="4" required></label>
  <label class="full">場地總費用（NT$，不是每人價格）<input type="number" name="total_cost" min="0" max="100000" value="600" required></label>
  <label class="full">備案與取消方式<textarea name="backup_plan" maxlength="300" placeholder="下雨改室內；場館關閉時由主辦人取消並通知" required></textarea></label>
  <div class="full"><button>建立可分享的活動</button><p class="muted">主辦人不會自動佔名額，要參加也請報名。地點與活動資訊會公開，請勿填私人住址。</p></div></form></details>`;
}
function eventCard(item) {
  return `<button class="event-button ${selected?.id===item.id?"active":""}" data-action="select" data-id="${escapeHtml(item.id)}">
    <div class="row between"><span class="badge">${escapeHtml(item.sport)}</span><span class="badge ${item.state==="at_risk"?"warn":item.state==="canceled"?"gray":""}">${stateLabels[item.state]}</span></div>
    <h3>${escapeHtml(item.title)}</h3><p>${when(item.starts_at)} · ${escapeHtml(item.venue)}</p>
    <progress max="${item.capacity}" value="${item.confirmed}" aria-label="已確認人數"></progress>
    <p>${item.confirmed} / ${item.capacity} 人確認 · ${item.minimum} 人成團 · ${item.waiting} 人候補</p>
  </button>`;
}
function eventView() {
  if (!selected) return '<section class="panel empty">還沒有活動。建立一場臨打，把邀請連結傳給朋友；<br>從報名到出席結算，都在同一個地方。</section>';
  const item=selected;
  const mine=item.mine;
  const open=["recruiting","ready","at_risk"].includes(item.state);
  const canJoin=open&&(!mine||["expired","canceled"].includes(mine.status));
  const canLeave=mine&&["confirmed","waiting","offered"].includes(mine.status)&&Date.now()<item.starts_at*1000&&!["canceled","settled"].includes(item.state);
  return `<section class="panel">
    <div class="row between"><span class="eyebrow">THE NEXT GAME</span><span class="badge ${item.state==="at_risk"?"warn":""}">${stateLabels[item.state]}</span></div>
    <h2>${escapeHtml(item.title)}</h2><p class="muted">${escapeHtml(item.sport)} · ${when(item.starts_at)} — ${when(item.ends_at)}<br>${escapeHtml(item.venue)} · 主辦 ${escapeHtml(item.host_name)}</p>
    <div class="metrics"><div class="metric"><small>確認 / 上限</small><b>${item.confirmed} / ${item.capacity}</b></div><div class="metric"><small>成團門檻</small><b>${item.minimum} 人</b></div><div class="metric"><small>暫估每人上限</small><b>${item.estimated_cost===null?"—":"$"+item.estimated_cost}</b></div></div>
    <p class="notice ${item.state==="at_risk"?"warning":""}">截止 ${when(item.cutoff_at)} · 只有「已確認」的人數算成團；候補邀請保留名額但不算出席承諾。截止仍不足則取消，截止後退出導致不足也會取消。</p>
    ${mine?`<p><span class="badge">我的狀態：${registrationLabels[mine.status]}</span>${mine.status==="offered"?`<strong>請於 ${when(mine.deadline)} 前接受</strong>`:""}</p>`:""}
    <div class="actions">${canJoin?'<button data-action="join">報名 / 額滿時加入候補</button>':""}${mine?.status==="offered"?'<button data-action="accept">接受保留名額</button>':""}${canLeave?'<button data-action="leave" class="secondary">退出或放棄候補</button>':""}<button data-action="share" class="secondary">複製邀請</button><a href="/api/events/${escapeHtml(item.id)}/calendar.ics">下載行事曆</a></div>
    <div class="divider"></div><h3>費用與備案，先說清楚</h3><p>場地總費用 NT$ ${item.total_cost}。結束後依主辦人記錄的簽到人數平分；餘數按報名先後分配，每人最多差 NT$ 1。這不是付款服務。</p><p class="muted">${escapeHtml(item.backup_plan)}</p>
    ${item.roster?`<div class="divider"></div><h3>參與者名單</h3><p class="muted">僅主辦人及曾報名的帳號可查看暱稱；不公開電話、學號或帳號名稱。</p><div class="table-wrap"><table><thead><tr><th>暱稱</th><th>狀態</th>${item.is_host?"<th>出席紀錄</th>":""}</tr></thead><tbody>${item.roster.map(person=>`<tr><td>${escapeHtml(person.nickname)}</td><td>${registrationLabels[person.status]}</td>${item.is_host?`<td>${person.status==="confirmed"&&Date.now()>= (item.starts_at-1800)*1000&&item.state==="locked"?`<button data-action="check-in" data-id="${escapeHtml(person.user_id)}" class="secondary">記錄簽到</button>`:"—"}</td>`:""}</tr>`).join("")}</tbody></table></div>`:""}
    ${item.is_host?`<div class="actions">${open||item.state==="locked"&&Date.now()<item.starts_at*1000?'<button data-action="cancel" class="danger">取消這場活動</button>':""}${item.state==="locked"&&Date.now()>=item.ends_at*1000?'<button data-action="settle">依已簽到人數結算</button>':""}</div><p class="muted">簽到：開始前 30 分鐘至結束後 24 小時，由主辦人確認。結算後不可修改。</p>`:""}
    ${item.settlement?`<div class="divider"></div><h3>不可變更的結算紀錄</h3><p class="notice">僅計算應分攤金額，未進行收款。合計 NT$ ${item.settlement.total}。</p>${item.settlement.people.map(person=>`<div class="choice"><strong>${escapeHtml(person.nickname)}</strong><b>NT$ ${person.amount}</b></div>`).join("")}`:""}
    ${item.audit?`<details><summary>活動流程紀錄（最近 50 筆）</summary><ul>${item.audit.map(entry=>`<li>${when(entry.created)} · ${escapeHtml(entry.action)}</li>`).join("")}</ul></details>`:""}
  </section>`;
}
function render() {
  renderIdentity(user);
  main.innerHTML=`<section class="hero"><div><p class="eyebrow">LESS GROUP CHAT. MORE GAME TIME.</p><h1>有人說要來，<br>不代表這一場成得了。</h1><p>讓成團門檻、候補回覆與最後費用都有明確規則。每一次補位都需要本人確認，不再對著聊天紀錄猜人數。</p></div><div class="hero-note"><strong>報名 ≠ 成團</strong>門檻與截止清楚<br>候補按序、限時接受<br>依實際出席平分</div></section>
    <div class="layout"><aside><section class="panel"><div class="row between"><h3>場邊通知</h3><button data-action="refresh" class="link">重新整理</button></div>
    ${user?notifications.length?notifications.map(note=>`<div class="choice"><div>${escapeHtml(note.message)}<br><small>${when(note.created)}</small><button class="link" data-action="notification" data-id="${note.id}" data-event="${escapeHtml(note.event)}">${note.seen?"查看活動":"標為已讀並查看"}</button></div></div>`).join(""):'<p class="muted">目前沒有通知。候補名額出現時，請回到這裡確認。</p>':'<p class="muted">登入即可報名及查看個人通知。</p><button data-action="auth">開始參與</button>'}
    <p class="notice">通知僅儲存在站內，須開啟頁面重新整理。未提供背景推播或 Email。</p></section>
    <section class="panel"><h3>公平候補規則</h3><ol class="muted"><li>額滿後依報名順序排隊。</li><li>有人退出才保留空位。</li><li>本人限時接受才正式加入。</li><li>逾時則交給下一位；重排從隊尾開始。</li></ol></section></aside><div>
    <section class="panel"><div class="row between"><h2>邀朋友，打一場。</h2><span class="badge gray">${events.length} 場紀錄</span></div><div class="cards">${events.map(eventCard).join("")||'<p class="muted">目前尚無活動；示範資料需要自行建立或匯入。</p>'}</div></section>
    ${eventView()}<section class="panel">${createForm()}</section></div></div>`;
}
async function load(eventId) {
  user=await api("/me").catch(()=>null);
  events=await api("/events");
  const hashId=new URLSearchParams(location.hash.slice(1)).get("event");
  const chosen=eventId||selected?.id||hashId||events[0]?.id;
  selected=chosen?await api("/events/"+chosen):null;
  notifications=user?await api("/notifications"):[];
  render();
}
main.addEventListener("submit",async event=>{
  event.preventDefault();
  if(event.target.id!=="create-event") return;
  const button=event.submitter; button.disabled=true;
  try {
    if(!user) {dialog.showModal();return;}
    const values=Object.fromEntries(new FormData(event.target));
    for(const key of ["capacity","minimum","total_cost","offer_minutes"]) values[key]=Number(values[key]);
    for(const key of ["starts_at","ends_at","cutoff_at"]) values[key]=new Date(values[key]).toISOString();
    const result=await api("/events","POST",values);
    location.hash="event="+result.id;
    await load(result.id); toast("活動已建立。主辦人如要參加，也請按報名。");
  }catch(error){toast(error.message);}
  finally{button.disabled=false;}
});
main.addEventListener("click",async event=>{
  const button=event.target.closest("[data-action]");
  if(!button)return;
  button.disabled=true;
  try {
    const action=button.dataset.action;
    if(action==="auth")dialog.showModal();
    else if(action==="select"){location.hash="event="+button.dataset.id;await load(button.dataset.id);}
    else if(action==="refresh")await load();
    else if(action==="notification"){
      await api("/notifications/"+button.dataset.id+"/read","POST");
      location.hash="event="+button.dataset.event; await load(button.dataset.event);
    }else if(action==="share"){
      const link=location.origin+"/#event="+selected.id;
      try{await navigator.clipboard.writeText(link);toast("活動邀請連結已複製。");}catch{toast(link);}
    }else{
      if(!user){dialog.showModal();return;}
      const endpoint=action==="check-in"?"check-in/"+button.dataset.id:action;
      await api("/events/"+selected.id+"/"+endpoint,"POST");
      await load(selected.id);
      toast({join:"報名狀態已更新，請查看是否為候補。",leave:"已退出；空位將依序發出候補邀請。",accept:"候補名額已確認。",cancel:"活動已取消，通知已寫入站內。",settle:"結算完成，未進行任何收款。","check-in":"已記錄出席。"}[action]||"已更新");
    }
  }catch(error){toast(error.message);}
  finally{button.disabled=false;}
});
load().catch(error=>{main.innerHTML='<div class="panel empty">目前無法讀取活動，請確認服務啟動並連線後重新整理。</div>';toast(error.message);});


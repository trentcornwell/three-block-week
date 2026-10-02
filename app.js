/* Three-Block Week — staff planner. Data lives in Supabase (see supabase/schema.sql). */
(function(){
  const BLOCKS=[["m","Morning"],["a","Afternoon"],["e","Evening"]];
  const TYPES=[["office","Work · Office","Work · Office","Office"],["remote","Work · Remote","Work · Remote","Remote"],["education","On-Going Education","Education","Edu"],["church","Church Gathering","Church","Church"],["family","Family","Family","Family"],["rest","Rest","Rest","Rest"]];
  const TYPE_NAME=Object.fromEntries(TYPES.map(t=>[t[0],t[1]]));
  const TYPE_TINY=Object.fromEntries(TYPES.map(t=>[t[0],t[3]]));
  const SPLITTABLE=["office","remote","education"];
  const WORKLIKE=["office","remote","education","church"];
  const COLOR={office:"var(--office)",remote:"var(--remote)",education:"var(--edu)"};
  const DOW=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const DOW3=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const MON=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const DEF_GUARD={minRest:2,minFamily:3,maxWorkEvenings:3};
  const TZ=(()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone}catch(e){return undefined}})();
  const $=s=>document.querySelector(s);
  const weekEl=$("#week");

  const daysBy={}, weeksBy={}, metaBy={};
  let me="local", viewing="local", people=[];
  let weekStart=mondayOf(new Date());
  let tab=(window.matchMedia&&window.matchMedia("(max-width: 700px)").matches)?"today":"week";
  let backend=null, db=null, user=null, mcp=null;
  const kindPref={}, pendingRender={};
  let pendingFull=false, personUnsubs={}, calUnsub=null, calBy={}, calMsg="", outsideLoaded=new Set();

  /* ---------- helpers ---------- */
  function pad(n){return String(n).padStart(2,"0")}
  function key(d){return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate())}
  function todayKey(){return key(new Date())}
  function mondayOf(d){const x=new Date(d.getFullYear(),d.getMonth(),d.getDate());x.setDate(x.getDate()-((x.getDay()+6)%7));return x}
  function addDays(d,n){const x=new Date(d);x.setDate(x.getDate()+n);return x}
  function dateOf(k){return new Date(k+"T00:00:00")}
  function weekDates(ws){ws=ws||weekStart;return Array.from({length:7},(_,i)=>key(addDays(ws,i)))}
  function wsKey(){return key(weekStart)}
  function uid(){return Math.random().toString(36).slice(2,10)}
  function esc(s){return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
  function clone(o){return JSON.parse(JSON.stringify(o))}
  function fixItems(o){if(!Array.isArray(o.items))o.items=[];o.items.forEach(i=>{if(i.kind==="obj"&&!Array.isArray(i.tasks))i.tasks=[]})}
  function blankBlocks(){return {m:{mode:null,items:[]},a:{mode:null,items:[]},e:{mode:null,items:[]}}}
  function norm(d,date){d=d||{date,blocks:blankBlocks()};d.date=date;d.blocks=d.blocks||{};
    for(const [b] of BLOCKS){const blk=d.blocks[b]||(d.blocks[b]={mode:null,items:[]});fixItems(blk);
      if(blk.split){if(!Array.isArray(blk.halves)||blk.halves.length!==2)blk.halves=[{mode:"office",items:[]},{mode:"office",items:[]}];blk.halves.forEach(fixItems)}}
    return d}
  function mapOf(pid){return daysBy[pid]||(daysBy[pid]={})}
  function getDay(pid,date){const m=mapOf(pid);m[date]=norm(m[date],date);return m[date]}
  function getWeek(pid,ws){const w=(weeksBy[pid]||(weeksBy[pid]={}));if(!w[ws]||!Array.isArray(w[ws].priorities))w[ws]={priorities:[]};return w[ws]}
  function getMeta(pid){return metaBy[pid]||(metaBy[pid]={})}
  function guards(pid){return Object.assign({},DEF_GUARD,getMeta(pid).settings||{})}
  const ro=()=>viewing!==me;
  function countItems(o){return o.items.reduce((n,i)=>n+1+(i.tasks?i.tasks.length:0),0)}
  function isEmptyBlock(blk){return !blk.mode&&!blk.split&&!blk.items.length}
  function containers(day){const out=[];for(const [b] of BLOCKS){const blk=day.blocks[b];if(blk.split)blk.halves.forEach((h,i)=>out.push({b,h:i,c:h}));else out.push({b,h:null,c:blk})}return out}
  function hasUnfinished(day){return containers(day).some(({c})=>c.items.some(i=>i.kind==="break"?false:i.kind==="obj"?i.tasks.some(t=>!t.done):!i.done))}
  function typing(){const a=document.activeElement;return !!(a&&((a.tagName==="INPUT"&&a.type==="text")||a.closest&&a.closest(".edit")))||!!document.querySelector(".edit")}

  /* ---------- rendering: blocks ---------- */
  function pris(){return getWeek(viewing,wsKey()).priorities}
  function taskLI(i,readOnly,parent){
    return `<li class="it task${i.done?" done":""}" data-id="${i.id}"${parent?` data-parent="${parent}"`:""}${readOnly?"":` draggable="true"`}><input type="checkbox" data-act="check" id="c-${i.id}" ${i.done?"checked":""} ${readOnly?"disabled":""} aria-label="Done"><span class="txt"${readOnly?"":` data-act="edit" tabindex="0"`}>${esc(i.text)}</span>${i.bc&&i.bc.url?`<a class="bclink" href="${esc(i.bc.url)}" target="_blank" rel="noopener" title="Open in Basecamp${i.bc.project?" · "+esc(i.bc.project):""}">BC</a>`:""}${readOnly?"":`<button class="del" data-act="del" aria-label="Remove">&times;</button>`}</li>`;
  }
  function listHTML(o,ids,readOnly){
    const P=pris();
    const objs=o.items.filter(i=>i.kind==="obj"), tasks=o.items.filter(i=>i.kind!=="obj"&&i.kind!=="break"), breaks=o.items.filter(i=>i.kind==="break");
    const del=readOnly?"":`<button class="del" data-act="del" aria-label="Remove">&times;</button>`;
    const brkHTML=bk=>{
      let when="1 hr";
      if(bk.until){const t=new Date(bk.until).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});when=(bk.until>Date.now()?"until ":"ended ")+t}
      return `<li class="it brk${bk.until&&bk.until<=Date.now()?" over":""}" data-id="${bk.id}"${readOnly?"":` draggable="true"`}><span class="bk-ic" aria-hidden="true"></span><span class="txt"${readOnly?"":` data-act="edit" tabindex="0"`}>${esc(bk.text||"Break")}</span><span class="bk-time">${when}</span>${del}</li>`;
    };
    const chip=ob=>{const n=P.findIndex(p=>p.id===ob.pri);return n>=0?`<span class="pchip" title="${esc(P[n].text)}">P${n+1}</span>`:""};
    const objHTML=ob=>`<li class="grp" data-id="${ob.id}">
        <div class="it obj" data-id="${ob.id}"${readOnly?"":` draggable="true"`}><span class="mk" aria-hidden="true"></span><span class="txt"${readOnly?"":` data-act="edit" tabindex="0"`}>${esc(ob.text)}</span>${chip(ob)}${del}</div>
        ${ob.tasks.length?`<ul class="items sub">${ob.tasks.map(t=>taskLI(t,readOnly,ob.id)).join("")}</ul>`:""}
        ${readOnly?"":`<div class="subadd"><input id="sub-${ids}-${ob.id}" data-parent="${ob.id}" type="text" placeholder="+ Task under this objective" autocomplete="off" enterkeyhint="done"></div>`}
      </li>`;
    const inId=`in-${ids}`, k=kindPref[inId]||"task";
    return `${breaks.length?`<ul class="items">${breaks.map(brkHTML).join("")}</ul>`:""}
      ${objs.length?`<div class="sec">Objectives</div><ul class="items">${objs.map(objHTML).join("")}</ul>`:""}
      ${tasks.length?`${objs.length?`<div class="sec">Tasks</div>`:""}<ul class="items">${tasks.map(t=>taskLI(t,readOnly,null)).join("")}</ul>`:""}
      ${!o.items.length?`<div class="empty">Nothing planned yet.</div>`:""}
      ${readOnly?"":`<div class="add">
        <button class="kind" data-act="kind" data-kind="${k}" aria-label="Switch between objective and task">${k==="obj"?"Objective":"Task"}</button>
        <input id="${inId}" type="text" placeholder="${k==="obj"?"Add an objective":"Add a task"}" autocomplete="off" enterkeyhint="done">
        <button class="brkbtn" data-act="break" title="Add a one-hour break, for an errand or time away">+1 hr break</button>
      </div>`}`;
  }
  function chipsHTML(mode,allowed,readOnly,label){
    return `<div class="types" role="group" aria-label="${label} type">${TYPES.filter(t=>allowed.includes(t[0])).map(([v,,short])=>
      `<button class="tg ${v}" data-act="mode" data-mode-v="${v}" aria-pressed="${mode===v}" ${readOnly?"disabled":""} title="${TYPE_NAME[v]}">${short}</button>`).join("")}</div>`;
  }
  function calHTML(date,b){
    if(viewing!==me) return "";
    const c=calBy[date]; const rows=c&&c[b]; if(!rows||!rows.length) return "";
    return `<ul class="cal" aria-label="Calendar">${rows.map(ev=>`<li><span class="ct">${esc(ev.time)}</span><span class="cn">${esc(ev.title)}</span></li>`).join("")}</ul>`;
  }
  function blockHTML(date,b,label,blk,readOnly){
    const base=`${date}-${b}`;
    if(blk.split){
      const halves=blk.halves.map((hf,h)=>`<div class="half" data-h="${h}" data-mode="${hf.mode}">
          <div class="hhead"><span class="hname">${h?"Second half":"First half"}</span><span class="btype">${TYPE_NAME[hf.mode]}</span></div>
          ${readOnly?"":chipsHTML(hf.mode,SPLITTABLE,readOnly,`${label} ${h?"second":"first"} half`)}
          <div class="bbody">${listHTML(hf,`${base}-${h}`,readOnly)}</div>
        </div>`).join("");
      return `<div class="block is-split" data-date="${date}" data-b="${b}">
        <div class="bhead"><span class="bname">${label} · split</span>${readOnly?"":`<button class="split-btn" data-act="merge">Merge halves</button>`}</div>
        ${calHTML(date,b)}
        <div class="halves">${halves}</div>
      </div>`;
    }
    const mode=blk.mode||"";
    const n=countItems(blk);
    const kept=readOnly?"":(n?`${n} item${n>1?"s":""} kept for later`:"Protected time");
    const canSplit=!readOnly&&(!mode||SPLITTABLE.includes(mode));
    return `<div class="block" data-date="${date}" data-b="${b}" ${mode?`data-mode="${mode}"`:""}>
      <div class="bhead"><span class="bname">${label}</span>${mode?`<span class="btype">${TYPE_NAME[mode]||""}</span>`:""}</div>
      ${chipsHTML(mode,TYPES.map(t=>t[0]),readOnly,label)}
      ${calHTML(date,b)}
      <div class="bfill"><strong>${TYPE_NAME[mode]||""}</strong>${kept?`<small>${kept}</small>`:""}</div>
      <div class="bbody">${listHTML(blk,base,readOnly)}
        ${canSplit?`<div><button class="split-btn" data-act="split">Split into two halves</button></div>`:""}
      </div>
    </div>`;
  }
  function dayHTML(date){
    const d=getDay(viewing,date), dt=dateOf(date), tk=todayKey(), isToday=date===tk;
    const all=(viewing===me&&calBy[date]&&calBy[date].allDay)||[];
    const carry=!ro()&&date<=tk&&hasUnfinished(d)?`<button class="carry" data-carry="${date}">${date<tk?"Move unfinished to today":"Move unfinished to tomorrow"}</button>`:"";
    return `<section class="day${isToday?" is-today":""}" data-day="${date}" aria-label="${DOW[dt.getDay()]}">
      <div class="dlabel"><span class="dn">${DOW[dt.getDay()]}</span><span class="dd">${MON[dt.getMonth()]} ${dt.getDate()}</span>${isToday?`<span class="today">Today</span>`:""}
        ${all.length?`<div class="allday">${all.map(t=>`<span>${esc(t)}</span>`).join("")}</div>`:""}${carry}</div>
      ${BLOCKS.map(([b,l])=>blockHTML(date,b,l,d.blocks[b],ro())).join("")}
    </section>`;
  }

  /* ---------- rendering: page ---------- */
  function renderAll(){
    pendingFull=false;
    for(const [id,t] of [["tabToday","today"],["tabWeek","week"],["tabStaff","staff"]]) $("#"+id).setAttribute("aria-pressed",String(tab===t));
    $("#weeknav").hidden=tab==="today";
    const end=addDays(weekStart,6);
    $("#range").textContent=`${MON[weekStart.getMonth()]} ${weekStart.getDate()} – ${MON[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
    const staff=tab==="staff";
    $("#staff").hidden=!staff; weekEl.hidden=staff; $("#legend").hidden=staff; $("#prio").hidden=staff;
    $("#tools").hidden=staff||tab!=="week"||ro();
    $("#summary").hidden=staff;
    if(staff){$("#team").hidden=true;$("#viewing").hidden=true;renderBC();renderStaff();return}
    weekEl.classList.toggle("today-view",tab==="today");
    weekEl.innerHTML=(tab==="today"?[todayKey()]:weekDates()).map(dayHTML).join("");
    renderSummary(); renderTeam(); renderViewing(); renderPrio(); renderTools(); renderBC();
  }
  function requestFull(){ if(typing()){pendingFull=true;return} renderAll() }
  function renderDay(date,focusId){
    if(tab==="staff"){renderStaff();return}
    const el=weekEl.querySelector(`[data-day="${date}"]`);
    if(el){
      if(!focusId && typing() && el.contains(document.activeElement)){pendingRender[date]=true}
      else{ el.outerHTML=dayHTML(date); if(focusId){const f=document.getElementById(focusId); if(f) f.focus()} }
    }
    renderSummary(); renderTeam(); renderPrio();
  }
  function fmt(n){return Number.isInteger(n)?String(n):n.toFixed(1)}
  function stats(pid){
    const c={office:0,remote:0,education:0,church:0,family:0,rest:0,open:0,eveWork:0}; const cells=[];
    for(const date of weekDates()){const d=getDay(pid,date);
      for(const [b] of BLOCKS){const blk=d.blocks[b];
        if(blk.split){const [h0,h1]=blk.halves;c[h0.mode]+=.5;c[h1.mode]+=.5;if(b==="e")c.eveWork++;
          cells.push(`<i class="split" style="background:linear-gradient(90deg,${COLOR[h0.mode]} 50%,${COLOR[h1.mode]} 50%)"></i>`);continue}
        let cls="";
        if(blk.mode&&c[blk.mode]!==undefined){c[blk.mode]++;cls=blk.mode;if(b==="e"&&WORKLIKE.includes(blk.mode))c.eveWork++}
        else{c.open++; if(blk.items.length) cls="work"}
        cells.push(`<i class="${cls}"></i>`)}}
    c.cells=cells.join(""); return c;
  }
  function renderSummary(){
    const s=stats(viewing);
    $("#map").innerHTML=s.cells;
    $("#cOffice").textContent=fmt(s.office);$("#cRemote").textContent=fmt(s.remote);$("#cEdu").textContent=fmt(s.education);
    $("#cChurch").textContent=fmt(s.church);$("#cFam").textContent=fmt(s.family);$("#cRest").textContent=fmt(s.rest);$("#cOpen").textContent=fmt(s.open);
    const g=guards(viewing);
    const pill=(ok,text)=>`<span class="pill ${ok?"ok":"warn"}">${text}${ok?"":" — below target"}</span>`;
    const pills=[];
    if(g.minRest>0) pills.push(pill(s.rest>=g.minRest,`Rest ${fmt(s.rest)} of ${g.minRest}`));
    if(g.minFamily>0) pills.push(pill(s.family>=g.minFamily,`Family ${fmt(s.family)} of ${g.minFamily}`));
    const eveOk=s.eveWork<=g.maxWorkEvenings;
    pills.push(`<span class="pill ${eveOk?"ok":"warn"}">Working evenings ${s.eveWork} of ${g.maxWorkEvenings} max${eveOk?"":" — over limit"}</span>`);
    $("#guards").innerHTML=pills.join("");
    const cs=$("#calStatus");
    if(viewing===me&&calMsg){
      if(calMsg==="connect") cs.innerHTML=`Show your Google Calendar events inside each block. <button class="btn" id="calConnect">Connect Google Calendar</button>`;
      else cs.textContent=calMsg;
      cs.hidden=false
    } else cs.hidden=true;
  }
  let teamSeq=0;
  async function renderTeam(){
    if(!user||people.length<1||tab==="staff"){$("#team").hidden=true;return}
    const seq=++teamSeq;
    const ids=[me,...people.filter(p=>p!==me)];
    let ps={}; try{ps=await user.profiles(ids)}catch(e){}
    if(seq!==teamSeq) return;
    const box=$("#people"); box.textContent="";
    for(const pid of ids){
      const p=ps[pid]||{}; const s=stats(pid);
      const btn=document.createElement("button");
      btn.className="person"; btn.dataset.pid=pid; btn.setAttribute("aria-pressed",String(pid===viewing));
      btn.innerHTML=`<img alt=""><span class="pinfo"><span class="pname"></span><span class="pcount">Work ${fmt(s.office+s.remote)} · Edu ${fmt(s.education)} · Church ${fmt(s.church)} · Family ${fmt(s.family)} · Rest ${fmt(s.rest)}</span></span><span class="map" aria-hidden="true">${s.cells}</span>`;
      if(p.avatarUrl) btn.querySelector("img").src=p.avatarUrl; else btn.querySelector("img").remove();
      btn.querySelector(".pname").textContent=(pid===me?"You":(p.name||"Staff member"));
      box.appendChild(btn);
    }
    $("#team").hidden=false;
  }
  async function renderViewing(){
    const el=$("#viewing");
    if(!user||!ro()){el.hidden=true;return}
    let name="Staff member"; try{const ps=await user.profiles([viewing]);name=ps[viewing].name||name}catch(e){}
    el.textContent=""; const b=document.createElement("b"); b.textContent=name+"’s "+(tab==="today"?"day":"week");
    const chip=document.createElement("span"); chip.className="ro-chip"; chip.textContent="View only";
    const back=document.createElement("button"); back.className="btn"; back.textContent="Back to my "+(tab==="today"?"day":"week"); back.onclick=()=>select(me);
    el.append(b,chip,back); el.hidden=false;
  }
  function linkedCount(pid,priId){
    let n=0; for(const date of weekDates()){for(const {c} of containers(getDay(pid,date))) n+=c.items.filter(i=>i.kind==="obj"&&i.pri===priId).length} return n;
  }
  function renderPrio(){
    const P=pris(), list=$("#prioList"); list.textContent="";
    $("#prioTitle").textContent=ro()?"Their priorities this week":"This week’s priorities";
    $("#prioAdd").hidden=ro();
    if(!P.length){const li=document.createElement("li");li.innerHTML=`<span class="plink">${ro()?"No priorities set for this week.":"Name two or three things that matter most this week. Then tag objectives with them when you edit an objective."}</span>`;list.appendChild(li);return}
    P.forEach((p,i)=>{
      const li=document.createElement("li"); li.dataset.id=p.id; if(p.done) li.classList.add("done");
      const n=linkedCount(viewing,p.id);
      li.innerHTML=`<span class="pn">P${i+1}</span><input type="checkbox" data-pact="check" id="p-${p.id}" ${p.done?"checked":""} ${ro()?"disabled":""} aria-label="Done"><span class="ptxt"></span><span class="plink">${n} objective${n===1?"":"s"}</span>${ro()?"":`<button class="del" data-pact="del" aria-label="Remove priority">&times;</button>`}`;
      li.querySelector(".ptxt").textContent=p.text; list.appendChild(li);
    });
  }
  function renderTools(){
    const m=getMeta(me); $("#fillStd").disabled=!m.template;
    const g=guards(me);
    for(const [id,k] of [["gRest","minRest"],["gFam","minFamily"],["gEve","maxWorkEvenings"]]){const el=$("#"+id); if(document.activeElement!==el) el.value=g[k]}
  }
  let staffSeq=0;
  async function renderStaff(){
    const seq=++staffSeq;
    const box=$("#staff");
    const ids=user?[me,...people.filter(p=>p!==me)]:[me];
    let ps={}; try{if(user) ps=await user.profiles(ids)}catch(e){}
    if(seq!==staffSeq) return;
    const dates=weekDates(), tk=todayKey();
    const head=`<tr><th class="who">Staff</th>${dates.map(d=>{const dt=dateOf(d);return `<th class="${d===tk?"today-col":""}">${DOW3[dt.getDay()]}<small>${MON[dt.getMonth()]} ${dt.getDate()}</small></th>`}).join("")}</tr>`;
    const bar=(blk,label)=>{
      const titleFor=o=>{const b=o.items.filter(i=>i.kind==="break").length;return [...o.items.filter(i=>i.kind==="obj").map(i=>i.text),...(b?[b+" hr break"]:[])].join(" · ")};
      if(blk.split){const [h0,h1]=blk.halves;const t=[titleFor(h0),titleFor(h1)].filter(Boolean).join(" · ");
        return `<div class="sb" style="background:linear-gradient(90deg,${COLOR[h0.mode]} 50%,${COLOR[h1.mode]} 50%)" title="${esc(label+": "+TYPE_NAME[h0.mode]+" / "+TYPE_NAME[h1.mode]+(t?" — "+t:""))}">${TYPE_TINY[h0.mode]} / ${TYPE_TINY[h1.mode]}</div>`}
      const m=blk.mode; const t=titleFor(blk);
      return `<div class="sb ${m||"none"}" title="${esc(label+": "+(m?TYPE_NAME[m]:"Not set")+(t?" — "+t:""))}">${m?TYPE_TINY[m]:"—"}</div>`;
    };
    const rows=ids.map(pid=>{
      const p=ps[pid]||{}; const name=pid===me?"You":(p.name||"Staff member");
      const P=getWeek(pid,wsKey()).priorities;
      return `<tr><td class="who"><button data-pid="${pid}">${p.avatarUrl?`<img alt="" src="${esc(p.avatarUrl)}">`:""}<span>${esc(name)}</span></button>${P.length?`<ol>${P.map(x=>`<li>${esc(x.text)}</li>`).join("")}</ol>`:""}</td>
        ${dates.map(d=>{const day=getDay(pid,d);return `<td class="${d===tk?"today-col":""}"><div class="sday">${BLOCKS.map(([b,l])=>bar(day.blocks[b],l)).join("")}</div></td>`}).join("")}</tr>`;
    }).join("");
    box.innerHTML=`<div class="staffwrap"><table class="staff"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
  }
  function select(pid){viewing=pid; renderAll()}
  $("#people").addEventListener("click",e=>{const b=e.target.closest(".person");if(b)select(b.dataset.pid)});
  $("#staff").addEventListener("click",e=>{const b=e.target.closest("[data-pid]");if(b){viewing=b.dataset.pid;tab="week";renderAll()}});

  /* ---------- saving ---------- */
  const pend={}, busyK={}, timersK={};
  function setStatus(t){$("#status").textContent=t}
  function isBusy(k){return !!pend[k]||!!busyK[k]}
  function queue(k,write){pend[k]=write;clearTimeout(timersK[k]);timersK[k]=setTimeout(()=>run(k),450)}
  async function run(k){
    if(!backend||busyK[k]||!pend[k]) return;
    const w=pend[k]; delete pend[k]; busyK[k]=true;
    let failed=false;
    try{await w();setStatus(backend.label)}
    catch(e){
      failed=true;
      setStatus("Couldn't save. Check your connection — trying again shortly.");
      if(!pend[k]) pend[k]=w;
      clearTimeout(timersK[k]); timersK[k]=setTimeout(()=>run(k),5000);
    }
    busyK[k]=false;
    if(!failed&&pend[k]) run(k);
  }
  function flushAll(){Object.keys(pend).forEach(run)}
  async function upsert(table,row){row.updated_at=new Date().toISOString();const {error}=await sb.from(table).upsert(row);if(error)throw error}
  function saveDay(date){queue("day:"+date,()=>upsert("days",{user_id:me,date,data:clone(getDay(me,date))}))}
  function saveWeek(){const ws=wsKey();queue("doc:weeks/"+ws,()=>upsert("weeks",{user_id:me,week_start:ws,data:clone(getWeek(me,ws))}))}
  function saveMeta(name){queue("doc:meta/"+name,()=>upsert("meta",{user_id:me,name,data:clone(getMeta(me)[name]||{})}))}

  /* ---------- shared store (Supabase) ---------- */
  const CFG=window.TBW_CONFIG||{};
  let sb=null, loadSeq=0;
  const profileMap={};
  function applyDay(row){
    const pid=row.user_id, date=String(row.date).slice(0,10);
    if(pid===me&&isBusy("day:"+date)) return null;
    mapOf(pid)[date]=clone(row.data); return {pid,date};
  }
  async function loadWeek(){
    const seq=++loadSeq, dates=weekDates(), ws=wsKey();
    const [d,w,m]=await Promise.all([
      sb.from("days").select("user_id,date,data").gte("date",dates[0]).lte("date",dates[6]),
      sb.from("weeks").select("user_id,week_start,data").eq("week_start",ws),
      sb.from("meta").select("user_id,name,data")
    ]);
    if(seq!==loadSeq) return;
    if(d.error||w.error||m.error){setStatus("Couldn't load the planner. Check your connection and reload the page.");return}
    for(const pid of Object.keys(daysBy)) for(const date of dates) if(!(pid===me&&isBusy("day:"+date))) delete daysBy[pid][date];
    d.data.forEach(applyDay);
    w.data.forEach(r=>{ if(r.user_id===me&&isBusy("doc:weeks/"+ws)) return; (weeksBy[r.user_id]||(weeksBy[r.user_id]={}))[ws]=clone(r.data) });
    m.data.forEach(r=>{ if(r.user_id===me&&isBusy("doc:meta/"+r.name)) return; getMeta(r.user_id)[r.name]=clone(r.data) });
    setStatus(backend.label);
    requestFull();
  }
  function resubscribeAll(){ if(sb&&backend) loadWeek() }
  function startRealtime(){
    const row=p=>(p.new&&Object.keys(p.new).length)?p.new:null;
    sb.channel("planner")
      .on("postgres_changes",{event:"*",schema:"public",table:"days"},p=>{
        const r0=row(p); if(!r0) return;
        const r=applyDay(r0); if(!r||!weekDates().includes(r.date)) return;
        if(r.pid===viewing) renderDay(r.date); else {renderTeam(); if(tab==="staff") renderStaff()}
        renderSummary();
      })
      .on("postgres_changes",{event:"*",schema:"public",table:"weeks"},p=>{
        const r=row(p); if(!r) return; const ws=String(r.week_start).slice(0,10);
        if(r.user_id===me&&isBusy("doc:weeks/"+ws)) return;
        (weeksBy[r.user_id]||(weeksBy[r.user_id]={}))[ws]=clone(r.data);
        if(ws===wsKey()) requestFull();
      })
      .on("postgres_changes",{event:"*",schema:"public",table:"meta"},p=>{
        const r=row(p); if(!r) return;
        if(r.user_id===me&&isBusy("doc:meta/"+r.name)) return;
        getMeta(r.user_id)[r.name]=clone(r.data);
        if(r.user_id===me) renderTools(); renderSummary();
      })
      .on("postgres_changes",{event:"*",schema:"public",table:"profiles"},p=>{
        const r=row(p); if(!r) return; profileMap[r.id]=r; if(!people.includes(r.id)) people.push(r.id); requestFull();
      })
      .subscribe();
  }
  async function ensureDay(date){
    if(weekDates().includes(date)||outsideLoaded.has(date)) return getDay(me,date);
    try{const {data}=await sb.from("days").select("user_id,date,data").eq("user_id",me).eq("date",date).maybeSingle(); if(data) applyDay(data)}catch(e){}
    outsideLoaded.add(date); return getDay(me,date);
  }
  async function fetchWeek(ws){
    const dates=weekDates(ws), out={};
    try{const {data}=await sb.from("days").select("date,data").eq("user_id",me).gte("date",dates[0]).lte("date",dates[6]);
      (data||[]).forEach(r=>{const d=String(r.date).slice(0,10);out[d]=norm(clone(r.data),d)})}catch(e){}
    return dates.map(d=>out[d]?out[d].blocks:null);
  }

  /* ---------- calendar (Google Calendar API, the viewer's own calendar) ---------- */
  const GTOKEN="tbw-google-token";
  let calTimer=null;
  function getGToken(){try{const t=JSON.parse(localStorage.getItem(GTOKEN)||"null");if(t&&t.exp>Date.now()+60000)return t.token}catch(e){}return null}
  function storeGToken(session){if(session&&session.provider_token){try{localStorage.setItem(GTOKEN,JSON.stringify({token:session.provider_token,exp:Date.now()+55*60000}))}catch(e){}}}
  function parseCal(p){
    const out={}; const slot=d=>out[d]||(out[d]={allDay:[],m:[],a:[],e:[]});
    for(const ev of (p&&p.items)||[]){
      if(ev.status==="cancelled") continue;
      const title=ev.summary||"(No title)";
      if(ev.start&&ev.start.date){
        const sd=String(ev.start.date).slice(0,10), ed=String((ev.end&&ev.end.date)||ev.start.date).slice(0,10);
        let d=dateOf(sd), guard=0;
        do{slot(key(d)).allDay.push(title);d=addDays(d,1);guard++}while(key(d)<ed&&guard<31);
      }else if(ev.start&&ev.start.dateTime){
        const d=new Date(ev.start.dateTime); if(isNaN(d)) continue;
        const h=d.getHours(), b=h<12?"m":h<17?"a":"e";
        slot(key(d))[b].push({time:d.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"}),title,t:d.getTime()});
      }
    }
    Object.values(out).forEach(s=>["m","a","e"].forEach(b=>s[b].sort((x,y)=>x.t-y.t)));
    return out;
  }
  async function loadCal(){
    clearTimeout(calTimer);
    if(CFG.googleCalendar===false){calMsg="";return}
    const tok=getGToken();
    if(!tok){calBy={};calMsg="connect";requestFull();return}
    const ws=wsKey();
    const q=new URLSearchParams({timeMin:weekStart.toISOString(),timeMax:addDays(weekStart,7).toISOString(),singleEvents:"true",orderBy:"startTime",maxResults:"250"});
    try{
      const r=await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?"+q,{headers:{Authorization:"Bearer "+tok}});
      if(ws!==wsKey()) return;
      if(r.status===401||r.status===403){try{localStorage.removeItem(GTOKEN)}catch(e){};calBy={};calMsg="connect"}
      else if(!r.ok) calMsg="Google Calendar couldn't refresh just now. Showing the last events loaded.";
      else {calBy=parseCal(await r.json());calMsg=""}
    }catch(e){calMsg="Google Calendar couldn't refresh just now. Showing the last events loaded."}
    requestFull();
    calTimer=setTimeout(loadCal,300000);
  }
  function watchCal(){ if(!sb||!backend) return; calBy={}; loadCal() }
  function signInGoogle(){
    return sb.auth.signInWithOAuth({provider:"google",options:{
      redirectTo:location.origin+location.pathname,
      scopes:CFG.googleCalendar===false?undefined:"https://www.googleapis.com/auth/calendar.readonly"}});
  }

  /* ---------- sign-in ---------- */
  function showGate(kind,detail){
    const gate=$("#gate"), app=$("#app");
    if(!kind){gate.hidden=true;app.hidden=false;return}
    app.hidden=true; gate.hidden=false;
    gate.querySelectorAll("[data-gate]").forEach(el=>el.hidden=el.dataset.gate!==kind);
    if(kind==="notstaff") $("#gateEmail").textContent=detail||"";
  }
  async function connect(){
    if(!CFG.supabaseUrl||!CFG.supabaseAnonKey||!window.supabase){showGate("setup");return}
    sb=window.supabase.createClient(CFG.supabaseUrl,CFG.supabaseAnonKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    sb.auth.onAuthStateChange((ev,session)=>{ if(session) storeGToken(session); if(ev==="SIGNED_OUT") location.reload() });
    const {data:{session}}=await sb.auth.getSession();
    if(!session){showGate("signin");return}
    storeGToken(session);
    try{await start(session)}catch(e){showGate("error")}
  }
  async function start(session){
    const u=session.user; me=u.id; viewing=me;
    const {data:ok,error}=await sb.rpc("is_staff");
    if(error) throw error;
    if(!ok){showGate("notstaff",u.email);return}
    const md=u.user_metadata||{};
    const {data:existing}=await sb.from("profiles").select("name").eq("id",me).maybeSingle();
    await sb.from("profiles").upsert({id:me,email:u.email,name:(existing&&existing.name)||md.full_name||md.name||u.email.split("@")[0],avatar_url:md.avatar_url||md.picture||null,updated_at:new Date().toISOString()});
    const {data:ps}=await sb.from("profiles").select("id,email,name,avatar_url");
    (ps||[]).forEach(p=>{profileMap[p.id]=p}); people=(ps||[]).map(p=>p.id);
    user={profiles:async ids=>{const o={};(Array.isArray(ids)?ids:[ids]).forEach(id=>{const p=profileMap[id]||{};o[id]={name:p.name||p.email||"",avatarUrl:p.avatar_url||""}});return o}};
    backend={label:"Saved · visible to staff"};
    $("#acct").textContent=u.email;
    showGate(null);
    startRealtime();
    await bcSaveFromHash();
    await loadWeek();
    watchCal();
    flushAll();
    bcLoad();
  }
  $("#gGoogle").onclick=()=>signInGoogle();
  $("#gEmailForm").addEventListener("submit",async e=>{
    e.preventDefault();
    const email=$("#gEmail").value.trim(); if(!email) return;
    const msg=$("#gEmailMsg"); msg.textContent="Sending…";
    const {error}=await sb.auth.signInWithOtp({email,options:{emailRedirectTo:location.origin+location.pathname,shouldCreateUser:true}});
    msg.textContent=error?"Couldn't send the link. Check the address and try again.":"Check your email for a sign-in link. You can close this tab.";
  });
  $("#signOut").onclick=async()=>{try{localStorage.removeItem(GTOKEN)}catch(e){}; await sb.auth.signOut(); location.reload()};
  document.querySelectorAll("[data-signout]").forEach(b=>b.onclick=$("#signOut").onclick);
  $("#calStatus").addEventListener("click",e=>{ if(e.target.closest("#calConnect")) signInGoogle() });

  /* ---------- editing: context + moves ---------- */
  function ctxAt(date,b,h){
    const blk=getDay(me,date).blocks[b];
    const hh=(h!==null&&h!==undefined&&blk.split)?Number(h):null;
    return {date,b,h:hh,blk,target:hh!==null?blk.halves[hh]:blk,ids:`${date}-${b}`+(hh!==null?`-${hh}`:"")};
  }
  function ctx(el){
    const bEl=el.closest(".block"); if(!bEl) return null;
    const hEl=el.closest(".half");
    return ctxAt(bEl.dataset.date,bEl.dataset.b,hEl?hEl.dataset.h:null);
  }
  function findItem(o,id,parent){
    if(parent){const ob=o.items.find(i=>i.id===parent);return ob?{item:ob.tasks.find(t=>t.id===id),owner:ob}:null}
    return {item:o.items.find(i=>i.id===id)};
  }
  function takeItem(x,id,parent){
    const f=findItem(x.target,id,parent); if(!f||!f.item) return null;
    if(f.owner){f.owner.tasks=f.owner.tasks.filter(t=>t.id!==id);return {id:f.item.id,kind:"task",text:f.item.text,done:!!f.item.done}}
    x.target.items=x.target.items.filter(i=>i.id!==id); return f.item;
  }
  function dropInto(date,b,h,item){
    const blk=getDay(me,date).blocks[b];
    const c=blk.split?blk.halves[h!==null&&h!==undefined?Number(h):0]:blk;
    c.items.push(item);
  }
  function moveItem(fromX,id,parent,toDate,toB,toH){
    if(fromX.date===toDate&&fromX.b===toB&&(fromX.h??null)===(toH??null)&&!parent) return;
    const item=takeItem(fromX,id,parent); if(!item) return;
    dropInto(toDate,toB,toH,item);
    saveDay(fromX.date); if(toDate!==fromX.date) saveDay(toDate);
    renderDay(fromX.date); if(toDate!==fromX.date) renderDay(toDate);
  }
  function extractUnfinished(c){
    const out=[], keep=[];
    for(const it of c.items){
      if(it.kind==="obj"){
        const undone=it.tasks.filter(t=>!t.done);
        if(undone.length){
          const done=it.tasks.filter(t=>t.done);
          out.push({id:done.length?uid():it.id,kind:"obj",text:it.text,pri:it.pri,tasks:undone});
          if(!done.length) continue;
          it.tasks=done;
        }
        keep.push(it);
      }else if(it.kind!=="break"&&!it.done) out.push(it); else keep.push(it);
    }
    c.items=keep; return out;
  }
  async function carry(date){
    if(document.activeElement&&document.activeElement.blur) document.activeElement.blur();
    const tk=todayKey();
    const target=date<tk?tk:key(addDays(dateOf(date),1));
    const src=getDay(me,date);
    const moves=[];
    for(const {b,c} of containers(src)){const items=extractUnfinished(c);if(items.length)moves.push({b,items})}
    if(!moves.length) return;
    const dst=await ensureDay(target);
    for(const {b,items} of moves){
      let slot=b; const bad=m=>m==="rest"||m==="family";
      if(!dst.blocks[slot].split&&bad(dst.blocks[slot].mode)){const alt=BLOCKS.map(x=>x[0]).find(s=>dst.blocks[s].split||!bad(dst.blocks[s].mode));if(alt)slot=alt}
      items.forEach(it=>dropInto(target,slot,0,it));
    }
    saveDay(date); saveDay(target);
    const n=moves.reduce((s,m)=>s+m.items.length,0);
    setStatus(`Moved ${n} item${n>1?"s":""} to ${target===tk?"today":DOW[dateOf(target).getDay()]}`);
    renderDay(date); renderDay(target);
  }
  function moveOptions(curDate,curB){
    return `<option value="">Keep in this block</option>`+weekDates().flatMap(d=>{const dt=dateOf(d);return BLOCKS.map(([b,l])=>
      (d===curDate&&b===curB)?"":`<option value="${d}|${b}">Move to ${DOW3[dt.getDay()]} ${MON[dt.getMonth()]} ${dt.getDate()} · ${l}</option>`)}).join("");
  }
  function openEdit(txt){
    const row=txt.closest(".it"); if(!row||row.querySelector(".edit")) return;
    const x=ctx(row); if(!x) return;
    const isObj=row.classList.contains("obj");
    const f=findItem(x.target,row.dataset.id,row.dataset.parent); if(!f||!f.item) return;
    const P=pris();
    const form=document.createElement("div"); form.className="edit";
    form.innerHTML=`<input class="etext" type="text" aria-label="Text">
      ${isObj&&P.length?`<select class="epri" aria-label="Weekly priority"><option value="">No weekly priority</option>${P.map((p,i)=>`<option value="${p.id}">P${i+1} · ${esc(p.text)}</option>`).join("")}</select>`:""}
      <select class="emove" aria-label="Move">${moveOptions(x.date,x.b)}</select>
      <div class="erow"><button class="primary" data-act="esave">Save</button><button data-act="ecancel">Cancel</button></div>`;
    row.replaceChildren(form); row.removeAttribute("draggable");
    const inp=form.querySelector(".etext"); inp.value=f.item.text;
    if(form.querySelector(".epri")) form.querySelector(".epri").value=f.item.pri||"";
    inp.focus(); inp.select();
  }
  function commitEdit(row){
    const x=ctx(row); const form=row.querySelector(".edit"); if(!x||!form) return;
    const id=row.dataset.id, parent=row.dataset.parent;
    const f=findItem(x.target,id,parent); if(!f||!f.item){renderDay(x.date);return}
    const text=form.querySelector(".etext").value.trim(); if(text) f.item.text=text;
    const pri=form.querySelector(".epri"); if(pri){ if(pri.value) f.item.pri=pri.value; else delete f.item.pri }
    const mv=form.querySelector(".emove").value;
    row.replaceChildren();
    if(mv){const [d,b]=mv.split("|");moveItem(x,id,parent,d,b,0)} else {saveDay(x.date);renderDay(x.date)}
  }

  /* ---------- block interactions ---------- */
  weekEl.addEventListener("click",e=>{
    const cb=e.target.closest("[data-carry]"); if(cb){ if(!ro()) carry(cb.dataset.carry); return }
    if(ro()) return;
    const t=e.target.closest("[data-act]"); if(!t) return; const x=ctx(t); if(!x) return;
    const act=t.dataset.act;
    if(act==="edit"){openEdit(t);return}
    if(act==="esave"){commitEdit(t.closest(".it"));return}
    if(act==="ecancel"){t.closest(".it").replaceChildren();renderDay(x.date);return}
    if(act==="mode"){const v=t.dataset.modeV;
      if(x.h!==null){x.target.mode=v} else {x.blk.mode=x.blk.mode===v?null:v}
      saveDay(x.date);renderDay(x.date)}
    else if(act==="split"){
      const first=SPLITTABLE.includes(x.blk.mode)?x.blk.mode:"office";
      x.blk.split=true; x.blk.halves=[{mode:first,items:x.blk.items},{mode:first,items:[]}]; x.blk.items=[]; x.blk.mode=null;
      saveDay(x.date);renderDay(x.date)}
    else if(act==="merge"){
      const [h0,h1]=x.blk.halves; x.blk.items=[...h0.items,...h1.items]; x.blk.mode=h0.mode; x.blk.split=false; delete x.blk.halves;
      saveDay(x.date);renderDay(x.date)}
    else if(act==="break"){
      const bk={id:uid(),kind:"break",text:"Errand",mins:60};
      if(x.date===todayKey()) bk.until=Date.now()+60*60000;
      x.target.items.push(bk); saveDay(x.date); renderDay(x.date);
      const txt=weekEl.querySelector(`.it.brk[data-id="${bk.id}"] .txt`); if(txt) openEdit(txt);
      setStatus(bk.until?"Break added — you're back at "+new Date(bk.until).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"}):"One-hour break added");
    }
    else if(act==="kind"){const inId=`in-${x.ids}`;const k=kindPref[inId]=(t.dataset.kind==="obj")?"task":"obj";
      t.dataset.kind=k;t.textContent=k==="obj"?"Objective":"Task";const inp=document.getElementById(inId);inp.placeholder=k==="obj"?"Add an objective":"Add a task";inp.focus()}
    else if(act==="del"){
      const li=t.closest("[data-id]"); const id=li.dataset.id, parent=li.dataset.parent;
      const f=findItem(x.target,id,parent); if(!f) return;
      if(f.owner) f.owner.tasks=f.owner.tasks.filter(i=>i.id!==id); else x.target.items=x.target.items.filter(i=>i.id!==id);
      saveDay(x.date); renderDay(x.date,`in-${x.ids}`);
    }
  });
  weekEl.addEventListener("change",e=>{
    const t=e.target; if(ro()||t.dataset.act!=="check") return; const x=ctx(t);
    const li=t.closest(".it"); const f=findItem(x.target,li.dataset.id,li.dataset.parent); if(!f||!f.item) return;
    f.item.done=t.checked; li.classList.toggle("done",t.checked); saveDay(x.date);
    if(f.item.bc&&f.item.bc.id!=null&&f.item.bc.type!=="card"){markPlannedDone(f.item.bc.id,t.checked);bcSetDone(f.item.bc.id,t.checked)}
    const day=weekEl.querySelector(`[data-day="${x.date}"] .dlabel`);
    if(day){const had=!!day.querySelector(".carry"), has=x.date<=todayKey()&&hasUnfinished(getDay(me,x.date)); if(had!==has) renderDay(x.date)}
  });
  weekEl.addEventListener("keydown",e=>{
    const t=e.target; if(ro()) return;
    if(t.classList&&t.classList.contains("etext")){
      if(e.key==="Enter"){e.preventDefault();commitEdit(t.closest(".it"))}
      else if(e.key==="Escape"){const x=ctx(t);t.closest(".it").replaceChildren();renderDay(x.date)}
      return;
    }
    if(t.matches&&t.matches('.txt[data-act="edit"]')&&(e.key==="Enter"||e.key===" ")){e.preventDefault();openEdit(t);return}
    if(t.tagName!=="INPUT"||t.type!=="text"||e.key!=="Enter") return;
    const text=t.value.trim(); if(!text) return; e.preventDefault();
    const x=ctx(t);
    if(t.dataset.parent){
      const ob=x.target.items.find(i=>i.id===t.dataset.parent); if(!ob) return;
      ob.tasks.push({id:uid(),text,done:false});
    }else{
      const kind=kindPref[t.id]||"task";
      x.target.items.push(kind==="obj"?{id:uid(),kind:"obj",text,tasks:[]}:{id:uid(),kind:"task",text,done:false});
    }
    saveDay(x.date); renderDay(x.date,t.id);
  });
  weekEl.addEventListener("focusout",()=>{
    setTimeout(()=>{
      if(typing()) return;
      if(pendingFull){renderAll();return}
      Object.keys(pendingRender).forEach(d=>{delete pendingRender[d];renderDay(d)});
    },0);
  });
  // drag and drop between blocks (desktop)
  let dragSrc=null;
  weekEl.addEventListener("dragstart",e=>{
    const el=e.target.closest&&e.target.closest('[draggable="true"]'); if(!el||ro()) return;
    const x=ctx(el); if(!x) return;
    dragSrc={date:x.date,b:x.b,h:x.h,id:el.dataset.id,parent:el.dataset.parent||null};
    try{e.dataTransfer.setData("text/plain",el.dataset.id);e.dataTransfer.effectAllowed="move"}catch(_){}
  });
  function dropZone(t){return t.closest&&(t.closest(".half")||t.closest(".block:not(.is-split)"))}
  weekEl.addEventListener("dragover",e=>{ if(!dragSrc&&!dragBc) return; const z=dropZone(e.target); if(!z) return; e.preventDefault();
    weekEl.querySelectorAll(".drop").forEach(n=>n!==z&&n.classList.remove("drop")); z.classList.add("drop") });
  weekEl.addEventListener("dragleave",e=>{const z=dropZone(e.target); if(z&&!z.contains(e.relatedTarget)) z.classList.remove("drop")});
  weekEl.addEventListener("dragend",()=>{dragSrc=null;weekEl.querySelectorAll(".drop").forEach(n=>n.classList.remove("drop"))});
  weekEl.addEventListener("drop",e=>{
    if(!dragSrc&&!dragBc) return; const z=dropZone(e.target); if(!z) return; e.preventDefault();
    const bEl=z.closest(".block"), h=z.classList.contains("half")?Number(z.dataset.h):null;
    if(dragBc){const it=dragBc;dragBc=null;z.classList.remove("drop");if(!ro()) bcAddToBlock(it,bEl.dataset.date,bEl.dataset.b,h);return}
    const s=dragSrc; dragSrc=null;
    moveItem(ctxAt(s.date,s.b,s.h),s.id,s.parent,bEl.dataset.date,bEl.dataset.b,h);
  });

  /* ---------- Basecamp ---------- */
  const bcState={status:"idle",items:[],account:"",msg:"",busy:{}};
  let bcTimer=null, dragBc=null;
  async function bcFetch(path,opts){
    const {data:{session}}=await sb.auth.getSession();
    if(!session) throw new Error("signed out");
    const r=await fetch(path,Object.assign({},opts,{headers:Object.assign({"Content-Type":"application/json",Authorization:"Bearer "+session.access_token},(opts&&opts.headers)||{})}));
    const j=await r.json().catch(()=>({}));
    if(!r.ok) throw Object.assign(new Error(j.error||"request failed"),{status:r.status,body:j});
    return j;
  }
  async function bcLoad(quiet){
    clearTimeout(bcTimer);
    if(!sb||!backend) return;
    if(!quiet&&bcState.status==="idle"){bcState.status="loading";renderBC()}
    try{
      const j=await bcFetch("/api/basecamp/todos");
      if(!j.configured){bcState.status="off"}
      else if(!j.connected){bcState.status="disconnected";bcState.msg=j.reason==="expired"?"Your Basecamp connection expired. Connect again to keep seeing your to-dos.":""}
      else if(j.busy){bcState.msg="Basecamp asked us to slow down. Trying again shortly."}
      else{bcState.status="ready";bcState.items=j.items||[];bcState.account=j.account||"";bcState.msg=""}
    }catch(e){ if(bcState.status!=="ready") bcState.status="error"; bcState.msg=e.message&&e.status?e.message:"Couldn't reach Basecamp. Showing what was loaded last." }
    renderBC();
    bcTimer=setTimeout(()=>bcLoad(true),5*60000);
  }
  async function bcConnect(){
    const btn=$("#bcConnect"); if(btn){btn.disabled=true;btn.textContent="Opening Basecamp…"}
    try{const j=await bcFetch("/api/basecamp/start",{method:"POST",body:"{}"}); if(j.url) location.href=j.url}
    catch(e){bcState.msg="Couldn't start the Basecamp connection. Try again.";renderBC()}
  }
  async function bcDisconnect(){
    await sb.from("basecamp_links").delete().eq("user_id",me);
    bcState.status="disconnected";bcState.items=[];bcState.msg="Basecamp disconnected.";renderBC();
  }
  async function bcSaveFromHash(){
    const h=location.hash.slice(1); if(!/^bc-(link|error)=/.test(h)) return;
    history.replaceState(null,"",location.pathname+location.search);
    const p=new URLSearchParams(h);
    if(p.get("bc-error")){
      const why={declined:"You chose not to connect Basecamp.","no-account":"That Basecamp login doesn't have a Basecamp account to read.",expired:"The Basecamp connection took too long. Try again."}[p.get("bc-error")]||"Couldn't connect Basecamp. Try again.";
      bcState.msg=why; return;
    }
    const {error}=await sb.from("basecamp_links").upsert({user_id:me,blob:p.get("bc-link"),account:p.get("bc-name")||"",updated_at:new Date().toISOString()});
    bcState.msg=error?"Couldn't save the Basecamp connection. Try connecting again.":"Basecamp connected.";
  }
  // Where each Basecamp to-do is already planned this week.
  function bcPlanned(){
    const out={};
    for(const date of weekDates()) for(const {b,c} of containers(getDay(me,date))) for(const it of c.items)
      if(it.bc&&it.bc.id!=null) (out[it.bc.id]||(out[it.bc.id]=[])).push({date,b,done:!!it.done});
    return out;
  }
  function blockLabel(date,b){const dt=dateOf(date);return `${date===todayKey()?"Today":DOW3[dt.getDay()]} · ${BLOCKS.find(x=>x[0]===b)[1]}`}
  function dueLabel(d){
    if(!d) return "";
    const tk=todayKey(); if(d<tk) return "Overdue";
    if(d===tk) return "Due today";
    if(d===key(addDays(new Date(),1))) return "Due tomorrow";
    const dt=dateOf(d); return `Due ${DOW3[dt.getDay()]} ${MON[dt.getMonth()]} ${dt.getDate()}`;
  }
  function planOptions(){
    const dates=tab==="today"?[todayKey(),...weekDates().filter(d=>d>todayKey())]:weekDates();
    return `<option value="">Plan into a block…</option>`+dates.flatMap(d=>BLOCKS.map(([b])=>{
      const blk=getDay(me,d).blocks[b], m=blk.split?null:blk.mode, off=m==="rest"||m==="family";
      return `<option value="${d}|${b}"${off?" disabled":""}>${blockLabel(d,b)}${off?` (${TYPE_NAME[m]})`:""}</option>`})).join("");
  }
  function renderBC(){
    const box=$("#bc"); if(!box) return;
    const hide=tab==="staff"||ro()||bcState.status==="off"||!backend;
    box.hidden=hide; if(hide) return;
    const head=`<div class="bchead"><h2>Basecamp to-dos</h2>${bcState.status==="ready"?`<span class="bcacct">${esc(bcState.account)}</span><button class="linkbtn" id="bcRefresh">Refresh</button><button class="linkbtn" id="bcDisc">Disconnect</button>`:""}</div>`;
    const msg=bcState.msg?`<p class="bcmsg" role="status">${esc(bcState.msg)}</p>`:"";
    if(bcState.status==="loading"||bcState.status==="idle"){box.innerHTML=head+`<p class="bcmsg">Loading your Basecamp to-dos…</p>`;return}
    if(bcState.status==="disconnected"||(bcState.status==="error"&&!bcState.items.length)){
      box.innerHTML=head+msg+`<p class="bcintro">See the to-dos assigned to you in Basecamp, plan them into a block, and check them off here or there.</p><button class="btn primary" id="bcConnect">Connect Basecamp</button>`;return}
    const planned=bcPlanned(), tk=todayKey();
    const items=[...bcState.items].sort((a,b)=>(b.upNext?1:0)-(a.upNext?1:0)||((a.due_on||"9999")<(b.due_on||"9999")?-1:(a.due_on||"9999")>(b.due_on||"9999")?1:0));
    const open=items.filter(i=>!planned[i.id]), sched=items.filter(i=>planned[i.id]);
    const row=i=>{
      const p=planned[i.id], due=dueLabel(i.due_on), late=i.due_on&&i.due_on<tk, canCheck=i.type==="todo";
      return `<li class="bcitem" data-bc="${i.id}" draggable="true">
        ${canCheck?`<input type="checkbox" data-bcact="done" id="bc-${i.id}" aria-label="Mark done in Basecamp"${bcState.busy[i.id]?" disabled":""}>`:`<span class="bccard" title="Basecamp card">▭</span>`}
        <div class="bcmain"><a class="bctitle" href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.content||"(untitled)")}</a>
          <div class="bcmeta">${i.upNext?`<span class="bcchip up">Up next</span>`:""}${due?`<span class="bcchip${late?" late":""}">${due}</span>`:""}<span>${esc(i.project||"")}${i.list?` · ${esc(i.list)}`:""}</span></div>
          ${p?`<div class="bcplanned">Planned: ${p.map(x=>blockLabel(x.date,x.b)).join(", ")}</div>`:""}
        </div>
        <select class="bcplan" data-bcact="plan" aria-label="Plan into a block">${planOptions()}</select>
      </li>`;
    };
    box.innerHTML=head+msg+(items.length?
      `${open.length?`<ul class="bclist">${open.map(row).join("")}</ul>`:`<p class="bcmsg">Everything assigned to you is planned this week.</p>`}
       ${sched.length?`<details class="bcsched"><summary>Planned this week (${sched.length})</summary><ul class="bclist">${sched.map(row).join("")}</ul></details>`:""}`
      :`<p class="bcmsg">Nothing is assigned to you in Basecamp right now.</p>`);
  }
  function bcAddToBlock(item,date,b,h){
    const exists=containers(getDay(me,date)).some(({b:bb,c})=>bb===b&&c.items.some(x=>x.bc&&x.bc.id===item.id));
    if(exists){setStatus("That to-do is already in this block.");return}
    dropInto(date,b,h,{id:uid(),kind:"task",text:item.content||"Basecamp to-do",done:false,bc:{id:item.id,url:item.url,project:item.project||"",type:item.type}});
    saveDay(date); renderDay(date); renderBC();
    setStatus(`Planned “${item.content}” for ${blockLabel(date,b)}`);
  }
  async function bcSetDone(id,done){
    if(bcState.busy[id]) return; bcState.busy[id]=true;
    try{
      const j=await bcFetch("/api/basecamp/complete",{method:"POST",body:JSON.stringify({id,done})});
      if(j.connected===false){bcState.status="disconnected";bcState.msg="Your Basecamp connection expired. Connect again to keep syncing check-offs."}
      else{
        if(done) bcState.items=bcState.items.filter(i=>i.id!==id);
        setStatus(done?"Checked off in Basecamp":"Reopened in Basecamp");
        if(!done) bcLoad(true);
      }
    }catch(e){setStatus(e.message||"Couldn't update Basecamp")}
    delete bcState.busy[id]; renderBC();
  }
  function markPlannedDone(id,done){
    for(const date of weekDates()){let ch=false;
      for(const {c} of containers(getDay(me,date))) c.items.forEach(it=>{if(it.bc&&it.bc.id===id&&!!it.done!==done){it.done=done;ch=true}});
      if(ch){saveDay(date);renderDay(date)}}
  }
  $("#bc").addEventListener("click",e=>{
    const t=e.target;
    if(t.id==="bcConnect") bcConnect();
    else if(t.id==="bcRefresh"){bcState.msg="";bcLoad()}
    else if(t.id==="bcDisc") bcDisconnect();
  });
  $("#bc").addEventListener("change",e=>{
    const t=e.target, li=t.closest("[data-bc]"); if(!li) return;
    const id=Number(li.dataset.bc), item=bcState.items.find(i=>i.id===id); if(!item) return;
    if(t.dataset.bcact==="done"&&t.checked){markPlannedDone(id,true);bcSetDone(id,true)}
    else if(t.dataset.bcact==="plan"&&t.value){const [d,b]=t.value.split("|");bcAddToBlock(item,d,b,0)}
  });
  $("#bc").addEventListener("dragstart",e=>{
    const li=e.target.closest&&e.target.closest("[data-bc]"); if(!li) return;
    dragBc=bcState.items.find(i=>i.id===Number(li.dataset.bc))||null;
    try{e.dataTransfer.setData("text/plain",li.dataset.bc);e.dataTransfer.effectAllowed="copy"}catch(_){}
  });
  $("#bc").addEventListener("dragend",()=>{dragBc=null;weekEl.querySelectorAll(".drop").forEach(n=>n.classList.remove("drop"))});
  window.addEventListener("focus",()=>{ if(bcState.status==="ready") bcLoad(true) });

  /* ---------- priorities ---------- */
  function addPriority(){
    const inp=$("#prioInput"), text=inp.value.trim(); if(!text||ro()) return;
    getWeek(me,wsKey()).priorities.push({id:uid(),text,done:false}); inp.value="";
    saveWeek(); renderPrio(); inp.focus();
  }
  $("#prioBtn").onclick=addPriority;
  $("#prioInput").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();addPriority()}});
  $("#prioInput").addEventListener("blur",()=>setTimeout(()=>{if(!typing()&&pendingFull)renderAll()},0));
  $("#prioList").addEventListener("click",e=>{
    const t=e.target.closest('[data-pact="del"]'); if(!t||ro()) return;
    const id=t.closest("li").dataset.id, w=getWeek(me,wsKey());
    w.priorities=w.priorities.filter(p=>p.id!==id);
    for(const date of weekDates()){let ch=false;for(const {c} of containers(getDay(me,date)))c.items.forEach(i=>{if(i.pri===id){delete i.pri;ch=true}});if(ch)saveDay(date)}
    saveWeek(); renderAll();
  });
  $("#prioList").addEventListener("change",e=>{
    const t=e.target; if(t.dataset.pact!=="check"||ro()) return;
    const p=getWeek(me,wsKey()).priorities.find(x=>x.id===t.closest("li").dataset.id); if(!p) return;
    p.done=t.checked; t.closest("li").classList.toggle("done",p.done); saveWeek();
  });

  /* ---------- week tools ---------- */
  function cloneFresh(blk){
    const c=clone(blk);
    const fix=o=>{o.items=(o.items||[]).filter(it=>it.kind!=="break");o.items.forEach(it=>{it.id=uid();if(it.kind==="obj"){delete it.pri;(it.tasks||[]).forEach(t=>{t.id=uid();t.done=false})}else it.done=false})};
    fix(c); if(c.halves) c.halves.forEach(fix); return c;
  }
  function fillFrom(src,label){
    let n=0; const dates=weekDates();
    dates.forEach((date,i)=>{
      const s=src[i]; if(!s) return; const d=getDay(me,date); let ch=false;
      for(const [b] of BLOCKS){ if(s[b]&&!isEmptyBlock(norm({blocks:{[b]:clone(s[b])}},date).blocks[b])&&isEmptyBlock(d.blocks[b])){d.blocks[b]=cloneFresh(s[b]);n++;ch=true} }
      if(ch) saveDay(date);
    });
    $("#toolMsg").textContent=n?`Filled ${n} empty block${n>1?"s":""} from ${label}. Blocks you'd already planned were left alone.`:`Nothing to fill. Every block that ${label} has is already planned this week.`;
    renderAll();
  }
  $("#copyLast").onclick=async()=>{ $("#toolMsg").textContent="Copying…"; const src=await fetchWeek(addDays(weekStart,-7)); if(!src.some(Boolean)){$("#toolMsg").textContent="Last week is empty, so there's nothing to copy.";return} fillFrom(src,"last week") };
  $("#fillStd").onclick=()=>{ const t=getMeta(me).template; if(!t||!t.days) return; fillFrom(Array.from({length:7},(_,i)=>t.days[i]||null),"your standard week") };
  $("#saveStd").onclick=()=>{
    const days={}; weekDates().forEach((date,i)=>{days[i]=clone(getDay(me,date).blocks)});
    getMeta(me).template={days}; saveMeta("template"); renderTools();
    $("#toolMsg").textContent="Saved. Use “Fill from my standard week” on any new week to start from this pattern.";
  };
  for(const [id,k] of [["gRest","minRest"],["gFam","minFamily"],["gEve","maxWorkEvenings"]]){
    $("#"+id).addEventListener("change",e=>{
      const v=Math.max(0,Math.min(21,parseInt(e.target.value,10)||0));
      const m=getMeta(me); m.settings=Object.assign({},DEF_GUARD,m.settings||{},{[k]:v}); saveMeta("settings"); renderSummary();
    });
  }

  /* ---------- navigation ---------- */
  function moveWeek(d){weekStart=d;outsideLoaded=new Set();resubscribeAll();watchCal();renderAll()}
  $("#prev").onclick=()=>moveWeek(addDays(weekStart,-7));
  $("#next").onclick=()=>moveWeek(addDays(weekStart,7));
  $("#today").onclick=()=>moveWeek(mondayOf(new Date()));
  function setTab(t){
    tab=t;
    const cur=mondayOf(new Date());
    if(t==="today"&&key(weekStart)!==key(cur)){moveWeek(cur);return}
    renderAll();
  }
  $("#tabToday").onclick=()=>setTab("today");
  $("#tabWeek").onclick=()=>setTab("week");
  $("#tabStaff").onclick=()=>setTab("staff");

  setInterval(()=>{ if(tab!=="staff"&&!typing()&&weekEl.querySelector(".it.brk")) renderDay(todayKey()) },60000);
  renderAll();
  connect();
})();

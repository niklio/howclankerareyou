// Self-contained analytics dashboard served on analytics.howclankerareyou.com.
// No build step, no chart library — vanilla JS draws inline SVG. All data is
// behind the /api/* admin gate; this shell is harmless if loaded unauthed
// (it just shows the sign-in screen).
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>clanker · analytics</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&family=Azeret+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#f2efe6;--ink:#14110f;--dim:#6f6a5f;--mag:#ff1e79;--cyan:#00a6c4;--line:#d8d3c4;--panel:#faf8f2;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"Azeret Mono",ui-monospace,monospace;font-size:14px;
  background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);
  background-size:32px 32px;}
a{color:var(--mag)}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;
  max-width:1100px;margin:0 auto;padding:28px 24px 8px}
h1{font-family:Orbitron,sans-serif;font-weight:900;text-transform:uppercase;font-size:22px;letter-spacing:.02em;margin:0}
.right{display:flex;flex-direction:column;align-items:flex-end;gap:8px}
.range{display:inline-flex;border:1px solid var(--ink)}
.range button{font-family:"Azeret Mono",monospace;font-size:12px;letter-spacing:.04em;text-transform:uppercase;
  background:transparent;color:var(--dim);border:none;border-left:1px solid var(--line);padding:7px 14px;cursor:pointer}
.range button:first-child{border-left:none}
.range button.active{background:var(--mag);color:#fff;font-weight:600}
.who{font-size:12px;color:var(--dim)}
.section .hint{font-family:"Azeret Mono",monospace;text-transform:none;font-size:11px;color:var(--dim)}
main{max-width:1100px;margin:0 auto;padding:12px 24px 60px}
.row{display:grid;gap:14px}
.stats{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:8px}
.grid{grid-template-columns:repeat(auto-fit,minmax(330px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);padding:14px 16px}
.card h3{margin:0 0 8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);font-weight:600}
.stat .big{font-family:Orbitron,sans-serif;font-weight:700;font-size:26px}
.stat .sub{font-size:11px;color:var(--dim)}
svg{display:block;width:100%;height:auto}
.bar{display:flex;align-items:center;gap:8px;margin:5px 0;font-size:12px}
.bar .lab{width:44%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dim)}
.bar .track{flex:1;height:12px;background:#eee7d8;border:1px solid var(--line)}
.bar .fill{height:100%;background:linear-gradient(90deg,var(--cyan),var(--mag))}
.bar .val{width:44px;text-align:right}
.section{font-family:Orbitron,sans-serif;text-transform:uppercase;font-size:13px;color:var(--dim);
  letter-spacing:.08em;margin:26px 0 6px;border-top:1px solid var(--line);padding-top:16px}
.center{min-height:70vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:16px;padding:24px}
.btn{font-family:Orbitron,sans-serif;font-weight:700;text-transform:uppercase;background:var(--mag);color:#fff;
  text-decoration:none;padding:14px 30px;box-shadow:6px 6px 0 var(--ink);letter-spacing:.03em}
.muted{color:var(--dim);font-size:12px}
.budget{height:16px;border:1px solid var(--ink);background:#eee7d8;margin-top:6px}
.budget>div{height:100%;background:var(--mag)}
</style>
</head>
<body>
<div id="app"><div class="center"><p class="muted">loading…</p></div></div>
<script>
const $=(h)=>{const t=document.createElement('template');t.innerHTML=h.trim();return t.content.firstChild;};
async function getJSON(p){const r=await fetch(p,{credentials:'include',cache:'no-store'});
  if(!r.ok){const e=new Error('http '+r.status);e.status=r.status;throw e;}return r.json();}

function login(){
  const next=encodeURIComponent(location.href);
  document.getElementById('app').innerHTML=
    '<div class="center"><h1>clanker · analytics</h1>'+
    '<p class="muted">restricted dashboard</p>'+
    '<a class="btn" href="https://howclankerareyou.com/auth/google?next='+next+'">sign in with google ▶</a></div>';
}

function lineChart(series){
  const W=600,H=170,pad=26,n=series.length;
  const vals=series.map(p=>p[1]),max=Math.max(1,...vals);
  const x=i=>pad+(n<=1?0:i*(W-2*pad)/(n-1)), y=v=>H-pad-(v/max)*(H-2*pad);
  const pts=series.map((p,i)=>x(i).toFixed(1)+','+y(p[1]).toFixed(1)).join(' ');
  const area=pad+','+(H-pad)+' '+pts+' '+x(n-1).toFixed(1)+','+(H-pad);
  const lab=k=>!k?'':(k.includes(' ')?k.slice(11)+':00':k.slice(5));
  const d0=series[0]?lab(series[0][0]):'', d1=series[n-1]?lab(series[n-1][0]):'';
  return '<svg viewBox="0 0 '+W+' '+H+'">'+
    '<defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1">'+
    '<stop offset="0" stop-color="#ff1e79" stop-opacity=".22"/><stop offset="1" stop-color="#ff1e79" stop-opacity="0"/></linearGradient></defs>'+
    '<line x1="'+pad+'" y1="'+(H-pad)+'" x2="'+(W-pad)+'" y2="'+(H-pad)+'" stroke="#d8d3c4"/>'+
    '<polygon points="'+area+'" fill="url(#g)"/>'+
    '<polyline points="'+pts+'" fill="none" stroke="#ff1e79" stroke-width="2"/>'+
    '<text x="'+pad+'" y="14" font-size="10" fill="#6f6a5f">max '+fmt(max)+'</text>'+
    '<text x="'+pad+'" y="'+(H-6)+'" font-size="9" fill="#6f6a5f">'+d0+'</text>'+
    '<text x="'+(W-pad)+'" y="'+(H-6)+'" font-size="9" fill="#6f6a5f" text-anchor="end">'+d1+'</text>'+
    '</svg>';
}
function bars(items,labelKey,valKey,fmtv){
  const max=Math.max(1,...items.map(i=>i[valKey]));
  return items.map(i=>'<div class="bar"><span class="lab" title="'+esc(i[labelKey])+'">'+esc(i[labelKey])+
    '</span><span class="track"><span class="fill" style="width:'+(100*i[valKey]/max)+'%"></span></span>'+
    '<span class="val">'+(fmtv?fmtv(i[valKey]):fmt(i[valKey]))+'</span></div>').join('');
}
const fmt=(n)=>n>=1000?(n/1000).toFixed(1)+'k':(Number.isInteger(n)?n:n.toFixed(2));
const ago=(ms)=>{const s=(Date.now()-ms)/1000;
  return s<90?'just now':s<5400?Math.round(s/60)+'m ago':s<129600?Math.round(s/3600)+'h ago':Math.round(s/86400)+'d ago';};
const esc=(s)=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const sum=(s)=>s.reduce((a,p)=>a+p[1],0);

let EMAIL='';
const RLABEL={day:'· last 24 hours, hourly',week:'· last 7 days, daily',month:'· last 30 days, daily',all:'· all time, daily'};

function render(d){
  const stat=(big,lab,sub)=>'<div class="card stat"><div class="big">'+big+'</div><div class="sub">'+lab+(sub?' · '+sub:'')+'</div></div>';
  const tail=d.range==='day'?' today':'';
  const plot=(p)=>{
    const isLat=p.label.indexOf('latency')>=0;
    // p.total overrides the naive per-bucket sum for non-additive metrics
    // (uniques: DISTINCT can't be summed across buckets). p.note appends
    // extra context (play-through rates) after the aggregate.
    const agg=isLat?('max '+fmt(Math.max(0,...p.series.map(x=>x[1])))+'ms'):(fmt(p.total!=null?p.total:sum(p.series))+tail);
    return '<div class="card"><h3>'+esc(p.label)+' <span style="color:var(--ink)">· '+agg+(p.note?' · '+esc(p.note):'')+'</span></h3>'+lineChart(p.series)+'</div>';
  };
  const section=(name,hint)=>'<div class="section"><span>'+name+' <span class="hint">'+(RLABEL[d.range]||'')+(hint?' '+hint:'')+'</span></span></div>';
  const t=d.topbar,a=d.acquisition,g=d.engagement,h=d.health,dt=d.details;
  const budgetPct=Math.min(100,h.budget.capPct);
  const rangeBtns=['day','week','month','all'].map(r=>'<button data-r="'+r+'"'+(r===d.range?' class="active"':'')+'>'+r+'</button>').join('');
  document.getElementById('app').innerHTML=
    '<header><h1>clanker · analytics</h1><div class="right">'+
      '<div class="range" id="range">'+rangeBtns+'</div>'+
      '<span class="who">'+esc(EMAIL)+' · <a href="https://howclankerareyou.com/auth/logout?next='+encodeURIComponent(location.href)+'">sign out</a></span>'+
    '</div></header>'+
    '<main>'+
    // --- top bar: audience + per-player intensity ---
    '<div class="row stats">'+
      stat(fmt(t.uniqueVisits),'unique visits')+
      stat(fmt(t.dau),'DAU','unique players')+
      stat(fmt(t.playsPerDau),'plays / DAU',fmt(t.plays)+' plays')+
      stat(fmt(t.sharesPerDau),'shares / DAU',fmt(t.shares)+' shares')+
    '</div>'+
    // --- 1. acquisition: who shows up, and from where ---
    section('acquisition')+
    '<div class="row grid">'+a.plots.map(plot).join('')+
      '<div class="card"><h3>Traffic sources</h3>'+(a.referrers.length?bars(a.referrers,'ref','count'):'<p class="muted">no referrer data yet</p>')+'</div>'+
      '<div class="card"><h3>Top share links</h3>'+((a.topShareLinks||[]).length?bars(a.topShareLinks,'link','opens'):'<p class="muted">no share-link opens yet</p>')+'</div>'+
    '</div>'+
    // --- 2. engagement: who actually plays, and via which door ---
    section('engagement')+
    '<div class="row grid">'+g.plots.map(plot).join('')+'</div>'+
    // --- 3. health: is the machine serving them OK ---
    section('health','· diagnose success '+h.diagnoseSuccessRate+'% · self-test completion '+h.selfCompletionRate+'%')+
    '<div class="card"><h3>HF budget — '+h.budget.todayCalls+' / '+h.budget.dailyCap+' calls today ('+h.budget.capPct+'% of daily cap) · '+(h.budget.twitterPagesToday||0)+' twitterapi pages today · $'+h.spend+' spend in range</h3><div class="budget"><div style="width:'+budgetPct+'%"></div></div></div>'+
    '<div class="row grid">'+h.plots.map(plot).join('')+
      '<div class="card"><h3>Diagnose outcomes (all time)</h3>'+((h.outcomes||[]).length?bars(h.outcomes,'outcome','count'):'<p class="muted">no diagnoses yet</p>')+'</div>'+
    '</div>'+
    // --- 4. details: the people and the content ---
    '<div class="section"><span>details <span class="hint">· recently played — fresh, cached, and failed lookups</span></span></div>'+
    '<div class="card">'+((dt.recentEntries||[]).length
      ? bars(dt.recentEntries.map(e=>({
          l:(e.handle.indexOf('u/')===0?'':'@')+e.handle+' · '+ago(e.at)+(e.outcome!=='success'?' · '+e.outcome:(e.cached?' · cached':'')),
          v:e.overall||0})),'l','v',v=>v?v+'%':'—')
      : '<p class="muted">no lookups yet</p>')+'</div>'+
    '<div class="row grid" style="margin-top:14px">'+
      '<div class="card"><h3>Top played accounts (all time)</h3>'+((dt.topHandles||[]).length?bars(dt.topHandles.map(x=>({l:(x.handle.indexOf('u/')===0?'':'@')+x.handle+(x.score!=null?' · '+x.score+'%':''),v:x.lookups})),'l','v'):'<p class="muted">no diagnoses yet</p>')+'</div>'+
      '<div class="card"><h3>Clanker-score distribution (all results)</h3>'+bars(dt.scoreHistogram.map(b=>({l:b.bucket+'%',v:b.count})),'l','v')+'</div>'+
      '<div class="card"><h3>Self-test answers per question (bank of 20)</h3>'+bars(dt.funnel.map(f=>({l:f.prompt.slice(0,28)+'…',v:f.sessions})),'l','v')+'</div>'+
      '<div class="card"><h3>Inner-clanker model (self-test)</h3>'+bars(dt.modelShare,'label','count')+'</div>'+
      '<div class="card"><h3>Most→least clanker question (avg surprisal, nats)</h3>'+bars(dt.questionClanker.map(x=>({l:x.prompt.slice(0,30),v:x.avgKl})),'l','v',v=>v.toFixed(1))+'</div>'+
    '</div>'+
    '<p class="muted" style="margin-top:20px">updated '+new Date(d.updated).toLocaleString()+'</p>'+
    '</main>';
  document.getElementById('range').addEventListener('click',e=>{const b=e.target.closest('button');if(b)load(b.dataset.r);});
}

async function load(range){
  try{ render(await getJSON('/api/analytics?range='+encodeURIComponent(range))); }
  catch(e){ login(); }
}

(async()=>{
  try{
    const me=await getJSON('/api/me');
    if(!me.admin){login();return;}
    EMAIL=me.email;
    load('week');
  }catch(e){ login(); }
})();
</script>
</body>
</html>`;

// Self-contained analytics dashboard served on analytics.howclankerareyou.com.
// Deliberately NOT in the site's neon-paper theme: this is an operator tool,
// tuned for reading on a phone — system fonts, single column, dark-mode
// aware, sticky range switcher with thumb-sized targets. No build step, no
// chart library — vanilla JS draws inline SVG. All data is behind the /api/*
// admin gate; this shell is harmless if loaded unauthed (sign-in screen).
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f6f7f9">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#101318">
<title>clanker analytics</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#16181d;--dim:#69707d;--line:#e3e6ea;
  --accent:#2f6fed;--soft:#e9effc;--shadow:0 1px 2px rgba(16,24,40,.05)}
@media(prefers-color-scheme:dark){:root{--bg:#101318;--card:#1a1f27;--ink:#e8eaee;
  --dim:#8b94a3;--line:#2a313c;--accent:#6b97f2;--soft:#1f2836;--shadow:none}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased;
  /* Reading-only tool: kill long-press selection/callout so touch
     scrubbing on the charts never fights the text-selection loupe. */
  -webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
a{color:var(--accent);text-decoration:none}
header{position:sticky;top:0;z-index:5;background:var(--bg);
  border-bottom:1px solid var(--line);padding:10px 16px 10px}
.hrow{display:flex;justify-content:space-between;align-items:baseline;gap:12px;
  max-width:1080px;margin:0 auto}
h1{font-size:16px;font-weight:650;margin:0;letter-spacing:-.01em}
.who{font-size:12px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.range{display:flex;background:var(--line);border-radius:10px;padding:2px;
  margin:10px auto 0;max-width:1080px}
.range button{flex:1;padding:9px 0;font:inherit;font-size:13px;font-weight:500;
  border:none;border-radius:8px;background:transparent;color:var(--dim);cursor:pointer}
.range button.active{background:var(--card);color:var(--ink);font-weight:600;box-shadow:var(--shadow)}
main{max-width:1080px;margin:0 auto;padding:14px 14px 64px}
.row{display:grid;gap:10px}
.stats{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.grid{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;
  padding:14px 16px;box-shadow:var(--shadow)}
.card h3{margin:0 0 10px;font-size:13px;font-weight:600;color:var(--dim);line-height:1.35}
.card h3 b{color:var(--ink);font-weight:650;font-variant-numeric:tabular-nums}
.stat .big{font-size:27px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.stat .sub{font-size:12px;color:var(--dim);margin-top:2px}
.section{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;
  color:var(--dim);margin:26px 4px 10px}
.section .hint{font-weight:400;text-transform:none;letter-spacing:0}
svg.chart{display:block;width:100%;height:auto;touch-action:pan-y}
.chart .axis{stroke:var(--line)}
.chart .area{fill:var(--accent);opacity:.08}
.chart .line{fill:none;stroke:var(--accent);stroke-width:2}
.chart .dot{fill:var(--accent)}
.chart .hline{stroke:var(--dim);stroke-dasharray:3 3}
.chart .hdot{fill:var(--accent);stroke:var(--card);stroke-width:1.5}
.chart text{fill:var(--dim);font-size:10px}
.bar{display:flex;align-items:center;gap:10px;margin:7px 0;font-size:13px;min-height:20px}
.bar .lab{width:47%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar .track{flex:1;height:8px;border-radius:4px;background:var(--soft);overflow:hidden}
.bar .fill{display:block;height:100%;border-radius:4px;background:var(--accent)}
.bar .val{min-width:44px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
.budget{height:10px;border-radius:5px;background:var(--soft);overflow:hidden;margin-top:8px}
.budget>div{height:100%;background:var(--accent)}
.center{min-height:80vh;display:flex;flex-direction:column;align-items:center;
  justify-content:center;text-align:center;gap:14px;padding:24px}
.btn{background:var(--accent);color:#fff;padding:13px 30px;border-radius:12px;font-weight:600}
.muted{color:var(--dim);font-size:12px}
</style>
</head>
<body>
<div id="app"><div class="center"><p class="muted">loading…</p></div></div>
<script>
async function getJSON(p){const r=await fetch(p,{credentials:'include',cache:'no-store'});
  if(!r.ok){const e=new Error('http '+r.status);e.status=r.status;throw e;}return r.json();}

function login(){
  const next=encodeURIComponent(location.href);
  document.getElementById('app').innerHTML=
    '<div class="center"><h1>clanker analytics</h1>'+
    '<p class="muted">restricted dashboard</p>'+
    '<a class="btn" href="https://howclankerareyou.com/auth/google?next='+next+'">Sign in with Google</a></div>';
}

// Chart geometry, shared with the hover-scrub wiring in wireCharts().
const CW=360,CH=130,CP=22;
const chartX=(i,n)=>CP+(n<=1?0:i*(CW-2*CP)/(n-1));
const chartY=(v,max)=>CH-CP-(v/max)*(CH-2*CP-10);
const bucketLab=(k)=>!k?'':(k.includes(' ')?k.slice(11)+':00':k.slice(5));
function lineChart(series){
  const n=series.length;
  const vals=series.map(p=>p[1]),max=Math.max(1,...vals);
  const pts=series.map((p,i)=>chartX(i,n).toFixed(1)+','+chartY(p[1],max).toFixed(1)).join(' ');
  const area=CP+','+(CH-CP)+' '+pts+' '+chartX(n-1,n).toFixed(1)+','+(CH-CP);
  const d0=series[0]?bucketLab(series[0][0]):'', d1=series[n-1]?bucketLab(series[n-1][0]):'';
  const lx=chartX(n-1,n).toFixed(1), ly=series[n-1]?chartY(series[n-1][1],max).toFixed(1):0;
  return '<svg viewBox="0 0 '+CW+' '+CH+'" class="chart">'+
    '<line class="axis" x1="'+CP+'" y1="'+(CH-CP)+'" x2="'+(CW-CP)+'" y2="'+(CH-CP)+'"/>'+
    '<polygon class="area" points="'+area+'"/>'+
    '<polyline class="line" points="'+pts+'"/>'+
    (n?'<circle class="dot" cx="'+lx+'" cy="'+ly+'" r="3"/>':'')+
    '<line class="hline" y1="10" y2="'+(CH-CP)+'" style="display:none"/>'+
    '<circle class="hdot" r="4" style="display:none"/>'+
    '<text x="'+CP+'" y="'+(CH-6)+'">'+d0+'</text>'+
    '<text x="'+(CW-CP)+'" y="'+(CH-6)+'" text-anchor="end">'+d1+'</text>'+
    '</svg>';
}
// Scrubbing: pointer over a chart swaps the header number for the hovered
// bucket's value (with a guide line + dot); leaving restores the aggregate.
// touch-action:pan-y keeps vertical page scroll free while a horizontal
// finger drag scrubs.
function wireCharts(){
  document.querySelectorAll('.card.plot').forEach(card=>{
    const svg=card.querySelector('svg.chart');
    const b=card.querySelector('h3 .v');
    if(!svg||!b) return;
    let series=[]; try{series=JSON.parse(card.dataset.s||'[]');}catch(e){}
    const n=series.length; if(!n) return;
    const agg=card.dataset.agg, unit=card.dataset.u||'';
    const max=Math.max(1,...series.map(p=>p[1]));
    const gl=svg.querySelector('.hline'), gd=svg.querySelector('.hdot');
    const show=(clientX)=>{
      const r=svg.getBoundingClientRect();
      const vx=(clientX-r.left)/r.width*CW;
      let i=Math.round((vx-CP)/((CW-2*CP)/(n<=1?1:n-1)));
      i=Math.max(0,Math.min(n-1,i));
      const x=chartX(i,n);
      gl.setAttribute('x1',x); gl.setAttribute('x2',x); gl.style.display='';
      gd.setAttribute('cx',x); gd.setAttribute('cy',chartY(series[i][1],max)); gd.style.display='';
      b.textContent=bucketLab(series[i][0])+' · '+fmt(series[i][1])+unit;
    };
    const hide=()=>{gl.style.display='none';gd.style.display='none';b.textContent=agg;};
    svg.addEventListener('pointermove',e=>show(e.clientX));
    svg.addEventListener('pointerdown',e=>show(e.clientX));
    svg.addEventListener('pointerleave',hide);
    svg.addEventListener('pointercancel',hide);
  });
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
let RANGE='week';
try{RANGE=localStorage.getItem('hcay_range')||'week';}catch(e){}
let lastLoad=0;
const RLABEL={day:'· last 24 hours, hourly',week:'· last 7 days, daily',month:'· last 30 days, daily',all:'· all time, daily'};

function render(d){
  const stat=(big,lab,sub)=>'<div class="card stat"><div class="big">'+big+'</div><div class="sub">'+lab+(sub?' · '+sub:'')+'</div></div>';
  const tail=d.range==='day'?' today':'';
  const plot=(p)=>{
    const isLat=p.label.indexOf('latency')>=0;
    // p.total overrides the naive per-bucket sum for non-additive metrics
    // (uniques: DISTINCT can't be summed across buckets). p.note appends
    // extra context (play-through rates) after the aggregate. data-s/agg/u
    // feed the hover scrubbing in wireCharts().
    const agg=isLat?('max '+fmt(Math.max(0,...p.series.map(x=>x[1])))+' ms'):(fmt(p.total!=null?p.total:sum(p.series))+tail);
    return '<div class="card plot" data-s="'+esc(JSON.stringify(p.series))+'" data-agg="'+esc(agg)+'"'+(isLat?' data-u=" ms"':'')+'>'+
      '<h3>'+esc(p.label)+' · <b class="v">'+agg+'</b>'+(p.note?' · '+esc(p.note):'')+'</h3>'+lineChart(p.series)+'</div>';
  };
  const section=(name,hint)=>'<div class="section">'+name+' <span class="hint">'+(RLABEL[d.range]||'')+(hint?' '+hint:'')+'</span></div>';
  const t=d.topbar,a=d.acquisition,g=d.engagement,h=d.health,dt=d.details;
  const budgetPct=Math.min(100,h.budget.capPct);
  const rangeBtns=['day','week','month','all'].map(r=>'<button data-r="'+r+'"'+(r===d.range?' class="active"':'')+'>'+r+'</button>').join('');
  document.getElementById('app').innerHTML=
    '<header><div class="hrow"><h1>clanker analytics</h1>'+
      '<span class="who"><a href="https://howclankerareyou.com/auth/logout?next='+encodeURIComponent(location.href)+'">sign out</a></span></div>'+
      '<div class="range" id="range">'+rangeBtns+'</div>'+
    '</header>'+
    '<main>'+
    // --- top bar: audience + per-player intensity ---
    '<div class="row stats" style="margin-top:2px">'+
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
    '<div class="card"><h3>HF budget · <b>'+h.budget.todayCalls+' / '+h.budget.dailyCap+'</b> calls today ('+h.budget.capPct+'%) · '+(h.budget.twitterPagesToday||0)+' twitterapi pages · $'+h.spend+' spend in range</h3><div class="budget"><div style="width:'+budgetPct+'%"></div></div></div>'+
    '<div class="row grid" style="margin-top:10px">'+h.plots.map(plot).join('')+
      '<div class="card"><h3>Diagnose outcomes (all time)</h3>'+((h.outcomes||[]).length?bars(h.outcomes,'outcome','count'):'<p class="muted">no diagnoses yet</p>')+'</div>'+
    '</div>'+
    // --- 4. details: the people and the content ---
    section('details','· recently played — fresh, cached, and failed lookups')+
    '<div class="card">'+((dt.recentEntries||[]).length
      ? bars(dt.recentEntries.map(e=>({
          l:(e.handle.indexOf('u/')===0?'':'@')+e.handle+' · '+ago(e.at)+(e.outcome!=='success'?' · '+e.outcome:(e.cached?' · cached':'')),
          v:e.overall||0})),'l','v',v=>v?v+'%':'—')
      : '<p class="muted">no lookups yet</p>')+'</div>'+
    '<div class="row grid" style="margin-top:10px">'+
      '<div class="card"><h3>Top played accounts (all time)</h3>'+((dt.topHandles||[]).length?bars(dt.topHandles.map(x=>({l:(x.handle.indexOf('u/')===0?'':'@')+x.handle+(x.score!=null?' · '+x.score+'%':''),v:x.lookups})),'l','v'):'<p class="muted">no diagnoses yet</p>')+'</div>'+
      '<div class="card"><h3>Clanker-score distribution (all results)</h3>'+bars(dt.scoreHistogram.map(b=>({l:b.bucket+'%',v:b.count})),'l','v')+'</div>'+
      '<div class="card"><h3>Self-test answers per question (bank of 20)</h3>'+bars(dt.funnel.map(f=>({l:f.prompt.slice(0,28)+'…',v:f.sessions})),'l','v')+'</div>'+
      '<div class="card"><h3>Inner-clanker model (self-test)</h3>'+bars(dt.modelShare,'label','count')+'</div>'+
      '<div class="card"><h3>Most→least clanker question (avg surprisal, nats)</h3>'+bars(dt.questionClanker.map(x=>({l:x.prompt.slice(0,30),v:x.avgKl})),'l','v',v=>v.toFixed(1))+'</div>'+
    '</div>'+
    '<p class="muted" style="margin-top:20px">updated '+new Date(d.updated).toLocaleString()+' · '+esc(EMAIL)+'</p>'+
    '</main>';
  document.getElementById('range').addEventListener('click',e=>{const b=e.target.closest('button');if(b)load(b.dataset.r);});
  wireCharts();
}

async function load(range){
  RANGE=range;
  try{localStorage.setItem('hcay_range',range);}catch(e){}
  try{ render(await getJSON('/api/analytics?range='+encodeURIComponent(range))); lastLoad=Date.now(); }
  catch(e){ login(); }
}

// Coming back to the tab on a phone usually means "what's it look like now" —
// refetch quietly if the data is more than a couple minutes stale.
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden&&EMAIL&&Date.now()-lastLoad>120000) load(RANGE);
});

(async()=>{
  try{
    const me=await getJSON('/api/me');
    if(!me.admin){login();return;}
    EMAIL=me.email;
    load(RANGE);
  }catch(e){ login(); }
})();
</script>
</body>
</html>`;

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
header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;
  max-width:1100px;margin:0 auto;padding:28px 24px 8px}
h1{font-family:Orbitron,sans-serif;font-weight:900;text-transform:uppercase;font-size:22px;letter-spacing:.02em;margin:0}
.who{font-size:12px;color:var(--dim)}
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
  const d0=series[0]?series[0][0].slice(5):'', d1=series[n-1]?series[n-1][0].slice(5):'';
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
const esc=(s)=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const sum=(s)=>s.reduce((a,p)=>a+p[1],0);

function render(d,email){
  const stat=(big,lab,sub)=>'<div class="card stat"><div class="big">'+big+'</div><div class="sub">'+lab+(sub?' · '+sub:'')+'</div></div>';
  const h=d.headline;
  const plotCards=d.plots.map(p=>'<div class="card"><h3>'+esc(p.label)+' <span style="color:var(--ink)">· '+fmt(sum(p.series))+' total</span></h3>'+lineChart(p.series)+'</div>').join('');
  const budgetPct=Math.min(100,d.budget.capPct);
  document.getElementById('app').innerHTML=
    '<header><h1>clanker · analytics</h1><span class="who">'+esc(email)+' · <a href="https://howclankerareyou.com/auth/logout?next='+encodeURIComponent(location.href)+'">sign out</a></span></header>'+
    '<main>'+
    '<div class="row stats">'+
      stat(h.completedRuns,'runs completed')+
      stat(h.completionRate+'%','completion rate','started→finished')+
      stat(h.shareRate+'%','share rate','of completed')+
      stat(h.kFactor,'k-factor','opens per share')+
      stat('$'+h.mtdSpend,'spend (MTD)')+
    '</div>'+
    '<div class="card"><h3>HF budget — '+d.budget.todayCalls+' / '+d.budget.dailyCap+' calls today ('+d.budget.capPct+'% of daily cap) · $'+d.budget.mtdSpend+' month-to-date</h3><div class="budget"><div style="width:'+budgetPct+'%"></div></div></div>'+
    '<div class="section">trends</div><div class="row grid">'+plotCards+'</div>'+
    '<div class="section">breakdowns</div><div class="row grid">'+
      '<div class="card"><h3>Funnel — sessions reaching each question</h3>'+bars(d.funnel.map(f=>({l:'Q'+f.step+' '+f.prompt.slice(0,22)+'…',v:f.sessions})),'l','v')+'</div>'+
      '<div class="card"><h3>Clanker-score distribution</h3>'+bars(d.scoreHistogram.map(b=>({l:b.bucket+'%',v:b.count})),'l','v')+'</div>'+
      '<div class="card"><h3>Inner-clanker model (nearest)</h3>'+bars(d.modelShare,'label','count')+'</div>'+
      '<div class="card"><h3>Traffic sources</h3>'+(d.referrers.length?bars(d.referrers,'ref','count'):'<p class="muted">no referrer data yet</p>')+'</div>'+
      '<div class="card"><h3>Most→least clanker question (avg surprisal, nats)</h3>'+bars(d.questionClanker.map(q=>({l:q.prompt.slice(0,30),v:q.avgKl})),'l','v',v=>v.toFixed(1))+'</div>'+
    '</div>'+
    '<p class="muted" style="margin-top:20px">updated '+new Date(d.updated).toLocaleString()+'</p>'+
    '</main>';
}

(async()=>{
  try{
    const me=await getJSON('/api/me');
    if(!me.admin){login();return;}
    const data=await getJSON('/api/analytics');
    render(data,me.email);
  }catch(e){ login(); }
})();
</script>
</body>
</html>`;

#!/usr/bin/env node
// Builds uat/review.html from uat/catalog.json: one card per UAT case with the original
// TestLink steps next to the proposed ones, and a decision per case (accept / reject /
// edit note). Decisions stay in the browser until exported to uat/decisions.json, which
// scripts/apply-decisions.mjs folds back into the catalog.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "uat", "catalog.json"), "utf8"));

// Embedded as JSON; "</" is escaped so case text cannot close the script element.
const data = JSON.stringify(catalog.cases).replace(/<\//g, "<\\/");

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>UAT Suite Review</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--card:#fff;--line:#e7e5e4;--keep:#15803d;--upd:#1d4ed8;--dup:#78716c;--ni:#a16207;--obs:#b91c1c;--acc:#0f766e}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--card:#292524;--line:#44403c;--keep:#4ade80;--upd:#93c5fd;--dup:#a8a29e;--ni:#facc15;--obs:#f87171;--acc:#5eead4}}
:root[data-theme="dark"]{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--card:#292524;--line:#44403c;--keep:#4ade80;--upd:#93c5fd;--dup:#a8a29e;--ni:#facc15;--obs:#f87171;--acc:#5eead4}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
header{position:sticky;top:0;z-index:1;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 16px}
main{max-width:1200px;margin:auto;padding:12px 16px}h1{margin:0;font-size:20px}.muted{color:var(--muted)}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px}
select,input,button,textarea{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:4px 8px}
button{cursor:pointer}button.primary{border-color:var(--acc);color:var(--acc)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:10px 0;padding:10px 12px}
.card h3{margin:0;font-size:15px}.meta{font-size:12px;color:var(--muted);margin:2px 0 6px}
.v{display:inline-block;border:1px solid currentColor;border-radius:4px;padding:0 6px;font-size:12px;margin-right:6px}
.v.KEEP{color:var(--keep)}.v.UPDATE{color:var(--upd)}.v.DUPLICATE{color:var(--dup)}.v.NOT_INSTALLED{color:var(--ni)}.v.OBSOLETE{color:var(--obs)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media (max-width:760px){.cols{grid-template-columns:1fr}}
ol{margin:4px 0;padding-left:20px}li{margin:2px 0}li .exp{color:var(--muted)}li .exp::before{content:"→ "}
.hint{font-size:12px;color:var(--muted);margin-top:6px;overflow-wrap:anywhere}.hint b{color:var(--fg);font-weight:600}
.decide{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;margin-top:8px;border-top:1px solid var(--line);padding-top:8px}
.decide textarea{flex:1;min-width:200px;min-height:30px}.decided{border-left:4px solid var(--acc)}
</style></head><body>
<header><h1>UAT Suite Review</h1>
<div class="muted" id="summary"></div>
<div class="bar">
<input id="q" placeholder="Search id, name, reason…" size="28">
<select id="fv"><option value="">All verdicts</option><option>KEEP</option><option>UPDATE</option><option>DUPLICATE</option><option>NOT_INSTALLED</option><option>OBSOLETE</option></select>
<select id="fa"><option value="">All areas</option></select>
<select id="fd"><option value="">Any decision</option><option value="none">Undecided</option><option value="accept">Accepted</option><option value="reject">Rejected</option><option value="change">Needs change</option></select>
<button id="acceptVisible">Accept all visible</button>
<button class="primary" id="export">Export decisions.json</button>
<label class="muted"><input type="file" id="import" accept=".json" hidden><span style="text-decoration:underline;cursor:pointer" onclick="document.getElementById('import').click()">Import decisions</span></label>
</div></header>
<main id="list"></main>
<script>
const CASES=${data};
const KEY="uat-review-decisions";
let decisions={};try{decisions=JSON.parse(localStorage.getItem(KEY)||"{}")}catch(e){}
const save=()=>{try{localStorage.setItem(KEY,JSON.stringify(decisions))}catch(e){}summary()};
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const steps=a=>a&&a.length?"<ol>"+a.map(s=>"<li>"+esc(s.action)+(s.expected?'<div class="exp">'+esc(s.expected)+"</div>":"")+"</li>").join("")+"</ol>":'<div class="muted">—</div>';
const areas=[...new Set(CASES.map(c=>c.area))];document.getElementById("fa").innerHTML+=areas.map(a=>"<option>"+esc(a)+"</option>").join("");
function summary(){const n=v=>CASES.filter(c=>c.verdict===v).length;const d=Object.values(decisions).filter(x=>x.decision).length;
document.getElementById("summary").textContent=CASES.length+" cases · "+n("KEEP")+" keep · "+n("UPDATE")+" update · "+n("DUPLICATE")+" duplicate · "+n("NOT_INSTALLED")+" not installed · "+n("OBSOLETE")+" obsolete — "+d+" decided";}
function card(c){const d=decisions[c.id]||{};const hint=[["Reason",c.reason],["Route",c.route],["Menu",c.menu],["Automation",c.feasibility],["Prerequisites",c.prerequisites],["Re-run",c.rerun_strategy],["Selectors",c.selectors]].filter(x=>x[1]).map(x=>"<div><b>"+x[0]+":</b> "+esc(x[1])+"</div>").join("");
return '<div class="card'+(d.decision?" decided":"")+'" data-id="'+esc(c.id)+'"><h3><span class="v '+esc(c.verdict)+'">'+esc(c.verdict)+"</span>OCM-"+esc(c.id)+" · "+esc(c.name)+"</h3>"
+'<div class="meta">'+esc(c.suite)+(c.duplicate_of?" · duplicate of OCM-"+esc(c.duplicate_of):"")+"</div>"
+'<div class="cols"><div><b>Original</b>'+steps(c.original_steps)+"</div><div><b>Proposed</b>"+(c.proposed_steps.length?steps(c.proposed_steps):'<div class="muted">'+(c.verdict==="KEEP"?"unchanged":"none (case leaves the suite)")+"</div>")+"</div></div>"
+'<div class="hint">'+hint+"</div>"
+'<div class="decide"><select data-k="decision"><option value="">— decision —</option><option value="accept"'+(d.decision==="accept"?" selected":"")+'>Accept proposal</option><option value="reject"'+(d.decision==="reject"?" selected":"")+'>Reject (keep original)</option><option value="change"'+(d.decision==="change"?" selected":"")+'>Needs change</option></select>'
+'<textarea data-k="note" placeholder="Note / requested change">'+esc(d.note||"")+"</textarea></div></div>";}
function visible(){const q=document.getElementById("q").value.toLowerCase(),fv=document.getElementById("fv").value,fa=document.getElementById("fa").value,fd=document.getElementById("fd").value;
return CASES.filter(c=>(!fv||c.verdict===fv)&&(!fa||c.area===fa)&&(!fd||(fd==="none"?!(decisions[c.id]||{}).decision:(decisions[c.id]||{}).decision===fd))&&(!q||(c.id+" "+c.name+" "+c.suite+" "+(c.reason||"")).toLowerCase().includes(q)));}
function render(){document.getElementById("list").innerHTML=visible().map(card).join("")||'<p class="muted">No case matches.</p>';summary();}
document.getElementById("list").addEventListener("change",e=>{const k=e.target.dataset.k;if(!k)return;const el=e.target.closest(".card");const id=el.dataset.id;decisions[id]={...(decisions[id]||{}),[k]:e.target.value};el.classList.toggle("decided",!!decisions[id].decision);save();});
["q","fv","fa","fd"].forEach(i=>document.getElementById(i).addEventListener("input",render));
document.getElementById("acceptVisible").onclick=()=>{const v=visible();if(!confirm("Accept the proposal for "+v.length+" visible case(s)?"))return;v.forEach(c=>{decisions[c.id]={...(decisions[c.id]||{}),decision:"accept"}});save();render();};
document.getElementById("export").onclick=()=>{const blob=new Blob([JSON.stringify({exportedAt:new Date().toISOString(),decisions},null,1)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="decisions.json";a.click();};
document.getElementById("import").onchange=async e=>{const f=e.target.files[0];if(!f)return;try{decisions={...decisions,...JSON.parse(await f.text()).decisions};save();render();}catch(err){alert("Not a decisions.json file: "+err.message)}};
render();
</script></body></html>`;

const out = path.join(ROOT, "uat", "review.html");
fs.writeFileSync(out, html);
console.log(`Wrote ${out} (${catalog.cases.length} cases)`);

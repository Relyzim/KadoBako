"use strict";
const $ = (id)=>document.getElementById(id);

/* ---------- Devise & format ---------- */
const currency="EUR";                                   // l'app fonctionne uniquement en euros
const EURF=new Intl.NumberFormat("fr-FR",{style:"currency",currency:"EUR"});
const fmt=(n)=>EURF.format(Math.round((n||0)*100)/100 || 0);   // « 85,00 € » ; évite « -0,00 € »
const fmtEUR=fmt;
const round2=(n)=>Math.round(n*100)/100;
const pct=(n)=>(n>=0?"+":"")+ (n||0).toLocaleString("fr-FR",{minimumFractionDigits:1,maximumFractionDigits:1})+" %";
const fmtAnnu=(n)=>n>999?"> 999 %":pct(n);
// Date du jour en heure locale (l'UTC décalait les achats faits entre minuit et 2 h)
const localISO=(d=new Date())=>new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);
const todayStr=()=>localISO();
const daysBetween=(a,b)=>Math.max(0,Math.round((new Date(b)-new Date(a))/86400000));

/* ---------- Persistance : IndexedDB (photos à part) + repli localStorage ---------- */
const LS_KEY="flipdex_v1", JOURNAL_KEY="flipdex_journal";
const Store=(()=>{
  let db=null, mode="memory", migrated=false, recovered=false;
  const photoSig=new Map();                       // id -> signature de la photo déjà écrite
  const sig=(s)=>s ? s.length+":"+s.slice(-24) : "";
  const reqP=(r)=>new Promise((res,rej)=>{ r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
  const txDone=(t)=>new Promise((res,rej)=>{ t.oncomplete=()=>res(); t.onerror=()=>rej(t.error); t.onabort=()=>rej(t.error||new Error("Transaction annulée")); });
  function openDB(){ return new Promise((res,rej)=>{
    if(!("indexedDB" in window)) return rej(new Error("IndexedDB indisponible"));
    let rq; try{ rq=indexedDB.open("flipdex",1); }catch(e){ return rej(e); }
    rq.onupgradeneeded=()=>{ const d=rq.result;
      if(!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
      if(!d.objectStoreNames.contains("photos")) d.createObjectStore("photos"); };
    rq.onsuccess=()=>res(rq.result); rq.onerror=()=>rej(rq.error); rq.onblocked=()=>rej(new Error("Base bloquée"));
  });}
  async function readIDB(){
    const t=db.transaction(["kv","photos"],"readonly"), ps=t.objectStore("photos");
    const [st,keys,vals]=await Promise.all([reqP(t.objectStore("kv").get("state")),reqP(ps.getAllKeys()),reqP(ps.getAll())]);
    return { st, photos:new Map(keys.map((k,i)=>[k,vals[i]])) };
  }
  async function writeIDB(s){
    const strip=(it)=>{ const {userPhoto, ...rest}=it; return rest; };
    const all=[...s.items, ...(s.trash||[]).map(t=>t.item)];
    const clean={...s, items:s.items.map(strip), trash:(s.trash||[]).map(t=>({...t, item:strip(t.item)}))};
    const t=db.transaction(["kv","photos"],"readwrite"), ps=t.objectStore("photos");
    t.objectStore("kv").put(clean,"state");
    const next=new Map();
    for(const it of all){ if(!it.userPhoto) continue; const g=sig(it.userPhoto); next.set(it.id,g); if(photoSig.get(it.id)!==g) ps.put(it.userPhoto,it.id); }
    for(const id of photoSig.keys()) if(!next.has(id)) ps.delete(id);
    await txDone(t);
    photoSig.clear(); next.forEach((g,id)=>photoSig.set(id,g));   // mis à jour seulement si l'écriture a réussi
  }
  function lsRead(){ try{ const raw=localStorage.getItem(LS_KEY); return raw?JSON.parse(raw):null; }catch(e){ return null; } }
  function lsUsable(){ try{ const k="__flipdex_test"; localStorage.setItem(k,"1"); localStorage.removeItem(k); return true; }catch(e){ return false; } }
  async function load(){
    try{ db=await openDB(); mode="idb"; }catch(e){ db=null; }
    if(mode==="idb"){
      try{
        let {st,photos}=await readIDB();
        photos.forEach((v,k)=>photoSig.set(k,sig(v)));          // orphelines incluses : nettoyées à la prochaine sauvegarde
        // Journal de secours posé à la fermeture : plus récent que la base -> on le reprend
        try{ const jr=JSON.parse(localStorage.getItem(JOURNAL_KEY)||"null");
          if(jr && Array.isArray(jr.items) && (!st || (jr.savedAt||0) > (st.savedAt||0))){ st=jr; recovered=true; } }catch(e){}
        if(!st){                                                 // 1er lancement : migration depuis localStorage
          const legacy=lsRead();
          if(legacy && Array.isArray(legacy.items)){
            await writeIDB(legacy);
            const chk=await readIDB();
            if(chk.st && chk.st.items.length===legacy.items.length && chk.photos.size===legacy.items.filter(i=>i.userPhoto).length){
              try{ localStorage.removeItem(LS_KEY); }catch(e){}
              migrated=true; st=chk.st; photos=chk.photos;
            } else { throw new Error("Migration non vérifiée"); }
          }
        }
        if(st && Array.isArray(st.items)){
          st.items.forEach(it=>{ it.userPhoto = photos.get(it.id) || null; });
          (st.trash||[]).forEach(t=>{ if(t&&t.item) t.item.userPhoto = photos.get(t.item.id) || null; });
        }
        return st||null;
      }catch(e){ console.error("IndexedDB inutilisable, repli localStorage :", e); db=null; mode="memory"; }
    }
    if(lsUsable()){ mode="ls"; return lsRead(); }
    mode="memory"; return null;
  }
  async function save(s){
    if(mode==="idb") return writeIDB(s);
    if(mode==="ls") localStorage.setItem(LS_KEY, JSON.stringify(s));   // lève QuotaExceededError si plein
  }
  return { load, save, get mode(){ return mode; }, get migrated(){ return migrated; }, get recovered(){ return recovered; } };
})();
const DEFAULT_SETTINGS={ baseCurrency:"EUR", usdToEur:0.92, targetCoef:1.5, undercutPct:5, monthlyGoal:0, view:"list",
  fees:{ Vinted:{pct:0,flat:0}, eBay:{pct:11,flat:0}, Cardmarket:{pct:5,flat:0} } };
const TRASH_DAYS=30;
function normalizeState(s){
  const out = (s && Array.isArray(s.items)) ? s : { settings:{}, items:[] };
  out.schemaVersion="1.2";
  out.settings=Object.assign({...DEFAULT_SETTINGS}, out.settings||{});
  out.settings.fees=Object.assign({...DEFAULT_SETTINGS.fees}, out.settings.fees||{});
  out.settings.baseCurrency="EUR";
  out.trash=(Array.isArray(out.trash)?out.trash:[]).filter(t=>t && t.item && (Date.now()-new Date(t.deletedAt).getTime()) < TRASH_DAYS*86400000);
  out.wishlist=Array.isArray(out.wishlist)?out.wishlist:[];
  out.session=Object.assign({active:false,label:"",count:0,spent:0}, out.session||{});
  const eur=(o)=>{ if(o && o.currency && o.currency!=="EUR") o.currency="EUR"; };   // l'app passe en euro seul
  const fix=(it)=>{ eur(it.acquisition); eur(it.listing); eur(it.sale); if(!Array.isArray(it.tags)) it.tags=[]; };
  out.items.forEach(fix); out.trash.forEach(t=>fix(t.item));
  return out;
}
let state=normalizeState(null);
let saveQueued=false, saveChain=Promise.resolve(), saveFailed=false, storeReady=false;
// Écriture lancée dès la fin de l'action en cours (plusieurs changements d'une même action = une seule écriture)
function persist(){ state.settings.baseCurrency=currency; state.savedAt=Date.now();
  if(!saveQueued){ saveQueued=true; queueMicrotask(()=>{ saveQueued=false; flushSave(); }); } }
let saving=false, saveAgain=false;
function flushSave(){
  if(!storeReady) return saveChain;              // jamais d'écriture avant la fin du chargement
  if(saving){ saveAgain=true; return saveChain; } // une écriture est en cours : on en relancera une juste après
  saving=true;
  let p; try{ p=Promise.resolve(Store.save(state)); }catch(e){ p=Promise.reject(e); }   // appel direct : démarre avant la fermeture de la page
  saveChain = p.then(()=>{ if(saveFailed){ saveFailed=false; updateStoreNote(); } if(!saveAgain) clearJournal(); }, err=>{
    console.error("Échec de sauvegarde :", err); saveFailed=true;
    toast(err && err.name==="QuotaExceededError" ? "Stockage plein : sauvegarde impossible. Exporte en JSON." : "Sauvegarde impossible. Exporte en JSON.");
    updateStoreNote();
  }).then(()=>{ saving=false; if(saveAgain){ saveAgain=false; return flushSave(); } });
  return saveChain;
}
// Fermeture pendant une écriture : copie de secours synchrone (sans les photos, déjà stockées à part)
function writeJournal(){
  if(!storeReady || Store.mode!=="idb" || !(saving||saveQueued)) return;
  try{ const strip=(it)=>{ const {userPhoto, ...rest}=it; return rest; };
    localStorage.setItem(JOURNAL_KEY, JSON.stringify({...state, items:state.items.map(strip), trash:(state.trash||[]).map(t=>({...t,item:strip(t.item)}))})); }catch(e){}
}
function clearJournal(){ try{ localStorage.removeItem(JOURNAL_KEY); }catch(e){} }
document.addEventListener("visibilitychange",()=>{ if(document.visibilityState==="hidden") writeJournal(); });
window.addEventListener("pagehide",writeJournal);
async function updateStoreNote(){
  const el=$("storeNote"); if(!el) return;
  if(saveFailed){ el.textContent="⚠ Dernière sauvegarde échouée — exporte en JSON"; return; }
  const label={ idb:"✓ Sauvegarde locale active", ls:"✓ Sauvegarde locale (mode limité, ~5 Mo)", memory:"⚠ Aucune sauvegarde possible ici — exporte en JSON" }[Store.mode];
  let extra="";
  try{ if(Store.mode!=="memory" && navigator.storage && navigator.storage.estimate){
    const e=await navigator.storage.estimate();
    if(typeof e.usage==="number") extra=" · "+(e.usage<1048576
      ? Math.max(1,Math.round(e.usage/1024)).toLocaleString("fr-FR")+" Ko"
      : (e.usage/1048576).toLocaleString("fr-FR",{maximumFractionDigits:1})+" Mo")+" utilisés"; } }catch(_){}
  el.textContent=label+extra;
}

/* ---------- Carte holo générée (fallback visuel garanti) ---------- */
function esc(s){return String(s??"").replace(/[<&>"']/g,c=>({"<":"&lt;","&":"&amp;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function wrapTxt(s,max){const w=String(s||"").split(" ");const out=[];let ln="";
  for(const x of w){if((ln+" "+x).trim().length>max){out.push(ln.trim());ln=x;}else ln+=" "+x;}
  if(ln.trim())out.push(ln.trim());return out.slice(0,3);}
function cardSVG(name,number,setName){
  const tspans=wrapTxt(name,15).map((l,i)=>`<tspan x="105" dy="${i===0?0:26}">${esc(l)}</tspan>`).join("");
  return `data:image/svg+xml;utf8,`+encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 210 293" font-family="sans-serif">
    <defs><linearGradient id="h" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7FCBFF"/><stop offset="0.5" stop-color="#A98BFF"/><stop offset="1" stop-color="#FF6FAE"/></linearGradient></defs>
    <rect width="210" height="293" rx="12" fill="#FCE8F1"/>
    <rect x="4" y="4" width="202" height="285" rx="9" fill="none" stroke="url(#h)" stroke-width="2" opacity="0.85"/>
    <rect x="16" y="20" width="178" height="150" rx="6" fill="#FFFFFF"/>
    <text x="105" y="100" text-anchor="middle" font-size="46" fill="url(#h)" font-weight="700" opacity="0.85">◆</text>
    <text x="105" y="205" text-anchor="middle" font-size="17" fill="#3B2440" font-weight="600">${tspans}</text>
    <text x="105" y="262" text-anchor="middle" font-size="12" fill="#8E7391" font-family="monospace">n°${esc(number)}</text>
    <text x="105" y="279" text-anchor="middle" font-size="10" fill="#B08AB5">${esc(setName)}</text>
  </svg>`).replace(/'/g,"%27");
}
function mountImg(imgEl,realSrc,genSrc){
  if(!imgEl)return;
  imgEl.addEventListener("error",function o(){imgEl.removeEventListener("error",o);imgEl.src=genSrc;});
  imgEl.src=realSrc||genSrc;
}

/* ---------- Produits scellés : taxonomie complète + visuels ---------- */
const PRODUCTS=[
  {v:"booster",l:"Booster (sachet)",cat:"Boosters & blisters",icon:"pack"},
  {v:"sleeved",l:"Booster sleeved",cat:"Boosters & blisters",icon:"pack"},
  {v:"blister1",l:"Blister 1 booster",cat:"Boosters & blisters",icon:"blister"},
  {v:"blister3",l:"Blister 3 boosters",cat:"Boosters & blisters",icon:"blister"},
  {v:"tripack",l:"Tripack (3 boosters)",cat:"Boosters & blisters",icon:"blister"},
  {v:"checklane",l:"Blister checklane",cat:"Boosters & blisters",icon:"blister"},
  {v:"bundle",l:"Booster Bundle (6)",cat:"Boosters & blisters",icon:"box"},
  {v:"display",l:"Display / Booster Box (36)",cat:"Boîtes & displays",icon:"box"},
  {v:"halfbox",l:"Demi-display (18)",cat:"Boîtes & displays",icon:"box"},
  {v:"case",l:"Carton (case de displays)",cat:"Boîtes & displays",icon:"box"},
  {v:"etb",l:"Elite Trainer Box (ETB)",cat:"ETB & coffrets premium",icon:"etb"},
  {v:"etbplus",l:"ETB Plus / Pokémon Center",cat:"ETB & coffrets premium",icon:"etb"},
  {v:"upc",l:"Ultra Premium Collection (UPC)",cat:"ETB & coffrets premium",icon:"etb"},
  {v:"spc",l:"Super Premium Collection",cat:"ETB & coffrets premium",icon:"etb"},
  {v:"premium",l:"Premium Collection",cat:"ETB & coffrets premium",icon:"coffret"},
  {v:"special",l:"Special / Collection Box",cat:"ETB & coffrets premium",icon:"coffret"},
  {v:"exbox",l:"Coffret ex / V / VMAX / VSTAR",cat:"ETB & coffrets premium",icon:"coffret"},
  {v:"figurebox",l:"Premium Figure Box",cat:"ETB & coffrets premium",icon:"coffret"},
  {v:"pin",l:"Coffret Pin's",cat:"ETB & coffrets premium",icon:"coffret"},
  {v:"tin",l:"Tin / Pokébox",cat:"Tins",icon:"tin"},
  {v:"minitin",l:"Mini Tin",cat:"Tins",icon:"tin"},
  {v:"pokeballtin",l:"Poké Ball Tin",cat:"Tins",icon:"tin"},
  {v:"bnb",l:"Build & Battle Box",cat:"Decks & prerelease",icon:"deck"},
  {v:"bnbstadium",l:"Build & Battle Stadium",cat:"Decks & prerelease",icon:"deck"},
  {v:"battledeck",l:"Battle Deck / Deck préconstruit",cat:"Decks & prerelease",icon:"deck"},
  {v:"themedeck",l:"Theme Deck",cat:"Decks & prerelease",icon:"deck"},
  {v:"starter",l:"Coffret dresseur débutant",cat:"Decks & prerelease",icon:"deck"},
  {v:"toolkit",l:"Trainer's Toolkit",cat:"Decks & prerelease",icon:"deck"},
  {v:"binder",l:"Coffret classeur / Portfolio",cat:"Divers",icon:"misc"},
  {v:"giftbox",l:"Gift Box / Calendrier de l'avent",cat:"Divers",icon:"box"},
  {v:"promo",l:"Carte promo scellée",cat:"Divers",icon:"promo"},
  {v:"jumbo",l:"Carte Jumbo",cat:"Divers",icon:"promo"},
  {v:"autre",l:"Autre scellé",cat:"Divers",icon:"misc"}
];
const PRODMAP=Object.fromEntries(PRODUCTS.map(p=>[p.v,p]));
function productOptions(){
  const cats=[...new Set(PRODUCTS.map(p=>p.cat))];
  return cats.map(cat=>`<optgroup label="${cat}">`+PRODUCTS.filter(p=>p.cat===cat).map(p=>`<option value="${p.v}">${p.l}</option>`).join("")+`</optgroup>`).join("");
}
function productSVG(iconType,label,setName){
  const icons={
    pack:'<rect x="70" y="42" width="70" height="112" rx="6" fill="#FFFFFF" stroke="url(#h)" stroke-width="2"/><rect x="70" y="42" width="70" height="16" fill="url(#h)" opacity="0.5"/>',
    box:'<path d="M55 72 L105 52 L155 72 L155 142 L105 162 L55 142 Z" fill="#FFFFFF" stroke="url(#h)" stroke-width="2"/><path d="M55 72 L105 92 L155 72" fill="none" stroke="url(#h)" stroke-width="2" opacity="0.6"/><line x1="105" y1="92" x2="105" y2="162" stroke="url(#h)" stroke-width="1.5" opacity="0.5"/>',
    etb:'<rect x="58" y="55" width="94" height="98" rx="6" fill="#FFFFFF" stroke="url(#h)" stroke-width="2"/><rect x="72" y="72" width="66" height="42" rx="3" fill="url(#h)" opacity="0.22"/><rect x="72" y="122" width="66" height="10" rx="3" fill="url(#h)" opacity="0.5"/>',
    tin:'<rect x="62" y="55" width="86" height="98" rx="14" fill="#FFFFFF" stroke="url(#h)" stroke-width="2"/><ellipse cx="105" cy="61" rx="43" ry="8" fill="url(#h)" opacity="0.4"/>',
    coffret:'<rect x="52" y="74" width="106" height="72" rx="6" fill="#FFFFFF" stroke="url(#h)" stroke-width="2"/><rect x="52" y="60" width="106" height="22" rx="5" fill="url(#h)" opacity="0.32"/>',
    blister:'<rect x="74" y="54" width="62" height="100" rx="6" fill="#FFFFFF" stroke="url(#h)" stroke-width="2"/><circle cx="105" cy="46" r="7" fill="none" stroke="url(#h)" stroke-width="2"/>',
    deck:'<rect x="66" y="60" width="58" height="90" rx="6" fill="#FFFFFF" stroke="url(#h)" stroke-width="2"/><rect x="82" y="52" width="58" height="90" rx="6" fill="#F4EEFF" stroke="url(#h)" stroke-width="2" opacity="0.75"/>',
    promo:'<rect x="72" y="52" width="66" height="98" rx="6" fill="#FFFFFF" stroke="url(#h)" stroke-width="2"/><text x="105" y="112" text-anchor="middle" font-size="30" fill="url(#h)">★</text>',
    misc:'<rect x="62" y="55" width="86" height="98" rx="8" fill="#FFFFFF" stroke="url(#h)" stroke-width="2"/><text x="105" y="116" text-anchor="middle" font-size="34" fill="url(#h)">?</text>'
  };
  const inner=icons[iconType]||icons.misc;
  const tspans=wrapTxt(label,17).map((l,i)=>`<tspan x="105" dy="${i===0?0:21}">${esc(l)}</tspan>`).join("");
  return `data:image/svg+xml;utf8,`+encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 210 293" font-family="sans-serif">
    <defs><linearGradient id="h" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7FCBFF"/><stop offset="0.5" stop-color="#A98BFF"/><stop offset="1" stop-color="#FF6FAE"/></linearGradient></defs>
    <rect width="210" height="293" rx="12" fill="#FCE8F1"/>
    <rect x="4" y="4" width="202" height="285" rx="9" fill="none" stroke="url(#h)" stroke-width="2" opacity="0.85"/>
    ${inner}
    <text x="105" y="200" text-anchor="middle" font-size="15" fill="#3B2440" font-weight="600">${tspans}</text>
    <text x="105" y="266" text-anchor="middle" font-size="11" fill="#8E7391">${esc(setName)}</text>
    <text x="105" y="283" text-anchor="middle" font-size="9" fill="#B08AB5" letter-spacing="2">SCELLÉ</text>
  </svg>`).replace(/'/g,"%27");
}
function visualGen(it){ return it.type==="sealed"
  ? productSVG(it.catalog.productType, it.catalog.name, it.catalog.set.name)
  : cardSVG(it.catalog.name, it.catalog.number, it.catalog.set.name); }

/* ---------- Catalogue TCGdex + fallback ---------- */
const TCG="https://api.tcgdex.net/v2/fr";
const img=(base,q="high")=>base?base+"/"+q+".webp":"";
const FALLBACK={
  series:[{id:"sv",name:"Écarlate et Violet"},{id:"swsh",name:"Épée et Bouclier"}],
  sets:{ sv:[{id:"sv03",name:"Flammes Obsidiennes"},{id:"sv04",name:"Faille Paradoxe"},{id:"sv05",name:"Forces Temporelles"}],
         swsh:[{id:"swsh12",name:"Tempête Argentée"},{id:"swsh11",name:"Origine Perdue"}] },
  cards:{
    sv03:[{id:"sv03-105",localId:"105",name:"Dracaufeu ex",image:"https://assets.tcgdex.net/fr/sv/sv03/105"},
          {id:"sv03-125",localId:"125",name:"Tyranocif ex",image:"https://assets.tcgdex.net/fr/sv/sv03/125"},
          {id:"sv03-215",localId:"215",name:"Dracaufeu ex Alt",image:"https://assets.tcgdex.net/fr/sv/sv03/215"}],
    sv04:[{id:"sv04-058",localId:"58",name:"Roigada ex",image:"https://assets.tcgdex.net/fr/sv/sv04/58"},
          {id:"sv04-182",localId:"182",name:"Miraidon ex Alt",image:"https://assets.tcgdex.net/fr/sv/sv04/182"}],
    sv05:[{id:"sv05-081",localId:"81",name:"Motorizard ex",image:"https://assets.tcgdex.net/fr/sv/sv05/81"},
          {id:"sv05-162",localId:"162",name:"Solgaleo",image:"https://assets.tcgdex.net/fr/sv/sv05/162"}],
    swsh12:[{id:"swsh12-160",localId:"160",name:"Rayquaza VMAX Alt",image:"https://assets.tcgdex.net/fr/swsh/swsh12/160"},
            {id:"swsh12-074",localId:"74",name:"Rayquaza VMAX",image:"https://assets.tcgdex.net/fr/swsh/swsh12/74"}],
    swsh11:[{id:"swsh11-186",localId:"186",name:"Giratina VSTAR Alt",image:"https://assets.tcgdex.net/fr/swsh/swsh11/186"},
            {id:"swsh11-131",localId:"131",name:"Aerodactyl VSTAR",image:"https://assets.tcgdex.net/fr/swsh/swsh11/131"}]
  }
};
const cache={sets:{},cards:{},detail:{}};
let usingFallback=false;
async function jget(url){const r=await fetch(url,{headers:{Accept:"application/json"}});if(!r.ok)throw new Error(r.status);return r.json();}
async function loadSeries(){try{const d=await jget(TCG+"/series");return d.map(s=>({id:s.id,name:s.name}));}catch(e){usingFallback=true;return FALLBACK.series;}}
async function loadSets(id){if(cache.sets[id])return cache.sets[id];let sets;
  if(usingFallback){sets=FALLBACK.sets[id]||[];}
  else{try{const d=await jget(TCG+"/series/"+id);sets=(d.sets||[]).map(s=>({id:s.id,name:s.name}));}catch(e){usingFallback=true;sets=FALLBACK.sets[id]||[];}}
  cache.sets[id]=sets;return sets;}
async function loadCards(setId){if(cache.cards[setId])return cache.cards[setId];let cards;
  if(usingFallback){cards=FALLBACK.cards[setId]||[];}
  else{try{const d=await jget(TCG+"/sets/"+setId);cards=(d.cards||[]).map(c=>({id:c.id,localId:c.localId,name:c.name,image:c.image}));}catch(e){cards=FALLBACK.cards[setId]||[];}}
  cache.cards[setId]=cards;return cards;}
async function loadCardDetail(id){ if(cache.detail[id]) return cache.detail[id];
  if(usingFallback) return null;
  try{ const d=await jget(TCG+"/cards/"+id); cache.detail[id]=d; return d; }catch(e){ cache.detail[id]=null; return null; } }

/* ---------- Prix marché (réel via TCGdex pricing) ---------- */
// Cardmarket = EUR (référence) ; TCGplayer = USD (converti). eBay = slot à brancher (backend perso).
const VARIANT_LABEL={normal:"Normale",holo:"Holo",reverse:"Reverse",firstEdition:"1re édition",wPromo:"Promo"};
const VARIANT_ORDER=["normal","holo","reverse","firstEdition","wPromo"];
// TCGplayer range ses prix par variante ; noms de clés possibles selon les cartes
const TP_KEYS={normal:["normal"],holo:["holo","holofoil"],reverse:["reverse","reverseHolofoil"],
  firstEdition:["1stEditionHolofoil","1stEditionNormal","1stEdition","firstEdition"],wPromo:["wPromo","normal","holo","holofoil"]};
function availableVariants(detail){
  const v=detail && detail.variants; if(!v || typeof v!=="object") return [];
  return VARIANT_ORDER.filter(k=>v[k]===true);
}
/* Cardmarket : champs de base = version standard ; champs « -holo » = version brillante (reverse).
   TCGplayer : prix en dollars, par variante (marketPrice, sinon midPrice, sinon lowPrice).
   1re édition : Cardmarket ne la distingue pas, son prix de base sert d'approximation. */
function extractMarket(pricing, variant){
  if(!pricing) return null;
  const num=(v)=>(typeof v==="number" && isFinite(v) && v>0) ? v : null;   // 0 = pas de donnée chez TCGdex
  let cm=null, avg7=null, avg30=null;
  const c=pricing.cardmarket;
  if(c){ const x=(variant==="reverse") ? "-holo" : "";
    cm = num(c["avg"+x]) ?? num(c["trend"+x]) ?? num(c["avg30"+x]) ?? num(c["avg7"+x]) ?? num(c["low"+x]);
    avg7=num(c["avg7"+x]); avg30=num(c["avg30"+x]); }
  let tp=null; const t=pricing.tcgplayer;
  if(t && typeof t==="object"){
    const pick=(o)=>(o && typeof o==="object") ? (num(o.marketPrice) ?? num(o.midPrice) ?? num(o.lowPrice) ?? num(o.market) ?? num(o.mid) ?? num(o.low)) : null;
    const keys = (variant && TP_KEYS[variant]) ? TP_KEYS[variant] : ["holofoil","holo","normal","reverseHolofoil","reverse"];
    for(const k of keys){ tp=pick(t[k]); if(tp!=null) break; }
    if(tp==null && !variant){ for(const k in t){ tp=pick(t[k]); if(tp!=null) break; } }
  }
  const tpEur = tp!=null ? round2(tp*(state.settings.usdToEur||0.92)) : null;
  const ref = cm!=null ? cm : tpEur;                                        // Cardmarket prioritaire
  if(ref==null) return null;
  let trendPct=null;
  if(cm!=null && avg30) trendPct=(cm-avg30)/avg30*100;
  else if(cm!=null && avg7) trendPct=(cm-avg7)/avg7*100;
  return { cardmarket:cm, tcgplayer:tp, tcgplayerEur:tpEur, avg7, avg30, trendPct, ref, variant:variant||null, updatedAt:new Date().toISOString() };
}
const marketSnapshot=(m)=>m?{cardmarket:m.cardmarket,tcgplayer:m.tcgplayer,tcgplayerEur:m.tcgplayerEur,avg7:m.avg7,avg30:m.avg30,trendPct:m.trendPct,ref:m.ref,variant:m.variant,updatedAt:m.updatedAt}:null;
// signal de timing pour une carte en stock/en vente
function sellTiming(m){
  if(!m || m.trendPct==null) return null;
  if(m.trendPct>=8) return {cls:"at", lbl:`↑ +${m.trendPct.toFixed(0)}% — bon moment`};
  if(m.trendPct<=-8) return {cls:"over", lbl:`↓ ${m.trendPct.toFixed(0)}% — ajuste`};
  return null;
}
// deal-check à l'achat : prix payé vs marché
function dealCheck(purchase, ref){
  if(!purchase||!ref) return null;
  const r=purchase/ref;
  if(r<=0.70) return {cls:"under", lbl:"Bon plan"};
  if(r<=1.00) return {cls:"at", lbl:"Correct"};
  return {cls:"over", lbl:"Au-dessus du marché"};
}
async function fetchMarket(cardId, variant){ const d=await loadCardDetail(cardId); return extractMarket(d&&d.pricing, variant||undefined); }

// signal indiqué vs marché
function priceSignal(asking, ref){
  if(!ref||!asking) return null;
  const r=asking/ref;
  if(r<0.90) return {cls:"under", lbl:"Sous le marché"};
  if(r<=1.10) return {cls:"at", lbl:"Au prix marché"};
  return {cls:"over", lbl:"Au-dessus"};
}
function suggestPrice(purchase, ref){
  const floor=(purchase||0)*(state.settings.targetCoef||1.5);
  if(ref) return Math.max(floor, ref*(1-(state.settings.undercutPct||0)/100));
  return floor;
}

/* ---------- Calculs ---------- */
const qtyOf=(it)=>it.quantity||1;
const itemFees=(it)=>it.sale?((it.sale.fees?.platformFee||0)+(it.sale.fees?.shipping||0)):0;
const realMargin=(it)=>it.sale?((it.sale.soldPrice-it.acquisition.purchasePrice)*qtyOf(it)-itemFees(it)):0;
const roiItem=(it)=>{const inv=it.acquisition.purchasePrice*qtyOf(it);return (it.sale&&inv>0)?realMargin(it)/inv*100:0;};
function feeFor(platform, price){ const f=platform && state.settings.fees[platform]; if(!f || !(price>0)) return 0; return round2(price*(f.pct||0)/100+(f.flat||0)); }
const estFeesUnit=(it)=>feeFor(it.listing?.platform, it.listing?.askingPrice||0);
// Marge estimée après frais (frais connus seulement si le lieu de vente est choisi)
const latentMargin=(it)=>((it.listing?.askingPrice||0)-estFeesUnit(it)-it.acquisition.purchasePrice)*qtyOf(it);
const belowCost=(it)=>it.status!=="sold" && (it.listing?.askingPrice||0)>0 && (it.listing.askingPrice-estFeesUnit(it)) < it.acquisition.purchasePrice;
// Prix à afficher pour toucher « net » : prix = (net + forfait) / (1 − commission)
function priceForNet(net, platform){ const f=state.settings.fees[platform]||{pct:0,flat:0}; const k=1-(f.pct||0)/100;
  if(!(net>=0) || k<=0) return null; return Math.ceil(((net+(f.flat||0))/k)*100-1e-9)/100; }
const stockAge=(it)=>{ if(!it.acquisition?.date) return null;
  const end = it.status==="sold" ? (it.sale?.date||todayStr()) : todayStr();
  return daysBetween(it.acquisition.date, end); };
// ROI annualisé d'une vente : (1+roi)^(365/jours) - 1
function roiAnnualized(it){ if(it.status!=="sold") return null;
  const days=Math.max(1, stockAge(it)||1); const r=roiItem(it)/100;
  if(r<=-1) return -100;
  return (Math.pow(1+r, 365/days)-1)*100; }

function aggregates(){
  let invested=0,stockVal=0,ca=0,profit=0,investedSold=0;
  for(const it of state.items){ const q=qtyOf(it);
    invested+=(it.acquisition.purchasePrice||0)*q;
    if(it.status==="stock"||it.status==="listed") stockVal+=(it.listing?.askingPrice||0)*q;
    if(it.status==="sold"){ ca+=(it.sale.soldPrice||0)*q; profit+=realMargin(it); investedSold+=(it.acquisition.purchasePrice||0)*q; }
  }
  return {invested,stockVal,ca,profit,roi:investedSold>0?profit/investedSold*100:0};
}

/* ---------- Rendu KPIs ---------- */
function renderKPIs(){
  const a=aggregates();
  $("kInvest").textContent=fmt(a.invested); $("kStock").textContent=fmt(a.stockVal); $("kCA").textContent=fmt(a.ca);
  const p=$("kProfit"); p.textContent=fmt(a.profit); p.className="val num "+(a.profit>0?"pos":a.profit<0?"neg":"");
  const r=$("kROI"); const hasSold=state.items.some(i=>i.status==="sold");
  r.textContent=hasSold?pct(a.roi):"—"; r.className="val num "+(a.roi>0?"pos":a.roi<0?"neg":"");
}

/* ---------- Liste : filtres / recherche / tri ---------- */
let filter="all", search="", sortBy="recent";
function counts(){const c={all:state.items.length,stock:0,listed:0,sold:0};state.items.forEach(i=>c[i.status]++);
  $("cAll").textContent=c.all;$("cStock").textContent=c.stock;$("cListed").textContent=c.listed;$("cSold").textContent=c.sold;}
let tagSel="";
function matchSearch(it){
  if(tagSel && !(it.tags||[]).includes(tagSel)) return false;
  if(!search) return true; const q=search.toLowerCase();
  return [it.catalog.name,it.catalog.set.name,it.catalog.number,(it.tags||[]).join(" "),it.notes,VARIANT_LABEL[it.variant],it.location]
    .filter(Boolean).join(" ").toLowerCase().includes(q); }
function sortItems(arr){
  const s=arr.slice();
  const key={ recent:(a,b)=>new Date(b.createdAt)-new Date(a.createdAt),
    margin:(a,b)=>(b.status==="sold"?realMargin(b):latentMargin(b))-(a.status==="sold"?realMargin(a):latentMargin(a)),
    asking:(a,b)=>(b.listing?.askingPrice||0)-(a.listing?.askingPrice||0),
    age:(a,b)=>(stockAge(b)||0)-(stockAge(a)||0),
    set:(a,b)=>a.catalog.set.name.localeCompare(b.catalog.set.name),
    name:(a,b)=>a.catalog.name.localeCompare(b.catalog.name) };
  return s.sort(key[sortBy]||key.recent);
}

function sparkline(h){
  const pts=(Array.isArray(h)?h:[]).slice(-12).map(p=>p&&p.ref).filter(v=>typeof v==="number");
  if(pts.length<2) return "";
  const W=54,H=16,mn=Math.min(...pts),mx=Math.max(...pts),sp=(mx-mn)||1;
  const xy=pts.map((v,i)=>`${(1+i*(W-2)/(pts.length-1)).toFixed(1)},${(H-1-(v-mn)/sp*(H-2)).toFixed(1)}`).join(" ");
  const lbl=`${pts.length} relevés : ${fmt(pts[0])} → ${fmt(pts[pts.length-1])}`;
  return `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(lbl)}"><title>${esc(lbl)}</title><polyline points="${xy}"/></svg>`;
}
function itemNode(it){
  const el=document.createElement("div"); el.className="item";
  const q=qtyOf(it), cond=it.condition;
  const ageD=stockAge(it);
  const ageTxt = it.status==="sold" ? (ageD!=null?`vendu en ${ageD} j`:"") : (ageD!=null?`en stock ${ageD} j`:"");
  const stale = it.status!=="sold" && ageD!=null && ageD>=30;

  const annu=roiAnnualized(it);
  const marginLine = it.status==="sold"
    ? `<div class="mrow"><span class="k">Marge</span><span class="v" style="color:${realMargin(it)>=0?'var(--sold)':'var(--loss)'}">${fmt(realMargin(it))}</span></div>
       <div class="mrow"><span class="k">ROI</span><span class="v" style="color:${roiItem(it)>=0?'var(--sold)':'var(--loss)'}">${pct(roiItem(it))}</span></div>
       ${annu!=null?`<div class="mrow"><span class="k">ROI/an</span><span class="v" style="color:${annu>=0?'var(--sold)':'var(--loss)'}">${fmtAnnu(annu)}</span></div>`:""}`
    : `<div class="mrow"><span class="k">Indiqué${q>1?" ×"+q:""}</span><span class="v">${fmt((it.listing?.askingPrice||0)*q)}</span></div>
       <div class="mrow"><span class="k">Marge est.</span><span class="v" style="color:${latentMargin(it)>=0?'var(--sold)':'var(--loss)'}">${fmt(latentMargin(it))}</span></div>`;

  let acts="";
  if(it.status==="stock") acts=`<button class="mini go" data-act="list" data-id="${it.id}">Mettre en vente →</button>`;
  else if(it.status==="listed") acts=`<button class="mini go" data-act="sell" data-id="${it.id}">Marquer vendu →</button>`;
  const annonceBtn = it.status!=="sold" ? `<button class="mini" data-act="listing" data-id="${it.id}">Annonce</button>` : "";

  const statusTag={stock:"stock",listed:"listed",sold:"sold"}[it.status];
  let statusLbl={stock:"Stock",listed:"En vente",sold:"Vendu"}[it.status];
  if(it.status==="listed"&&it.listing?.platform) statusLbl="En vente · "+it.listing.platform;
  if(it.status==="sold"&&it.sale?.platform) statusLbl="Vendu · "+it.sale.platform;

  const gradeTag = it.grading?.company ? `<span class="tag grade">${it.grading.company} ${it.grading.grade??""}</span>` : "";
  const sig = it.status!=="sold" ? priceSignal(it.listing?.askingPrice, it.market?.ref) : null;
  const sigTag = sig ? `<span class="tag ${sig.cls}">${sig.lbl}</span>` : "";
  const staleTag = stale ? `<span class="tag stale">Dort ${ageD} j</span>` : "";
  const costTag = belowCost(it) ? `<span class="tag cost" title="Prix indiqué, frais déduits, inférieur au prix d'achat">Sous le coût</span>` : "";
  const varTag = (it.variant && it.variant!=="normal") ? `<span class="tag var">${esc(VARIANT_LABEL[it.variant]||it.variant)}</span>` : "";
  const labelTags = (it.tags||[]).map(t=>`<span class="tag label">${esc(t)}</span>`).join("");
  const timing = it.status!=="sold" ? sellTiming(it.market) : null;
  const timingTag = timing ? `<span class="tag ${timing.cls}">${timing.lbl}</span>` : "";
  const locTxt = it.location ? ` · 📍 ${esc(it.location)}` : "";
  const condBadge = it.type==="sealed" ? (it.condition==="USED"?"Occasion":"Scellé") : cond;
  const numTxt = it.catalog.number ? ` · n°${esc(it.catalog.number)}` : "";

  el.innerHTML=`
    <div class="thumb"><img alt="" loading="lazy">${q>1?`<span class="qty">×${q}</span>`:""}</div>
    <div class="meta">
      <div class="name">${esc(it.catalog.name)}</div>
      <div class="sub">${esc(it.catalog.set.name)}${numTxt}${ageTxt?" · "+ageTxt:""}${locTxt}</div>
      <div class="badges">
        <span class="tag ${statusTag}">${esc(statusLbl)}</span>
        <span class="tag cond">${condBadge}</span>${varTag}${gradeTag}${sigTag}${costTag}${timingTag}${staleTag}${labelTags}
      </div>
      ${it.notes?`<div class="note" title="${esc(it.notes)}">📝 ${esc(String(it.notes).split("\n")[0])}</div>`:""}
    </div>
    <div class="money-col">
      <div class="mrow"><span class="k">Achat${q>1?" ×"+q:""}</span><span class="v">${fmt(it.acquisition.purchasePrice*q)}</span></div>
      ${it.market?.ref?`<div class="mrow"><span class="k">Marché</span><span class="v">${sparkline(it.priceHistory)}${fmtEUR(it.market.ref)}</span></div>`:""}
      ${marginLine}
      <div class="acts">${acts}${annonceBtn}<button class="mini" data-act="edit" data-id="${it.id}">Éditer</button><button class="mini del" data-act="del" data-id="${it.id}" aria-label="Supprimer ${esc(it.catalog.name)}" title="Supprimer">✕</button></div>
    </div>`;
  mountImg(el.querySelector(".thumb img"), it.userPhoto||it.catalog.imageUrl, visualGen(it));
  return el;
}

function galleryNode(it){
  const b=document.createElement("button"); b.type="button"; b.className="gcard"; b.dataset.act="edit"; b.dataset.id=it.id;
  const q=qtyOf(it), price = it.status==="sold" ? it.sale?.soldPrice : it.listing?.askingPrice;
  const st={stock:"Stock",listed:"En vente",sold:"Vendu"}[it.status]||it.status;
  b.setAttribute("aria-label",`${it.catalog.name}, ${st}${price?", "+fmt(price):""} — modifier`);
  b.innerHTML=`<div class="gimg"><img alt="" loading="lazy">${q>1?`<span class="qty">×${q}</span>`:""}</div>
    <div class="gname" title="${esc(it.catalog.name)}">${esc(it.catalog.name)}</div>
    <div class="gfoot"><span class="tag ${it.status}">${st}</span><span class="gprice">${price?fmt(price):"—"}</span></div>`;
  mountImg(b.querySelector("img"), it.userPhoto||it.catalog.imageUrl, visualGen(it));
  return b;
}
function renderTagFilter(){
  const sel=$("tagFilter"); const tags=[...new Set(state.items.flatMap(i=>i.tags||[]))].sort((a,b)=>a.localeCompare(b,"fr"));
  if(tagSel && !tags.includes(tagSel)) tagSel="";
  sel.innerHTML=`<option value="">Toutes étiquettes</option>`+tags.map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join("");
  sel.value=tagSel; sel.hidden = tags.length===0;
}
function renderList(){
  counts(); renderTagFilter();
  const gallery=state.settings.view==="gallery", node=gallery?galleryNode:itemNode;
  $("viewList").setAttribute("aria-pressed",!gallery); $("viewGallery").setAttribute("aria-pressed",gallery);
  const wrap=$("stockList"), hl=$("histList"), hw=$("histWrap");
  wrap.classList.toggle("gallery",gallery); hl.classList.toggle("gallery",gallery);
  let active=sortItems(state.items.filter(i=>i.status!=="sold"&&(filter==="all"||i.status===filter)&&matchSearch(i)));
  wrap.innerHTML="";
  const filtering = !!(search||tagSel);
  if(filter!=="sold"){
    if(active.length===0) wrap.innerHTML = filtering
      ? `<div class="empty"><b>Aucun résultat</b>Aucune ligne ne correspond à ta recherche ou à l'étiquette choisie.</div>`
      : `<div class="empty"><b>Rien ici pour l'instant</b>Choisis un set puis une carte pour créer ta première ligne de stock.</div>`;
    else active.forEach(it=>wrap.appendChild(node(it)));
  }
  const sold=sortItems(state.items.filter(i=>i.status==="sold"&&matchSearch(i)));
  if((filter==="all"||filter==="sold")&&sold.length){ hw.hidden=false; hl.innerHTML=""; sold.forEach(it=>hl.appendChild(node(it))); }
  else hw.hidden=true;
  if(filter==="sold"&&sold.length===0) wrap.innerHTML=`<div class="empty"><b>Aucune vente</b>Tes cartes vendues et leurs marges apparaîtront ici.</div>`;
}
$("tagFilter").addEventListener("change",e=>{ tagSel=e.target.value; renderList(); });
$("viewList").addEventListener("click",()=>{ state.settings.view="list"; persist(); renderList(); });
$("viewGallery").addEventListener("click",()=>{ state.settings.view="gallery"; persist(); renderList(); });

/* ---------- Bénéfice du mois & objectif ---------- */
const monthOf=(d)=>(d||"").slice(0,7);
const profitOfMonth=(key)=>state.items.filter(i=>i.status==="sold"&&monthOf(i.sale?.date)===key).reduce((s,i)=>s+realMargin(i),0);
function renderGoal(){
  const box=$("goalBar"), now=new Date(), goal=state.settings.monthlyGoal||0;
  const key=localISO(now).slice(0,7), prevD=new Date(now.getFullYear(),now.getMonth()-1,1), prevKey=localISO(prevD).slice(0,7);
  if(!goal && !state.items.some(i=>i.status==="sold")){ box.innerHTML=""; return; }
  const mName=now.toLocaleDateString("fr-FR",{month:"long"}), pName=prevD.toLocaleDateString("fr-FR",{month:"long"});
  const cur=profitOfMonth(key), prev=profitOfMonth(prevKey);
  const delta = prev!==0 ? (cur-prev)/Math.abs(prev)*100 : null;
  let main;
  if(goal>0){ const p=Math.max(0,cur)/goal*100, w=Math.min(100,p);
    main=`<div class="g-line"><span>Objectif de ${mName} : <b>${fmt(cur)}</b> sur ${fmt(goal)}</span><b>${Math.round(p)} %</b></div>
      <div class="g-track" role="progressbar" aria-label="Progression de l'objectif" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(w)}"><div class="g-fill${p>=100?" done":""}" style="width:${w}%"></div></div>`;
  } else main=`<div class="g-line"><span>Bénéfice de ${mName} : <b>${fmt(cur)}</b></span><button class="linkbtn" id="goalSet" type="button">Fixer un objectif</button></div>`;
  const side=`${pName.charAt(0).toUpperCase()+pName.slice(1)} : <b>${fmt(prev)}</b>`+(delta!=null?` · <span style="color:${delta>=0?"var(--sold)":"var(--loss)"}">${delta>=0?"+":""}${Math.round(delta)} %</span>`:"");
  box.innerHTML=`<div class="g-main">${main}</div><div class="g-side">${side}</div>`;
}
$("goalBar").addEventListener("click",e=>{ if(e.target.id==="goalSet"){ openSettings(); setTimeout(()=>$("stGoal").focus(),50); } });

function renderAll(){ renderKPIs(); renderGoal(); renderList(); updateWishCount(); updateTrashCount(); updateStoreNote(); }

/* ---------- Sélection carte + marché + conseil ---------- */
let selected=null, selMarket=null, entryMode="card";
const COND_CARD=`<option value="MT">MT</option><option value="NM" selected>NM</option><option value="EX">EX</option><option value="GD">GD</option><option value="LP">LP</option><option value="PL">PL</option><option value="PO">PO</option>`;
const COND_SEALED=`<option value="SEALED" selected>Neuf scellé</option><option value="USED">Occasion</option>`;
function applyMode(m){
  entryMode=m;
  $("modeCard").setAttribute("aria-pressed",m==="card");
  $("modeSealed").setAttribute("aria-pressed",m==="sealed");
  const card=m==="card";
  $("btnScan").style.display=card?"":"none";
  $("cardPickWrap").hidden=!card; $("variantWrap").hidden=!card; $("prodPickWrap").hidden=card; $("prodNameWrap").hidden=card;
  $("selCond").innerHTML=card?COND_CARD:COND_SEALED;
  $("entryHint").textContent=card?"Choisis un set, puis la carte — prix marché et conseil s'affichent automatiquement."
                                  :"Choisis un set, puis le type de produit scellé.";
  $("selSet").value=""; $("selSet").dispatchEvent(new Event("change"));
  clearSelection();
}
$("modeCard").addEventListener("click",()=>applyMode("card"));
$("modeSealed").addEventListener("click",()=>applyMode("sealed"));
async function initPickers(){
  const series=await loadSeries();
  $("selSerie").innerHTML=`<option value="">— choisir —</option>`+series.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join("");
  if(usingFallback) toast("Catalogue de démo (API TCGdex non joignable ici)");
}
$("selSerie").addEventListener("change",async e=>{
  const set=$("selSet"),card=$("selCard"),prod=$("selProduct");
  set.disabled=true;card.disabled=true;card.innerHTML=`<option value="">—</option>`;
  prod.disabled=true;prod.innerHTML=`<option value="">— choisir le set d'abord —</option>`;clearSelection();
  if(!e.target.value){set.innerHTML=`<option value="">—</option>`;return;}
  set.innerHTML=`<option value="">Chargement…</option>`; const sets=await loadSets(e.target.value);
  set.innerHTML=`<option value="">— choisir —</option>`+sets.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join(""); set.disabled=false;
});
$("selSet").addEventListener("change",async e=>{
  clearSelection();
  const card=$("selCard"), prod=$("selProduct");
  if(entryMode==="sealed"){
    if(!e.target.value){ prod.disabled=true; prod.innerHTML=`<option value="">— choisir le set d'abord —</option>`; return; }
    prod.innerHTML=`<option value="">— choisir —</option>`+productOptions(); prod.disabled=false; return;
  }
  if(!e.target.value){card.disabled=true;card.innerHTML=`<option value="">—</option>`;return;}
  card.innerHTML=`<option value="">Chargement…</option>`; const cards=await loadCards(e.target.value);
  card.innerHTML=`<option value="">— choisir —</option>`+cards.map(c=>`<option value="${c.id}">n°${c.localId} · ${esc(c.name)}</option>`).join(""); card.disabled=false;
});
$("selProduct").addEventListener("change",e=>{
  const p=PRODMAP[e.target.value];
  if(!p||!$("selSet").value){ clearSelection(); return; }
  const setId=$("selSet").value, setName=$("selSet").selectedOptions[0].textContent, serieName=$("selSerie").selectedOptions[0].textContent;
  const extra=$("inProdName").value.trim();
  pendingWishId=null;
  selected={sealed:true, productType:p.v, name:p.l+(extra?` — ${extra}`:""), set:{id:setId,name:setName,series:serieName}, imageUrl:null};
  renderSelectedPreview();
  $("mktBox").hidden=true; $("dealBox").hidden=true; selMarket=null;
  validateForm(); updateSuggest();
});
$("inProdName").addEventListener("input",()=>{ if(entryMode==="sealed"&&$("selProduct").value) $("selProduct").dispatchEvent(new Event("change")); });
$("selCard").addEventListener("change",async e=>{
  if(!e.target.value){clearSelection();return;}
  const setId=$("selSet").value; const cards=await loadCards(setId); const c=cards.find(x=>x.id===e.target.value); if(!c)return;
  const setName=$("selSet").selectedOptions[0].textContent, serieName=$("selSerie").selectedOptions[0].textContent;
  pendingWishId=null;
  selected={id:c.id,name:c.name,number:c.localId,language:"fr",set:{id:setId,name:setName,series:serieName},imageUrl:img(c.image,"high")};
  renderSelectedPreview(); validateForm();
  $("mktBox").hidden=true; selMarket=null; updateSuggest();
  await fillVariants(c.id);
});
function renderMktBox(m){
  const box=$("mktBox");
  if(!m){ box.hidden=false; box.innerHTML=`<div class="mrow"><span class="k">Prix marché</span><span class="v" style="color:var(--muted)">indisponible ici</span></div>`; return; }
  box.hidden=false;
  box.innerHTML=`
    <div class="mrow"><span>Cardmarket</span><span class="v">${m.cardmarket!=null?fmtEUR(m.cardmarket):"—"}</span></div>
    <div class="mrow"><span>TCGplayer (converti)</span><span class="v">${m.tcgplayerEur!=null?fmt(m.tcgplayerEur):"—"}</span></div>
    <div class="mrow"><span>eBay ventes</span><span class="v" style="color:var(--muted-2)">à brancher</span></div>
    <div class="mrow" style="border-top:1px solid var(--line);margin-top:4px;padding-top:5px"><span><b>Réf. marché${m.variant?" · "+esc(VARIANT_LABEL[m.variant]||m.variant):""}</b></span><span class="v"><b>${fmtEUR(m.ref)}</b></span></div>`;
}
/* ---------- Variantes : seules celles qui existent pour la carte sont proposées ---------- */
let variantTok=0;
const VARIANT_ALL_OPTS=`<option value="">Non précisée</option>`+VARIANT_ORDER.map(v=>`<option value="${v}">${VARIANT_LABEL[v]}</option>`).join("");
async function fillVariants(cardId, preferred){
  const tok=++variantTok, sel=$("selVariant"); sel.disabled=true;
  const d=await loadCardDetail(cardId);
  if(tok!==variantTok) return;                               // une autre carte a été choisie entre-temps
  const avail=availableVariants(d);
  sel.innerHTML = avail.length ? avail.map(v=>`<option value="${v}">${VARIANT_LABEL[v]}</option>`).join("") : VARIANT_ALL_OPTS;
  sel.value = (preferred && (avail.length?avail.includes(preferred):VARIANT_ORDER.includes(preferred))) ? preferred : (avail[0]||"");
  sel.disabled=false;
  if(d) selMarket=extractMarket(d.pricing, sel.value||undefined);
  renderMktBox(selMarket); updateSuggest();
}
$("selVariant").addEventListener("change",()=>{
  if(!selected || selected.sealed) return;
  const d=cache.detail[selected.id];
  if(d) selMarket=extractMarket(d.pricing, $("selVariant").value||undefined);
  renderMktBox(selMarket); updateSuggest();
});
function updateSuggest(){
  if(!selected){ $("suggestBox").hidden=true; $("dealBox").hidden=true; $("askWarn").hidden=true; $("btnWishAdd").hidden=true; return; }
  $("btnWishAdd").hidden = !!selected.sealed;
  const pa=parseFloat($("inPurchase").value)||0;
  const s=suggestPrice(pa, selMarket?.ref);
  $("suggestBox").hidden=false; $("suggestVal").textContent=fmtEUR(s);
  const dc=dealCheck(pa, selMarket?.ref);
  if(dc){ $("dealBox").hidden=false; const t=$("dealTag"); t.className="tag "+dc.cls; t.textContent=dc.lbl; }
  else $("dealBox").hidden=true;
  // Session d'achat : le prix de revente conseillé est rempli tout seul (tant que tu ne le modifies pas)
  if(state.session.active && (askAuto || !$("inAsking").value) && s>0){ $("inAsking").value=s.toFixed(2); askAuto=true; }
  updateAskWarn();
}
let askAuto=false;
function updateAskWarn(){
  const pa=parseFloat($("inPurchase").value), ask=parseFloat($("inAsking").value), w=$("askWarn");
  if(selected && pa>0 && ask>0 && ask<pa){ w.hidden=false; w.textContent=`⚠ Prix indiqué sous ton prix d'achat (${fmt(pa)}) : vente à perte.`; }
  else w.hidden=true;
}
$("inAsking").addEventListener("input",()=>{ askAuto=false; updateAskWarn(); });
$("applySuggest").addEventListener("click",()=>{ const pa=parseFloat($("inPurchase").value)||0; $("inAsking").value=(suggestPrice(pa,selMarket?.ref)).toFixed(2); validateForm(); });
function renderSelectedPreview(){
  const pv=$("preview");
  if(!selected){ const ph=entryMode==="sealed"?"Le produit scellé<br>s'affichera ici":"La carte sélectionnée<br>s'affichera ici"; pv.innerHTML=`<span class="ph">${ph}</span>`; return; }
  pv.innerHTML=`<img alt="${esc(selected.name)}">`; const imgEl=pv.querySelector("img");
  if(entryPhoto){ imgEl.src=entryPhoto; }
  else if(selected.sealed){ imgEl.src=productSVG(selected.productType, selected.name, selected.set.name); }
  else { mountImg(imgEl, selected.imageUrl, cardSVG(selected.name, selected.number, selected.set.name)); }
}
let entryPhoto=null;
function setEntryPhoto(url){ entryPhoto=url||null; const pv=$("inPhotoPv");
  if(url){pv.src=url;pv.style.display="";}else{pv.removeAttribute("src");pv.style.display="none";}
  renderSelectedPreview(); }
$("inPhoto").addEventListener("change",e=>{const f=e.target.files[0];if(!f)return;downscale(f,700,(url)=>setEntryPhoto(url));e.target.value="";});
$("inPhotoClear").addEventListener("click",()=>setEntryPhoto(null));
function clearSelection(){selected=null;selMarket=null;entryPhoto=null;setEntryPhoto(null);$("mktBox").hidden=true;$("suggestBox").hidden=true;$("dealBox").hidden=true;
  $("askWarn").hidden=true; $("btnWishAdd").hidden=true; askAuto=false; pendingWishId=null;
  variantTok++; const sv=$("selVariant"); sv.innerHTML=VARIANT_ALL_OPTS; sv.value=""; sv.disabled=true;
  renderSelectedPreview();validateForm();}
function validateForm(){const pa=parseFloat($("inPurchase").value);$("btnAdd").disabled=!(selected&&pa>=0&&$("inPurchase").value!=="");}
$("inPurchase").addEventListener("input",()=>{validateForm();updateSuggest();});

/* ---------- Ajouter (avec détection des doublons) ---------- */
let pendingWishId=null, pendingNew=null, pendingDupId=null;
const newId=(p="it_")=>p+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
function buildNewItem(){
  const pa=round2(parseFloat($("inPurchase").value)||0), ask=round2(parseFloat($("inAsking").value)||0);
  const qty=Math.max(1,parseInt($("inQty").value)||1), date=$("inDate").value||todayStr();
  const tags = state.session.active && state.session.label ? [state.session.label] : [];
  const base={ id:newId(), quantity:qty, condition:$("selCond").value, grading:null, userPhoto:entryPhoto||null,
    location:$("inLoc").value.trim()||null, tags, notes:null,
    acquisition:{purchasePrice:pa,currency,date}, listing:{askingPrice:ask,currency,platform:null,listedDate:null},
    sale:null, status:"stock", createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() };
  if(selected.sealed) return {...base, type:"sealed", variant:null, market:null, priceHistory:[],
    catalog:{source:"manual",productType:selected.productType,name:selected.name,set:selected.set,number:null,language:"fr",imageUrl:null}};
  const mkt=marketSnapshot(selMarket);
  return {...base, type:"card", variant:$("selVariant").value||null, market:mkt, priceHistory: mkt?[{date,ref:mkt.ref}]:[],
    catalog:{source:"tcgdex",cardId:selected.id,name:selected.name,set:selected.set,number:selected.number,language:selected.language,imageUrl:selected.imageUrl}};
}
function findDuplicate(n){
  return state.items.find(o=>o.status==="stock" && o.type===n.type && o.condition===n.condition && !o.grading &&
    (n.type==="sealed"
      ? (o.catalog.productType===n.catalog.productType && o.catalog.set?.id===n.catalog.set?.id && o.catalog.name===n.catalog.name)
      : (o.catalog.cardId===n.catalog.cardId && (o.variant||null)===(n.variant||null))));
}
$("btnAdd").addEventListener("click",()=>{
  if(!selected) return;
  const n=buildNewItem(), dup=findDuplicate(n);
  if(dup){ pendingNew=n; pendingDupId=dup.id; openDupModal(dup,n); return; }
  commitAdd(n,null);
});
function openDupModal(o,n){
  const q1=qtyOf(o), q2=qtyOf(n), p1=o.acquisition.purchasePrice, p2=n.acquisition.purchasePrice;
  const avg=round2((p1*q1+p2*q2)/(q1+q2));
  const cond = o.type==="sealed" ? (o.condition==="USED"?"occasion":"scellé") : o.condition;
  $("dpSub").textContent=`« ${o.catalog.name} » (${cond}${o.variant?", "+(VARIANT_LABEL[o.variant]||o.variant):""}) est déjà dans ton stock.`;
  $("dpCalc").innerHTML=`<div><span>En stock</span><span>×${q1} à ${fmt(p1)}</span></div>
    <div><span>Nouvel achat</span><span>×${q2} à ${fmt(p2)}</span></div>
    <div class="tot"><span>Lot fusionné</span><span>×${q1+q2} au coût moyen de ${fmt(avg)}</span></div>`;
  $("modalDup").classList.add("on"); $("dpMerge").focus();
}
$("dpMerge").addEventListener("click",()=>{ const o=state.items.find(i=>i.id===pendingDupId); if(pendingNew) commitAdd(pendingNew,o||null); closeModals(); });
$("dpSeparate").addEventListener("click",()=>{ if(pendingNew) commitAdd(pendingNew,null); closeModals(); });
function commitAdd(n, into){
  pendingNew=null; pendingDupId=null;
  let msg;
  if(into){
    const q1=qtyOf(into), q2=qtyOf(n);
    into.acquisition.purchasePrice=round2((into.acquisition.purchasePrice*q1+n.acquisition.purchasePrice*q2)/(q1+q2));
    into.quantity=q1+q2;
    if(!into.userPhoto && n.userPhoto) into.userPhoto=n.userPhoto;
    if(!(into.listing?.askingPrice>0) && n.listing.askingPrice>0) into.listing.askingPrice=n.listing.askingPrice;
    into.tags=[...new Set([...(into.tags||[]),...n.tags])];
    if(n.market){ into.market=n.market; into.priceHistory=into.priceHistory||[]; if(!into.priceHistory.some(h=>h.date===todayStr())) into.priceHistory.push({date:todayStr(),ref:n.market.ref}); }
    into.updatedAt=new Date().toISOString();
    msg=`Ajouté au lot existant (×${into.quantity})`;
  } else { state.items.push(n); msg = qtyOf(n)>1 ? `Lot de ${qtyOf(n)} ajouté` : "Ajouté au stock"; }
  if(state.session.active){ state.session.count+=qtyOf(n); state.session.spent=round2(state.session.spent+n.acquisition.purchasePrice*qtyOf(n)); }
  if(pendingWishId){ state.wishlist=state.wishlist.filter(w=>w.id!==pendingWishId); msg+=" · retirée de ta liste d'achats"; }
  persist(); renderAll(); renderSession();
  // remise à zéro : en session, on garde série, set, date, emplacement et état pour enchaîner
  $("inPurchase").value=""; $("inAsking").value=""; $("inQty").value="1"; $("inProdName").value=""; $("selCard").value=""; $("selProduct").value="";
  if(!state.session.active){ $("inLoc").value=""; $("inDate").value=todayStr(); }
  clearSelection();
  toast(msg);
  if(state.session.active){ const t=entryMode==="sealed"?$("selProduct"):$("selCard"); if(!t.disabled) t.focus(); }
}

/* ---------- Session d'achat ---------- */
function renderSession(){
  const s=state.session, on=!!s.active;
  $("sessionToggle").checked=on; $("sessionBox").classList.toggle("on",on); $("sessionPanel").hidden=!on;
  if(on){ $("sessionStats").innerHTML=`<b>${s.count}</b> article${s.count>1?"s":""} · <b>${fmt(s.spent)}</b> investis`;
    if(document.activeElement!==$("sessionTag")) $("sessionTag").value=s.label||""; }
}
$("sessionToggle").addEventListener("change",e=>{
  if(e.target.checked){ const d=new Date();
    state.session={active:true,label:`Session ${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}`,count:0,spent:0,startedAt:d.toISOString()};
    persist(); renderSession(); updateSuggest(); toast("Session d'achat démarrée");
  } else endSession();
});
$("sessionTag").addEventListener("input",e=>{ state.session.label=e.target.value.trim(); persist(); });
$("sessionEnd").addEventListener("click",endSession);
function endSession(){
  const s=state.session; if(!s.active){ renderSession(); return; }
  const recap=`Session terminée : ${s.count} article${s.count>1?"s":""}, ${fmt(s.spent)} investis`;
  state.session={active:false,label:"",count:0,spent:0}; persist(); renderSession(); toast(recap);
  if(s.label && s.count){ tagSel=s.label; renderList(); }        // montre directement les achats de la session
}

/* ---------- Filtres / recherche / tri ---------- */
document.querySelectorAll(".chip").forEach(ch=>ch.addEventListener("click",()=>{
  document.querySelectorAll(".chip").forEach(c=>c.setAttribute("aria-pressed","false"));
  ch.setAttribute("aria-pressed","true"); filter=ch.dataset.f; renderList(); }));
$("search").addEventListener("input",e=>{search=e.target.value.trim();renderList();});
$("sortBy").addEventListener("change",e=>{sortBy=e.target.value;renderList();});

/* ---------- Actions item ---------- */
let pendingId=null;
document.body.addEventListener("click",e=>{
  const b=e.target.closest("[data-act]"); if(!b)return; const id=b.dataset.id, act=b.dataset.act;
  if(act==="del") deleteItem(id);
  else if(act==="restore") restoreItem(id);
  else if(act==="purge") purgeItem(id);
  else if(act==="wbuy") buyFromWish(id);
  else if(act==="wdel") removeWish(id);
  else if(act==="list"){pendingId=id;openListModal(id);}
  else if(act==="sell"){pendingId=id;openSoldModal(id);}
  else if(act==="edit"){pendingId=id;openEditModal(id);}
  else if(act==="listing"){pendingId=id;openListingGen(id);}
});

/* ---------- Générateur d'annonce ---------- */
const condLabel={MT:"Mint",NM:"Near Mint",EX:"Excellent",GD:"Good",LP:"Light Played",PL:"Played",PO:"Poor"};
function slug(s){return String(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"");}
function openListingGen(id){
  const it=state.items.find(i=>i.id===id); if(!it) return;
  const c=it.catalog;
  const price=(it.listing?.askingPrice||suggestPrice(it.acquisition.purchasePrice,it.market?.ref));
  let title, body, tags;
  if(it.type==="sealed"){
    const etat = it.condition==="USED"?"Occasion (bon état)":"Neuf, scellé d'usine";
    title=`${c.name} — ${c.set.name} (${c.language.toUpperCase()})`;
    body=
`${c.name} — ${c.set.name}
État : ${etat}${it.quantity>1?`\nQuantité disponible : ${it.quantity}`:""}
Prix : ${fmt(price)}

Produit authentique, ${it.condition==="USED"?"soigné":"jamais ouvert"}. Envoi protégé et suivi possible. Remises groupées si plusieurs achats. Questions et photos supplémentaires bienvenues.`;
    tags=[`#${slug(c.name)}`,`#${slug(c.set.name)}`,"#pokemon","#pokemonscelle","#etb","#displaypokemon","#pokemontcg"].join(" ");
  } else {
    const gradeStr=it.grading?.company?` ${it.grading.company} ${it.grading.grade??""}`.trim():"";
    const varStr=(it.variant && it.variant!=="normal") ? " "+(VARIANT_LABEL[it.variant]||it.variant) : "";
    title=`${c.name} ${c.number}${varStr} — ${c.set.name}${gradeStr} (${c.language.toUpperCase()}, ${it.condition})`;
    body=
`${c.name} — ${c.set.name} (n°${c.number})
État : ${condLabel[it.condition]||it.condition}${gradeStr?` · Gradée ${gradeStr}`:""}
Langue : ${c.language.toUpperCase()}${it.quantity>1?`\nQuantité disponible : ${it.quantity}`:""}
Prix : ${fmt(price)}

Carte authentique, envoi soigné et protégé (toploader + pochette + envoi suivi possible). Remises groupées si plusieurs cartes achetées. N'hésite pas pour toute question ou photo supplémentaire.`;
    tags=[`#${slug(c.name)}`,`#${slug(c.set.name)}`,"#pokemon","#pokemontcg","#cartepokemon","#tcg","#pokemoncards",`#${it.condition.toLowerCase()}`].join(" ");
  }
  $("lgSub").textContent=`${c.name} · ${c.set.name}`;
  $("lgTitleField").value=title; $("lgBody").value=body; $("lgTags").value=tags;
  $("modalListing").classList.add("on");
}
$("lgCopy").addEventListener("click",async()=>{
  const txt=`${$("lgTitleField").value}\n\n${$("lgBody").value}\n\n${$("lgTags").value}`;
  try{ await navigator.clipboard.writeText(txt); toast("Annonce copiée"); }
  catch(e){ const t=$("lgBody"); t.focus(); t.select(); toast("Sélectionne et copie (Ctrl/Cmd+C)"); }
});

/* ---------- Frais par défaut ---------- */
function defaultFees(platform, totalValue){
  const f=state.settings.fees[platform]; if(!f) return {platformFee:0,shipping:0};
  return { platformFee:Math.round((totalValue*(f.pct||0)/100)*100)/100, shipping:f.flat||0 };
}
const KNOWN_PLACES=["Vinted","eBay","Cardmarket"];
function setPlace(selId,customId,wrapId,value){
  if(value&&!KNOWN_PLACES.includes(value)){$(selId).value="__custom";$(customId).value=value;$(wrapId).hidden=false;}
  else{$(selId).value=value||"Vinted";$(customId).value="";$(wrapId).hidden=true;}
}
function readPlatform(selId,customId){const v=$(selId).value;return v==="__custom"?($(customId).value.trim()||"Autre"):v;}

/* ---------- Modal mise en vente ---------- */
function openListModal(id){const it=state.items.find(i=>i.id===id);
  $("mlSub").textContent=`${it.catalog.name} · ${it.catalog.set.name} · acheté ${fmt(it.acquisition.purchasePrice)}`; $("mlPlatform").value="Vinted";$("mlCustom").value="";$("mlCustomWrap").hidden=true;
  $("mlNet").value=""; $("mlPrice").value = it.listing?.askingPrice>0 ? it.listing.askingPrice.toFixed(2) : "";
  updateListCalc(false); $("modalList").classList.add("on");}
function updateListCalc(fromNet){
  const it=state.items.find(i=>i.id===pendingId); if(!it) return;
  const v=$("mlPlatform").value, plat = v==="__custom" ? null : v, net=parseFloat($("mlNet").value);
  if(fromNet && net>=0){ const p = plat ? priceForNet(net,plat) : round2(net); if(p!=null) $("mlPrice").value=p.toFixed(2); }
  const price=parseFloat($("mlPrice").value)||0, fees=plat?feeFor(plat,price):0, recu=price-fees, marge=recu-it.acquisition.purchasePrice;
  $("mlCalc").innerHTML = price>0 ? `<div><span>Prix affiché</span><span>${fmt(price)}</span></div>
    <div><span>− Frais ${plat?esc(plat):"(lieu libre : non estimés)"}</span><span>${fmt(-fees)}</span></div>
    <div><span>= Tu touches</span><span>${fmt(recu)}</span></div>
    <div class="tot"><span>Marge par unité</span><span style="color:${marge>=0?"var(--sold)":"var(--loss)"}">${fmt(marge)}</span></div>
    ${marge<0?`<div style="color:var(--loss)">⚠ Sous ton coût de revient</div>`:""}`
    : `<div><span>Indique le net voulu ou directement le prix à afficher.</span></div>`;
}
$("mlPlatform").addEventListener("change",e=>{$("mlCustomWrap").hidden=e.target.value!=="__custom"; updateListCalc(true);});
$("mlNet").addEventListener("input",()=>updateListCalc(true));
$("mlPrice").addEventListener("input",()=>{ $("mlNet").value=""; updateListCalc(false); });
$("mlConfirm").addEventListener("click",()=>{const it=state.items.find(i=>i.id===pendingId);if(!it)return;
  const price=parseFloat($("mlPrice").value); if(price>0) it.listing.askingPrice=round2(price);
  it.status="listed"; it.listing.platform=readPlatform("mlPlatform","mlCustom"); it.listing.listedDate=it.listing.listedDate||todayStr();
  it.updatedAt=new Date().toISOString(); persist();closeModals();renderAll();toast("Mise en vente");});

/* ---------- Modal vendu ---------- */
function openSoldModal(id){const it=state.items.find(i=>i.id===id); const q=qtyOf(it);
  $("msSub").textContent=`${it.catalog.name} · achat ${fmt(it.acquisition.purchasePrice)} × ${q}`;
  $("msPrice").value=it.listing?.askingPrice||"";
  $("msQty").value=q; $("msQty").max=q;
  $("msQtyNote").hidden = q<=1;
  if(q>1) $("msQtyNote").textContent=`Lot de ${q}. Vends-en une partie : le reste reste en stock.`;
  setPlace("msPlatform","msCustom","msCustomWrap", it.listing?.platform);
  feeTouched=false; autoSoldFees();
  updateSoldCalc(); $("modalSold").classList.add("on");}
// Frais par défaut calculés sur la quantité VENDUE (et non sur tout le lot), tant que tu ne les modifies pas à la main
let feeTouched=false;
function autoSoldFees(){
  const it=state.items.find(i=>i.id===pendingId); if(!it || feeTouched) return;
  const plat=$("msPlatform").value; if(plat==="__custom") return;
  const qs=Math.min(qtyOf(it),Math.max(1,parseInt($("msQty").value)||1));
  const df=defaultFees(plat,(parseFloat($("msPrice").value)||0)*qs);
  $("msFee").value=df.platformFee||""; $("msShip").value=df.shipping||"";
}
$("msPlatform").addEventListener("change",e=>{ $("msCustomWrap").hidden=e.target.value!=="__custom";
  feeTouched=false; autoSoldFees(); updateSoldCalc(); });
["msPrice","msQty"].forEach(id=>$(id).addEventListener("input",autoSoldFees));
["msFee","msShip"].forEach(id=>$(id).addEventListener("input",()=>{ feeTouched=true; }));
function updateSoldCalc(){const it=state.items.find(i=>i.id===pendingId);if(!it)return;
  const q=Math.min(qtyOf(it),Math.max(1,parseInt($("msQty").value)||1));
  const price=(parseFloat($("msPrice").value)||0), fee=(parseFloat($("msFee").value)||0), ship=(parseFloat($("msShip").value)||0);
  const pa=it.acquisition.purchasePrice; const marge=(price-pa)*q-fee-ship; const roi=pa*q>0?marge/(pa*q)*100:0;
  $("msCalc").innerHTML=`<div><span>Vente ${q>1?"×"+q:""}</span><span>${fmt(price*q)}</span></div>
    <div><span>− Achat ${q>1?"×"+q:""}</span><span>${fmt(-pa*q)}</span></div>
    <div><span>− Frais</span><span>${fmt(-(fee+ship))}</span></div>
    <div class="tot"><span>Bénéfice net</span><span style="color:${marge>=0?'var(--sold)':'var(--loss)'}">${fmt(marge)} · ${pct(roi)}</span></div>`;}
["msPrice","msFee","msShip","msQty"].forEach(id=>$(id).addEventListener("input",updateSoldCalc));
$("msConfirm").addEventListener("click",()=>{const it=state.items.find(i=>i.id===pendingId);if(!it)return;
  const price=parseFloat($("msPrice").value); if(!(price>=0)){toast("Renseigne le prix réel");return;}
  const total=qtyOf(it); const soldQty=Math.min(total,Math.max(1,parseInt($("msQty").value)||1));
  const sale={soldPrice:price,currency,date:todayStr(),platform:readPlatform("msPlatform","msCustom"),
    fees:{platformFee:parseFloat($("msFee").value)||0,shipping:parseFloat($("msShip").value)||0}};
  if(soldQty>=total){ it.status="sold"; it.sale=sale; it.updatedAt=new Date().toISOString(); }
  else {
    // split : nouvel item vendu pour la partie écoulée, l'original garde le reste
    const soldItem=JSON.parse(JSON.stringify(it));
    soldItem.id="it_"+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
    soldItem.quantity=soldQty; soldItem.status="sold"; soldItem.sale=sale; soldItem.updatedAt=new Date().toISOString();
    it.quantity=total-soldQty; it.updatedAt=new Date().toISOString();
    state.items.push(soldItem);
    toast(`${soldQty} vendu(s), ${it.quantity} restant(s)`);
    persist();closeModals();renderAll(); return;
  }
  persist();closeModals();renderAll();toast("Vente archivée");});

/* ---------- Modal édition ---------- */
function toggleEditFields(s){$("meListedFields").hidden=s!=="listed";$("meSoldFields").hidden=s!=="sold";}
function openEditModal(id){const it=state.items.find(i=>i.id===id);if(!it)return;
  const sealed=it.type==="sealed";
  $("meCond").innerHTML = sealed?COND_SEALED:COND_CARD;
  $("meGradeRow").hidden = sealed; $("meVariantWrap").hidden = sealed; $("meVariant").value = it.variant||"";
  $("meTags").value=(it.tags||[]).join(", "); $("meNotes").value=it.notes||""; renderTagPicks();
  $("meSub").textContent=`${it.catalog.name} · ${it.catalog.set.name}${it.catalog.number?" · n°"+it.catalog.number:""}`;
  $("mePurchase").value=it.acquisition.purchasePrice??""; $("meQty").value=qtyOf(it); $("meCond").value=it.condition;
  $("meDate").value=it.acquisition.date||todayStr(); $("meLoc").value=it.location||""; $("meAsking").value=it.listing?.askingPrice??""; $("meStatus").value=it.status;
  $("meGradeCo").value=it.grading?.company||""; $("meGrade").value=it.grading?.grade??""; $("meGradeVal").value=it.grading?.gradedValue??"";
  mountPhoto(it.userPhoto);
  setPlace("meListPlatform","meListCustom","meListCustomWrap", it.listing?.platform);
  $("meSoldPrice").value=it.sale?.soldPrice??""; setPlace("meSoldPlatform","meSoldCustom","meSoldCustomWrap", it.sale?.platform||it.listing?.platform);
  $("meFee").value=it.sale?.fees?.platformFee??""; $("meShip").value=it.sale?.fees?.shipping??"";
  toggleEditFields(it.status); $("modalEdit").classList.add("on");}
$("meStatus").addEventListener("change",e=>toggleEditFields(e.target.value));
$("meListPlatform").addEventListener("change",e=>{$("meListCustomWrap").hidden=e.target.value!=="__custom";});
$("meSoldPlatform").addEventListener("change",e=>{$("meSoldCustomWrap").hidden=e.target.value!=="__custom";});
let editPhoto=null;
function mountPhoto(src){ editPhoto=src||null; const pv=$("mePhotoPv"); if(src){pv.src=src;pv.style.display="";}else{pv.removeAttribute("src");pv.style.display="none";} }
$("mePhotoClear").addEventListener("click",()=>mountPhoto(null));
$("mePhoto").addEventListener("change",e=>{const f=e.target.files[0];if(!f)return;downscale(f,500,(url)=>mountPhoto(url));e.target.value="";});
function downscale(file,max,cb){const r=new FileReader();r.onload=()=>{const im=new Image();im.onload=()=>{
  let w=im.width,h=im.height; if(w>h&&w>max){h=h*max/w;w=max;}else if(h>max){w=w*max/h;h=max;}
  const cv=document.createElement("canvas");cv.width=w;cv.height=h;cv.getContext("2d").drawImage(im,0,0,w,h);
  cb(cv.toDataURL("image/jpeg",0.82));};im.src=r.result;};r.readAsDataURL(file);}
$("meConfirm").addEventListener("click",()=>{const it=state.items.find(i=>i.id===pendingId);if(!it)return;
  const ns=$("meStatus").value;
  it.acquisition.purchasePrice=parseFloat($("mePurchase").value)||0;
  it.quantity=Math.max(1,parseInt($("meQty").value)||1);
  it.condition=$("meCond").value; it.acquisition.date=$("meDate").value||todayStr();
  it.location=$("meLoc").value.trim()||null;
  it.listing=it.listing||{currency}; it.listing.askingPrice=parseFloat($("meAsking").value)||0;
  it.userPhoto=editPhoto;
  it.tags=parseTags($("meTags").value); it.notes=$("meNotes").value.trim()||null;
  if(it.type==="card"){ const nv=$("meVariant").value||null;
    if(nv!==(it.variant||null)){ it.variant=nv; refreshItemMarket(it); } }
  const gc=$("meGradeCo").value; it.grading = gc ? {company:gc,grade:parseFloat($("meGrade").value)||null,gradedValue:parseFloat($("meGradeVal").value)||null} : null;
  if(ns==="stock"){it.sale=null;}
  else if(ns==="listed"){it.listing.platform=readPlatform("meListPlatform","meListCustom");it.listing.listedDate=it.listing.listedDate||todayStr();it.sale=null;}
  else if(ns==="sold"){const sp=parseFloat($("meSoldPrice").value);if(!(sp>=0)){toast("Renseigne le prix réel");return;}
    it.sale={soldPrice:sp,currency,date:it.sale?.date||todayStr(),platform:readPlatform("meSoldPlatform","meSoldCustom"),
      fees:{platformFee:parseFloat($("meFee").value)||0,shipping:parseFloat($("meShip").value)||0}};}
  it.status=ns; it.updatedAt=new Date().toISOString(); persist();closeModals();renderAll();toast("Modifications enregistrées");});

/* ---------- Étiquettes ---------- */
const TAG_SUGGEST=["à grader","réservé","à photographier","à expédier","lot"];
function parseTags(str){ const seen=new Set(), out=[];
  for(const raw of String(str||"").split(",")){ const t=raw.trim().slice(0,30); const k=t.toLowerCase();
    if(t && !seen.has(k)){ seen.add(k); out.push(t); } if(out.length>=12) break; }
  return out; }
function renderTagPicks(){
  const cur=parseTags($("meTags").value).map(t=>t.toLowerCase());
  const pool=[...new Set([...TAG_SUGGEST,...state.items.flatMap(i=>i.tags||[])])].slice(0,12);
  $("meTagPicks").innerHTML=pool.map(t=>`<button type="button" data-tag="${esc(t)}" aria-pressed="${cur.includes(t.toLowerCase())}">${esc(t)}</button>`).join("");
}
$("meTags").addEventListener("input",renderTagPicks);
$("meTagPicks").addEventListener("click",e=>{ const b=e.target.closest("[data-tag]"); if(!b) return;
  const t=b.dataset.tag, list=parseTags($("meTags").value), i=list.findIndex(x=>x.toLowerCase()===t.toLowerCase());
  if(i>=0) list.splice(i,1); else list.push(t);
  $("meTags").value=list.join(", "); renderTagPicks(); });
async function refreshItemMarket(it){          // après un changement de variante
  const m=await fetchMarket(it.catalog.cardId, it.variant);
  it.market=marketSnapshot(m); it.priceHistory=m?[{date:todayStr(),ref:m.ref}]:[];
  persist(); renderAll();
}

/* ---------- Corbeille (30 jours) ---------- */
function deleteItem(id){
  const i=state.items.findIndex(x=>x.id===id); if(i<0) return;
  const [it]=state.items.splice(i,1);
  state.trash.unshift({item:it, deletedAt:new Date().toISOString()});
  persist(); renderAll();
  toast(`« ${it.catalog.name} » est dans la corbeille`,{action:"Annuler", onAction:()=>restoreItem(id)});
}
function restoreItem(id){
  const i=state.trash.findIndex(t=>t.item.id===id); if(i<0) return;
  const [t]=state.trash.splice(i,1); state.items.push(t.item);
  persist(); renderAll(); if($("modalTrash").classList.contains("on")) renderTrash();
  toast(`« ${t.item.catalog.name} » restaurée`);
}
function purgeItem(id){
  const t=state.trash.find(x=>x.item.id===id); if(!t) return;
  if(!confirm(`Supprimer définitivement « ${t.item.catalog.name} » ? Cette action est irréversible.`)) return;
  state.trash=state.trash.filter(x=>x.item.id!==id); persist(); renderAll(); renderTrash();
}
function updateTrashCount(){ const n=state.trash.length; $("trashCount").textContent=n?n:""; }
function renderTrash(){
  const box=$("trashList");
  if(!state.trash.length){ box.innerHTML=`<div class="empty"><b>Corbeille vide</b>Les éléments supprimés apparaîtront ici pendant 30 jours.</div>`; return; }
  box.innerHTML="";
  state.trash.forEach(t=>{ const it=t.item, left=Math.max(0,TRASH_DAYS-Math.floor((Date.now()-new Date(t.deletedAt))/86400000));
    const r=document.createElement("div"); r.className="row-mini";
    r.innerHTML=`<div class="thumb"><img alt=""></div>
      <div><div class="name">${esc(it.catalog.name)}</div><div class="sub">${esc(it.catalog.set?.name)} · supprimée le ${new Date(t.deletedAt).toLocaleDateString("fr-FR")} · effacée dans ${left} j</div></div>
      <div class="acts"><button class="mini go" type="button" data-act="restore" data-id="${esc(it.id)}">Restaurer</button><button class="mini del" type="button" data-act="purge" data-id="${esc(it.id)}">Supprimer définitivement</button></div>`;
    mountImg(r.querySelector("img"), it.userPhoto||it.catalog.imageUrl, visualGen(it)); box.appendChild(r); });
}
$("btnTrash").addEventListener("click",()=>{ renderTrash(); $("modalTrash").classList.add("on"); });
$("trashEmpty").addEventListener("click",()=>{ if(!state.trash.length) return;
  if(!confirm(`Effacer définitivement les ${state.trash.length} élément(s) de la corbeille ?`)) return;
  state.trash=[]; persist(); renderAll(); renderTrash(); toast("Corbeille vidée"); });

/* ---------- Liste d'achats ---------- */
const wishHit=(w)=>w.market?.ref!=null && w.targetPrice>0 && w.market.ref<=w.targetPrice;
function updateWishCount(){
  const n=state.wishlist.length, hits=state.wishlist.filter(wishHit).length, el=$("wishCount");
  el.textContent = hits ? `${hits}/${n}` : n; el.classList.toggle("hot",hits>0);
  $("btnWish").title = hits ? `${hits} carte(s) au prix de ta cible ou moins` : "Cartes que tu veux acheter";
}
$("btnWishAdd").addEventListener("click",()=>{
  if(!selected || selected.sealed) return;
  const v=$("selVariant").value;
  $("waSub").textContent=`${selected.name} · ${selected.set.name}${v?" · "+VARIANT_LABEL[v]:""}${selMarket?.ref?" · marché "+fmt(selMarket.ref):""}`;
  $("waTarget").value = selMarket?.ref ? (Math.floor(selMarket.ref*0.8*100)/100).toFixed(2) : "";
  $("modalWishAdd").classList.add("on"); $("waTarget").focus();
});
$("waConfirm").addEventListener("click",()=>{
  const target=round2(parseFloat($("waTarget").value)); if(!(target>0)){ toast("Indique un prix cible"); return; }
  const v=$("selVariant").value||null, ex=state.wishlist.find(w=>w.cardId===selected.id && (w.variant||null)===v);
  if(ex){ ex.targetPrice=target; ex.market=marketSnapshot(selMarket); }
  else state.wishlist.push({id:newId("w_"), cardId:selected.id, name:selected.name, number:selected.number, set:selected.set,
    imageUrl:selected.imageUrl, variant:v, targetPrice:target, market:marketSnapshot(selMarket), createdAt:new Date().toISOString()});
  persist(); renderAll(); closeModals(); toast(ex?"Prix cible mis à jour":"Ajoutée à ta liste d'achats");
});
function renderWish(){
  const n=state.wishlist.length, hits=state.wishlist.filter(wishHit).length, box=$("wishList");
  $("wlSub").textContent = n ? `${n} carte${n>1?"s":""} surveillée${n>1?"s":""}${hits?` · ${hits} au prix de ta cible ou moins`:""}. Les prix se mettent à jour avec ↻.` : "";
  if(!n){ box.innerHTML=`<div class="empty"><b>Liste vide</b>Choisis une carte dans la saisie rapide puis « Ajouter à la liste d'achats ».</div>`; return; }
  box.innerHTML="";
  state.wishlist.forEach(w=>{ const hit=wishHit(w), r=document.createElement("div"); r.className="row-mini"+(hit?" hit":"");
    r.innerHTML=`<div class="thumb"><img alt=""></div>
      <div><div class="name">${esc(w.name)}${w.variant&&w.variant!=="normal"?` <span class="tag var">${esc(VARIANT_LABEL[w.variant]||w.variant)}</span>`:""}${hit?` <span class="tag at">Sous ta cible</span>`:""}</div>
        <div class="sub">${esc(w.set?.name)}${w.number?" · n°"+esc(w.number):""} · marché ${w.market?.ref!=null?fmt(w.market.ref):"inconnu"}</div>
        <div class="sub"><label>Cible <input class="money target" type="number" min="0" step="0.01" inputmode="decimal" data-wid="${esc(w.id)}" value="${w.targetPrice.toFixed(2)}" aria-label="Prix cible pour ${esc(w.name)}"></label></div></div>
      <div class="acts"><button class="mini go" type="button" data-act="wbuy" data-id="${esc(w.id)}">Je l'ai acheté</button><button class="mini del" type="button" data-act="wdel" data-id="${esc(w.id)}" aria-label="Retirer ${esc(w.name)}" title="Retirer">✕</button></div>`;
    mountImg(r.querySelector("img"), w.imageUrl, cardSVG(w.name,w.number,w.set?.name)); box.appendChild(r); });
}
$("wishList").addEventListener("change",e=>{ const inp=e.target.closest("[data-wid]"); if(!inp) return;
  const w=state.wishlist.find(x=>x.id===inp.dataset.wid), v=round2(parseFloat(inp.value)); if(!w || !(v>0)) return;
  w.targetPrice=v; persist(); updateWishCount(); inp.closest(".row-mini").classList.toggle("hit",wishHit(w)); });
$("btnWish").addEventListener("click",()=>{ renderWish(); $("modalWish").classList.add("on"); });
function removeWish(id){ state.wishlist=state.wishlist.filter(w=>w.id!==id); persist(); updateWishCount(); renderWish(); }
async function refreshWishlist(){ let ok=0;
  for(const w of state.wishlist){ const m=await fetchMarket(w.cardId,w.variant); if(m){ w.market=marketSnapshot(m); ok++; } }
  return ok; }
$("wishRefresh").addEventListener("click",async()=>{
  if(!state.wishlist.length) return; toast("Mise à jour des prix…");
  const ok=await refreshWishlist(); persist(); updateWishCount(); renderWish();
  const hits=state.wishlist.filter(wishHit).length;
  toast(ok ? (hits?`${hits} carte(s) au prix de ta cible ou moins`:"Prix à jour, aucune carte sous ta cible") : "Prix indisponibles (hors-ligne ?)");
});
async function buyFromWish(wid){
  const w=state.wishlist.find(x=>x.id===wid); if(!w) return;
  closeModals(); if(entryMode!=="card") applyMode("card");
  $("selCard").value=""; clearSelection();
  selected={id:w.cardId,name:w.name,number:w.number,language:"fr",set:w.set,imageUrl:w.imageUrl};
  pendingWishId=w.id; selMarket=w.market||null;
  $("inPurchase").value=w.targetPrice.toFixed(2);
  renderSelectedPreview(); renderMktBox(selMarket); validateForm(); updateSuggest();
  $("preview").scrollIntoView({behavior:"smooth",block:"center"});
  toast("Vérifie le prix payé puis ajoute au stock");
  const wid2=pendingWishId; await fillVariants(w.cardId, w.variant);
  pendingWishId=wid2;
}

/* ---------- Scanner v1.1 (dHash + code-barres) ---------- */
let camStream=null, barcodeDetector=null;
try{ if("BarcodeDetector" in window) barcodeDetector=new BarcodeDetector(); }catch(e){}
function dHash(ctx,w,h){ // 9x8 -> 64 bits
  const img=ctx.getImageData(0,0,w,h).data; const gray=[];
  for(let i=0;i<w*h;i++){gray.push(0.299*img[i*4]+0.587*img[i*4+1]+0.114*img[i*4+2]);}
  let bits=""; for(let y=0;y<8;y++)for(let x=0;x<8;x++){bits+=gray[y*9+x]<gray[y*9+x+1]?"0":"1";} return bits;
}
function hamming(a,b){let d=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i])d++;return d;}
function hashImage(url){return new Promise((res,rej)=>{const im=new Image();im.crossOrigin="anonymous";
  im.onload=()=>{try{const cv=document.createElement("canvas");cv.width=9;cv.height=8;const c=cv.getContext("2d");c.drawImage(im,0,0,9,8);res(dHash(c,9,8));}catch(e){rej(e);}};
  im.onerror=()=>rej(new Error("img"));im.src=url;});}
$("btnScan").addEventListener("click",async()=>{
  $("modalScan").classList.add("on"); $("scNote").textContent="";
  if(!$("selSet").value){ $("scNote").textContent="Sélectionne d'abord une série + un set : le scan reconnaît parmi les cartes de ce set."; }
  try{ camStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"}}); $("camView").srcObject=camStream; $("camView").play(); }
  catch(e){ $("scNote").textContent="Caméra indisponible ici. Elle fonctionnera dans la PWA installée sur ton téléphone."; $("camView").style.display="none"; }
});
$("scCapture").addEventListener("click",async()=>{
  const v=$("camView"); if(!v.videoWidth){ $("scNote").textContent="Pas de flux caméra."; return; }
  $("scNote").textContent="Analyse…";
  const cv=document.createElement("canvas"); cv.width=v.videoWidth; cv.height=v.videoHeight; const c=cv.getContext("2d"); c.drawImage(v,0,0);
  // 1) code-barres (surtout scellés)
  if(barcodeDetector){ try{ const codes=await barcodeDetector.detect(cv); if(codes.length){ $("scNote").textContent="Code-barres : "+codes[0].rawValue+" (utile pour les scellés)."; } }catch(e){} }
  // 2) hash perceptuel vs cartes du set
  const setId=$("selSet").value; if(!setId){ $("scNote").textContent="Choisis un set pour la reconnaissance visuelle."; return; }
  const small=document.createElement("canvas"); small.width=9; small.height=8; small.getContext("2d").drawImage(cv,0,0,9,8);
  const frameHash=dHash(small.getContext("2d"),9,8);
  const cards=await loadCards(setId); let best=null,bestD=99;
  for(const cd of cards){ const url=img(cd.image,"low"); if(!url)continue;
    try{ const h=await hashImage(url); const d=hamming(frameHash,h); if(d<bestD){bestD=d;best=cd;} }catch(e){} }
  if(best && bestD<=20){
    $("selCard").value=best.id; $("selCard").dispatchEvent(new Event("change"));
    $("scNote").textContent=`Reconnu : ${best.name} (n°${best.localId}) — distance ${bestD}. Vérifie puis renseigne le prix.`;
    setTimeout(closeModals,900);
  } else {
    $("scNote").textContent=best?`Pas de correspondance sûre (meilleure distance ${bestD}). Choisis manuellement.`:"Images du set inaccessibles ici (CORS) — reconnaissance dispo en local. Choisis manuellement.";
  }
});

/* ---------- Analyses ---------- */
function svgLineChart(points, color){ // points: [{x:Date-ish index, y:number}]
  const W=320,H=140,P=22; if(!points.length) return `<div style="color:var(--muted);font-size:12px;padding:20px 0;text-align:center">Pas encore de données</div>`;
  const ys=points.map(p=>p.y), maxY=Math.max(...ys,0), minY=Math.min(...ys,0);
  const spanY=(maxY-minY)||1, n=points.length;
  const X=i=>P+(n===1?0:(i*(W-2*P)/(n-1))); const Y=v=>H-P-((v-minY)/spanY)*(H-2*P);
  const d=points.map((p,i)=>`${i===0?"M":"L"}${X(i).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ");
  const zeroY=Y(0);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%"><line x1="${P}" y1="${zeroY}" x2="${W-P}" y2="${zeroY}" style="stroke:var(--line)"/>
    <path d="${d}" fill="none" style="stroke:${color}" stroke-width="2" stroke-linejoin="round"/>
    <text x="${P}" y="12" style="fill:var(--muted)" font-size="9" font-family="monospace">max ${fmtEUR(maxY)}</text></svg>`;
}
function bars(container, rows){ // rows:[{lbl,val,count}]
  const el=$(container); if(!rows.length){el.innerHTML=`<div style="color:var(--muted);font-size:12px">Pas de vente.</div>`;return;}
  const max=Math.max(...rows.map(r=>Math.abs(r.val)),1);
  el.innerHTML=rows.map(r=>`<div class="barrow"><span class="lbl">${esc(r.lbl)}${r.count?` (${r.count})`:""}</span>
    <div class="bartrack"><div class="barfill" style="width:${Math.max(4,Math.abs(r.val)/max*100)}%"></div></div>
    <span class="amt" style="color:${r.val>=0?'var(--sold)':'var(--loss)'}">${fmt(r.val)}</span></div>`).join("");
}
function renderTreso(){
  let out=0, inn=0, immo=0, pot=0;
  state.items.forEach(it=>{ const q=qtyOf(it), pa=it.acquisition.purchasePrice||0; out+=pa*q;
    if(it.status==="sold") inn+=(it.sale.soldPrice||0)*q-itemFees(it);
    else { immo+=pa*q; pot+=(it.listing?.askingPrice||0)*q; } });
  const bal=inn-out, cell=(l,v,col)=>`<div><span>${l}</span><b${col?` style="color:${col}"`:""}>${fmt(v)}</b></div>`;
  $("anTreso").innerHTML = cell("Argent sorti (achats)",out) + cell("Argent rentré (ventes nettes)",inn)
    + cell("Solde de trésorerie",bal,bal>=0?"var(--sold)":"var(--loss)") + cell("Immobilisé dans le stock",immo) + cell("Revente espérée du stock",pot);
  // flux des 6 derniers mois
  const now=new Date(), months=[];
  for(let k=5;k>=0;k--){ const d=new Date(now.getFullYear(),now.getMonth()-k,1); months.push({key:localISO(d).slice(0,7), lbl:d.toLocaleDateString("fr-FR",{month:"short"}), out:0, inn:0}); }
  const idx=Object.fromEntries(months.map((m,i)=>[m.key,i]));
  state.items.forEach(it=>{ const q=qtyOf(it), a=idx[monthOf(it.acquisition?.date)]; if(a!=null) months[a].out+=(it.acquisition.purchasePrice||0)*q;
    if(it.status==="sold"){ const s=idx[monthOf(it.sale?.date)]; if(s!=null) months[s].inn+=(it.sale.soldPrice||0)*q-itemFees(it); } });
  const max=Math.max(1,...months.flatMap(m=>[m.out,m.inn])), W=560, H=150, P=22, bw=(W-2*P)/months.length;
  const bars=months.map((m,i)=>{ const x=P+i*bw, h1=m.out/max*(H-2*P), h2=m.inn/max*(H-2*P);
    return `<rect x="${(x+bw*0.18).toFixed(1)}" y="${(H-P-h1).toFixed(1)}" width="${(bw*0.3).toFixed(1)}" height="${h1.toFixed(1)}" rx="3" style="fill:var(--pink)"><title>${m.lbl} : ${fmt(m.out)} sortis</title></rect>
      <rect x="${(x+bw*0.52).toFixed(1)}" y="${(H-P-h2).toFixed(1)}" width="${(bw*0.3).toFixed(1)}" height="${h2.toFixed(1)}" rx="3" style="fill:var(--sold)"><title>${m.lbl} : ${fmt(m.inn)} rentrés</title></rect>
      <text x="${(x+bw/2).toFixed(1)}" y="${H-6}" text-anchor="middle" font-size="11" style="fill:var(--muted)">${m.lbl}</text>`; }).join("");
  $("chartCash").innerHTML=`<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Argent sorti et rentré sur 6 mois"><line x1="${P}" y1="${H-P}" x2="${W-P}" y2="${H-P}" style="stroke:var(--line)"/>${bars}</svg>
    <div class="legend"><span><i style="background:var(--pink)"></i>Sorti (achats)</span><span><i style="background:var(--sold)"></i>Rentré (ventes nettes)</span></div>`;
}
function openAnalytics(){
  const sold=state.items.filter(i=>i.status==="sold");
  $("anSub").textContent = sold.length?`${sold.length} vente(s) analysée(s).`:"Aucune vente pour l'instant — les analyses se rempliront à mesure.";
  // vélocité
  const vel=$("anVelocity");
  if(sold.length){
    const ages=sold.map(stockAge).filter(a=>a!=null); const avgDays=ages.length?Math.round(ages.reduce((a,b)=>a+b,0)/ages.length):null;
    const annus=sold.map(roiAnnualized).filter(a=>a!=null); const bestAnnu=annus.length?Math.max(...annus):null;
    const active=state.items.filter(i=>i.status!=="sold"); const activeAges=active.map(stockAge).filter(a=>a!=null);
    const oldest=activeAges.length?Math.max(...activeAges):null;
    vel.innerHTML=`<div class="mrow"><span>Délai de vente moyen</span><span class="v">${avgDays!=null?avgDays+" j":"—"}</span></div>
      <div class="mrow"><span>Meilleur ROI annualisé</span><span class="v" style="color:var(--sold)">${bestAnnu!=null?fmtAnnu(bestAnnu):"—"}</span></div>
      <div class="mrow"><span>Plus vieille carte en stock</span><span class="v" style="color:${oldest>=30?'var(--loss)':'var(--text)'}">${oldest!=null?oldest+" j":"—"}</span></div>`;
  } else vel.innerHTML=`<div class="mrow"><span>Vélocité</span><span class="v" style="color:var(--muted)">en attente de ventes</span></div>`;
  renderTreso();
  // courbe bénéfice cumulé
  const byDate=sold.slice().sort((a,b)=>new Date(a.sale.date)-new Date(b.sale.date));
  let cum=0; const profitPts=byDate.map(it=>{cum+=realMargin(it);return {y:cum};});
  $("chartProfit").innerHTML=svgLineChart(profitPts,"var(--sold)");
  // courbe valeur stock dans le temps (événements achat/vente)
  const evts=[]; state.items.forEach(it=>{const q=qtyOf(it);
    if(it.acquisition?.date) evts.push({d:it.acquisition.date,v:(it.listing?.askingPrice||it.acquisition.purchasePrice)*q});
    if(it.status==="sold"&&it.sale?.date) evts.push({d:it.sale.date,v:-(it.listing?.askingPrice||it.acquisition.purchasePrice)*q});});
  evts.sort((a,b)=>new Date(a.d)-new Date(b.d)); let sv=0; const stockPts=evts.map(e=>{sv+=e.v;return {y:Math.max(0,sv)};});
  $("chartStock").innerHTML=svgLineChart(stockPts,"var(--lav)");
  // agrégations
  const grp=(keyFn)=>{const m={};sold.forEach(it=>{const k=keyFn(it)||"—";(m[k]=m[k]||{sum:0,n:0}).sum+=realMargin(it);m[k].n++;});
    return Object.entries(m).map(([lbl,o])=>({lbl,val:o.sum/o.n,count:o.n})).sort((a,b)=>b.val-a.val);};
  bars("byPlatform", grp(it=>it.sale?.platform));
  bars("bySet", grp(it=>it.catalog.set.name));
  bars("byCond", grp(it=>it.condition));
  const ranked=sold.map(it=>({lbl:`${it.catalog.name} (${it.catalog.set.name})`,val:realMargin(it)})).sort((a,b)=>b.val-a.val);
  bars("topWin", ranked.slice(0,5));
  bars("topFlop", ranked.slice(-5).reverse());
  $("modalAnalytics").classList.add("on");
}
$("btnAnalytics").addEventListener("click",openAnalytics);

/* ---------- Rafraîchir le marché (stock + en vente) ---------- */
$("btnRefresh").addEventListener("click",async()=>{
  const targets=state.items.filter(i=>i.status!=="sold"&&i.type!=="sealed"&&i.catalog.cardId);
  if(!targets.length && !state.wishlist.length){ toast("Aucune carte à mettre à jour (les scellés n'ont pas de prix en ligne)"); return; }
  const btn=$("btnRefresh"); btn.disabled=true; toast("Mise à jour du marché…"); let ok=0;
  try{
    for(const it of targets){
      const m=await fetchMarket(it.catalog.cardId, it.variant);
      if(m){ it.market=marketSnapshot(m); it.priceHistory=it.priceHistory||[];
        const d=todayStr(), h=it.priceHistory.find(x=>x.date===d);
        if(h) h.ref=m.ref; else it.priceHistory.push({date:d,ref:m.ref});      // 1 relevé par jour, le plus récent
        if(it.priceHistory.length>90) it.priceHistory=it.priceHistory.slice(-90);
        ok++; }
    }
    const okW=await refreshWishlist();
    persist(); renderAll();
    const hits=state.wishlist.filter(wishHit).length;
    if(!ok && !okW) toast("Marché indisponible (hors-ligne ?)");
    else toast(`Marché mis à jour (${ok}/${targets.length} cartes)`+(hits?` · ${hits} carte(s) de ta liste au prix de ta cible`:""));
  } finally { btn.disabled=false; }
});

/* ---------- Réglages ---------- */
function openSettings(){const s=state.settings; $("stGoal").value=s.monthlyGoal||0;
  $("stCoef").value=s.targetCoef;$("stUndercut").value=s.undercutPct;
  $("stVpct").value=s.fees.Vinted.pct;$("stEpct").value=s.fees.eBay.pct;$("stCpct").value=s.fees.Cardmarket.pct;
  $("stVflat").value=s.fees.Vinted.flat;$("stEflat").value=s.fees.eBay.flat;$("stCflat").value=s.fees.Cardmarket.flat;
  $("stFx").value=s.usdToEur; $("modalSettings").classList.add("on");}
$("btnSettings").addEventListener("click",openSettings);
$("stConfirm").addEventListener("click",()=>{const s=state.settings;
  s.monthlyGoal=Math.max(0,parseFloat($("stGoal").value)||0);
  s.targetCoef=parseFloat($("stCoef").value)||1.5; s.undercutPct=parseFloat($("stUndercut").value)||0; s.usdToEur=parseFloat($("stFx").value)||0.92;
  s.fees.Vinted={pct:parseFloat($("stVpct").value)||0,flat:parseFloat($("stVflat").value)||0};
  s.fees.eBay={pct:parseFloat($("stEpct").value)||0,flat:parseFloat($("stEflat").value)||0};
  s.fees.Cardmarket={pct:parseFloat($("stCpct").value)||0,flat:parseFloat($("stCflat").value)||0};
  persist();closeModals();updateSuggest();renderAll();toast("Réglages enregistrés");});

/* ---------- Modales fermeture ---------- */
function closeModals(){document.querySelectorAll(".scrim").forEach(s=>s.classList.remove("on"));
  if(camStream){camStream.getTracks().forEach(t=>t.stop());camStream=null;} const cv=$("camView");cv.style.display="";cv.srcObject=null;}
document.querySelectorAll("[data-close]").forEach(b=>b.addEventListener("click",closeModals));
document.querySelectorAll(".scrim").forEach(s=>s.addEventListener("click",e=>{if(e.target===s)closeModals();}));
document.addEventListener("keydown",e=>{if(e.key==="Escape")closeModals();});

/* ---------- Devise / Export / Import / Vider ---------- */
const IS_IOS=/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform==="MacIntel" && navigator.maxTouchPoints>1);
const IS_STANDALONE=(window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone===true;
function downloadBlob(blob,name){
  if(IS_IOS && navigator.canShare){            // iOS : un téléchargement dans l'app installée ouvre une vue sans retour possible
    try{ const f=new File([blob],name,{type:blob.type}); if(navigator.canShare({files:[f]})){ navigator.share({files:[f],title:name}).catch(()=>{}); return; } }catch(e){}
  }
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),4000);   // révocation différée : sinon Safari peut annuler le téléchargement
}
$("btnExport").addEventListener("click",()=>{
  downloadBlob(new Blob([JSON.stringify(state,null,2)],{type:"application/json"}),"flipdex-"+todayStr()+".json");
  toast("Export JSON téléchargé");
});

/* ---------- Export CSV (Excel FR : « ; », virgule décimale, BOM UTF-8) ---------- */
const csvNum=(n,d=2)=>(n==null||n===""||isNaN(n))?"":Number(n).toFixed(d).replace(".",",");
const csvText=(s)=>{ s=(s==null)?"":String(s); return /^[=+\-@\t\r]/.test(s) ? "'"+s : s; };  // neutralise l'injection de formules
const csvCell=(v)=>{ const s=String(v??""); return /[;"\r\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
function buildCSV(){
  const head=["ID","Type","Nom","Série","Set","Numéro","Variante","Langue","État","Quantité","Grading","Emplacement","Statut",
    "Date achat","Prix achat unitaire","Total achat","Prix indiqué unitaire","Lieu de vente","Date vente",
    "Prix vente unitaire","Frais plateforme","Frais envoi","Marge réelle","ROI %","Réf. marché","Étiquettes","Notes"];
  const stLbl={stock:"Stock",listed:"En vente",sold:"Vendu"};
  const condTxt=(c)=>({SEALED:"Neuf scellé",USED:"Occasion"})[c]||condLabel[c]||c||"";
  const rows=state.items.map(it=>{
    const q=qtyOf(it), sold=it.status==="sold", pa=it.acquisition?.purchasePrice||0;
    const grade=it.grading?.company ? (it.grading.company+" "+(it.grading.grade??"")).trim() : "";
    return [ csvText(it.id), it.type==="sealed"?"Scellé":"Carte", csvText(it.catalog.name), csvText(it.catalog.set?.series),
      csvText(it.catalog.set?.name), csvText(it.catalog.number), VARIANT_LABEL[it.variant]||"", (it.catalog.language||"").toUpperCase(), condTxt(it.condition),
      q, csvText(grade), csvText(it.location), stLbl[it.status]||it.status, it.acquisition?.date||"",
      csvNum(pa), csvNum(pa*q), csvNum(it.listing?.askingPrice),
      csvText(sold ? it.sale?.platform : it.listing?.platform), sold ? (it.sale?.date||"") : "",
      sold ? csvNum(it.sale?.soldPrice) : "", sold ? csvNum(it.sale?.fees?.platformFee||0) : "", sold ? csvNum(it.sale?.fees?.shipping||0) : "",
      sold ? csvNum(realMargin(it)) : "", sold ? csvNum(roiItem(it),1) : "", csvNum(it.market?.ref),
      csvText((it.tags||[]).join(", ")), csvText(it.notes) ];
  });
  return "\uFEFF"+[head,...rows].map(r=>r.map(csvCell).join(";")).join("\r\n")+"\r\n";
}
$("btnCSV").addEventListener("click",()=>{
  if(!state.items.length){ toast("Rien à exporter"); return; }
  downloadBlob(new Blob([buildCSV()],{type:"text/csv;charset=utf-8"}),"flipdex-"+todayStr()+".csv");
  toast("Export CSV téléchargé");
});
$("btnImport").addEventListener("click",()=>$("fileImport").click());
$("fileImport").addEventListener("change",e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();
  r.onload=()=>{try{const d=JSON.parse(r.result);if(!d||!Array.isArray(d.items))throw 0;state=normalizeState(d);
    persist();renderAll();renderSession();toast("Données importées");}
    catch(err){toast("Fichier JSON invalide");}};r.readAsText(f);e.target.value="";});
$("btnClear").addEventListener("click",()=>{ if(!state.items.length){ toast("Rien à vider"); return; }
  const n=state.items.length;
  if(!confirm(`Déplacer tes ${n} lignes (stock et historique) dans la corbeille ? Elles restent récupérables 30 jours.`)) return;
  const now=new Date().toISOString(), ids=state.items.map(i=>i.id);
  state.trash=[...state.items.map(item=>({item,deletedAt:now})),...state.trash]; state.items=[];
  persist(); renderAll();
  toast(`${n} lignes déplacées dans la corbeille`,{action:"Annuler", onAction:()=>{
    const back=state.trash.filter(t=>ids.includes(t.item.id)).map(t=>t.item);
    state.trash=state.trash.filter(t=>!ids.includes(t.item.id)); state.items.push(...back); persist(); renderAll(); toast("Données restaurées"); }});
});

/* ---------- Menu « Données » : fermeture après choix ou clic extérieur ---------- */
(()=>{ const m=$("dataMenu"); if(!m) return;
  const pop=m.querySelector(".menu-pop"), sum=m.querySelector("summary"), M=8;
  // Le menu est placé sous le bouton puis ramené dans l'écran s'il déborde (bouton à gauche sur mobile)
  function place(){
    if(!m.open){ pop.classList.remove("placed"); return; }
    const r=sum.getBoundingClientRect(), vw=document.documentElement.clientWidth, vh=window.innerHeight;
    pop.style.maxHeight=""; const w=pop.offsetWidth, h=pop.offsetHeight;
    const left=Math.max(M, Math.min(r.right-w, vw-w-M));
    let top=r.bottom+8; if(top+h>vh-M && r.top-8-h>=M) top=r.top-8-h;      // pas la place dessous : au-dessus
    pop.style.left=left+"px"; pop.style.top=top+"px"; pop.style.maxHeight=Math.max(120,vh-top-M)+"px";
    pop.classList.add("placed");
  }
  m.addEventListener("toggle",place);
  window.addEventListener("resize",place); window.addEventListener("scroll",place,{passive:true});
  m.querySelectorAll(".menu-pop button").forEach(b=>b.addEventListener("click",()=>{ m.open=false; }));
  document.addEventListener("click",e=>{ if(m.open && !m.contains(e.target)) m.open=false; });
  document.addEventListener("keydown",e=>{ if(e.key==="Escape" && m.open){ m.open=false; m.querySelector("summary").focus(); } });
})();

/* ---------- Toast ---------- */
let tT;
function toast(m, opt={}){
  const t=$("toast"); clearTimeout(tT); t.textContent="";
  const s=document.createElement("span"); s.textContent=m; t.appendChild(s);
  t.classList.toggle("has-action", !!opt.action);
  if(opt.action){ const b=document.createElement("button"); b.type="button"; b.textContent=opt.action;
    b.addEventListener("click",()=>{ clearTimeout(tT); t.classList.remove("on","has-action"); if(opt.onAction) opt.onAction(); });
    t.appendChild(b); }
  t.classList.add("on");
  tT=setTimeout(()=>t.classList.remove("on","has-action"), opt.ms || (opt.action?7000:2400));
}

/* ---------- Thème clair / sombre ---------- */
function applyTheme(t){
  const th = t || (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = th;
  const b=$("btnTheme"); if(b){ b.textContent = th==="dark" ? "☀" : "🌙"; b.setAttribute("aria-label", th==="dark"?"Passer en thème clair":"Passer en thème sombre"); }
  const m=document.querySelector('meta[name="theme-color"]'); if(m) m.content = th==="dark" ? "#170E21" : "#FFF4F8";
}
$("btnTheme").addEventListener("click",()=>{
  const next = document.documentElement.dataset.theme==="dark" ? "light" : "dark";
  state.settings.theme = next; persist(); applyTheme(next);
});

/* ---------- PWA : service worker, mise à jour, installation ---------- */
if("serviceWorker" in navigator && /^https?:$/.test(location.protocol)){
  const hadController=!!navigator.serviceWorker.controller;
  window.addEventListener("load",()=>{
    navigator.serviceWorker.register("./sw.js").then(reg=>{
      const offer=(w)=>{ if(!w) return; $("updateBar").hidden=false; $("btnUpdate").onclick=()=>w.postMessage({type:"SKIP_WAITING"}); };
      if(reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener("updatefound",()=>{ const nw=reg.installing; if(!nw) return;
        nw.addEventListener("statechange",()=>{ if(nw.state==="installed" && navigator.serviceWorker.controller) offer(nw); }); });
      document.addEventListener("visibilitychange",()=>{ if(document.visibilityState==="visible") reg.update().catch(()=>{}); });
    }).catch(err=>console.warn("Service worker non enregistré :",err));
  });
  let reloading=false;
  navigator.serviceWorker.addEventListener("controllerchange",()=>{
    if(!hadController || reloading) return;          // 1re installation : pas de rechargement inutile
    reloading=true; flushSave().finally(()=>location.reload());
  });
}
let installPrompt=null;
window.addEventListener("beforeinstallprompt",e=>{ e.preventDefault(); installPrompt=e; $("btnInstall").hidden=false; });
$("btnInstall").addEventListener("click",async()=>{
  if(!installPrompt) return; installPrompt.prompt();
  const {outcome}=await installPrompt.userChoice; installPrompt=null; $("btnInstall").hidden=true;
  if(outcome==="accepted") toast("FlipDex installée");
});
window.addEventListener("appinstalled",()=>{ installPrompt=null; $("btnInstall").hidden=true; });
// iPhone / iPad : pas de bouton d'installation automatique, on explique la marche à suivre
$("btnIosInstall").hidden = !(IS_IOS && !IS_STANDALONE);
$("btnIosInstall").addEventListener("click",()=>$("modalIos").classList.add("on"));
// Bloque le défilement de la page derrière une fenêtre ouverte (sinon la page glisse sous le doigt sur iPhone)
new MutationObserver(()=>document.documentElement.classList.toggle("modal-open", !!document.querySelector(".scrim.on")))
  .observe(document.body,{subtree:true,attributes:true,attributeFilter:["class"]});

/* ---------- Boot ---------- */
$("inDate").value=todayStr();
applyTheme(null);                       // thème système en attendant le chargement
initPickers();
(async()=>{
  state=normalizeState(await Store.load());
  storeReady=true;
  if(Store.recovered) flushSave();          // reprend les dernières modifications sauvées à la fermeture
  applyTheme(state.settings.theme);
  renderAll(); renderSession();
  if(Store.migrated) toast("Données transférées vers le nouveau stockage");
  if(navigator.storage && navigator.storage.persist){ navigator.storage.persist().catch(()=>{}); }  // limite l'effacement automatique
  document.documentElement.dataset.ready="1";
})();

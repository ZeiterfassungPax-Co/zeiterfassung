const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const DB_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DB_DIR, 'zeiterfassung.json');

function loadData() {
  if (fs.existsSync(DB_PATH)) {
    try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch(e) {}
  }
  return {
    users: [
      { id:'ma1',  name:'Anna Müller',   role:'ma',    soll_stunden:160, urlaub_anspruch:20 },
      { id:'ma2',  name:'Ben Schmidt',   role:'ma',    soll_stunden:160, urlaub_anspruch:20 },
      { id:'ma3',  name:'Clara Weber',   role:'ma',    soll_stunden:80,  urlaub_anspruch:10 },
      { id:'ma4',  name:'David Richter', role:'ma',    soll_stunden:160, urlaub_anspruch:20 },
      { id:'ma5',  name:'Eva Bauer',     role:'ma',    soll_stunden:160, urlaub_anspruch:20 },
      { id:'admin',name:'Administrator', role:'admin', soll_stunden:0,   urlaub_anspruch:0  },
    ],
    buchungen: [], antraege: [],
    settings: { pause6h:'30', pause9h:'45', firmaName:'Mein Unternehmen' },
    nextId: 1,
  };
}

function saveData() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(DATA, null, 2), 'utf8');
}

let DATA = loadData();
let nextId = DATA.nextId || 1;
function newId() { const id = nextId++; DATA.nextId = nextId; return id; }

const pad = n => String(n).padStart(2, '0');

function tagesauswertung(userId, monat) {
  const all = DATA.buchungen.filter(b => b.user_id === userId && b.ts.startsWith(monat));
  const byDate = {};
  all.forEach(b => { const d = b.ts.slice(0,10); if (!byDate[d]) byDate[d]=[]; byDate[d].push(b); });
  return Object.keys(byDate).sort().reverse().map(date => {
    const entries = byDate[date];
    const kommen  = entries.filter(b=>b.typ==='kommen').sort((a,b)=>a.ts<b.ts?-1:1);
    const gehen   = entries.filter(b=>b.typ==='gehen').sort((a,b)=>a.ts<b.ts?-1:1);
    const pStarts = entries.filter(b=>b.typ==='pause_start');
    const pEndes  = entries.filter(b=>b.typ==='pause_ende');
    const krank   = entries.find(b=>b.typ==='krank');
    const urlaub  = entries.find(b=>b.typ==='urlaub');
    if (krank)  return {date,ein:'',aus:'',pauseMin:0,netto:null,typ:'krank', kommentar:krank.kommentar,  nachbuchung:false};
    if (urlaub) return {date,ein:'',aus:'',pauseMin:0,netto:null,typ:'urlaub',kommentar:urlaub.kommentar, nachbuchung:false};
    let ein='',aus='',pauseMin=0,netto=null;
    if (kommen.length) ein = kommen[0].ts.slice(11,16);
    if (gehen.length)  aus = gehen[gehen.length-1].ts.slice(11,16);
    if (kommen.length && gehen.length) {
      const brutto = (new Date(gehen[gehen.length-1].ts) - new Date(kommen[0].ts)) / 3600000;
      pStarts.forEach((ps,i)=>{ if(pEndes[i]) pauseMin+=Math.round((new Date(pEndes[i].ts)-new Date(ps.ts))/60000); });
      netto = Math.max(0, Math.round((brutto - pauseMin/60)*100)/100);
    }
    const nb   = entries.some(b=>b.nachbuchung);
    const komm = entries.find(b=>b.typ==='kommen'&&b.kommentar);
    return {date,ein,aus,pauseMin,netto,typ:'normal',kommentar:komm?komm.kommentar:'',nachbuchung:nb};
  });
}

function monatsKonten(userId, monat) {
  const user = DATA.users.find(u=>u.id===userId);
  const tage = tagesauswertung(userId, monat);
  const istH  = Math.round(tage.reduce((s,t)=>s+(t.netto||0),0)*100)/100;
  const krank = tage.filter(t=>t.typ==='krank').length;
  const urlaubGenommen = DATA.antraege.filter(a=>a.user_id===userId&&a.status==='genehmigt'&&a.von.startsWith(monat)).reduce((s,a)=>s+a.tage,0);
  const soll = user?.soll_stunden||0;
  return { istH, saldo:Math.round((istH-soll)*100)/100, krank, urlaubGenommen, urlaubRest:(user?.urlaub_anspruch||0)-urlaubGenommen, soll };
}

function currentStatus(userId) {
  const today = new Date().toISOString().slice(0,10);
  const buch  = DATA.buchungen.filter(b=>b.user_id===userId&&b.ts.startsWith(today)).sort((a,b)=>a.ts<b.ts?1:-1);
  if (!buch.length) return {status:'aus',seit:null,inPause:false};
  const last = buch[0];
  if (last.typ==='kommen')      return {status:'ein',seit:last.ts.slice(11,16),inPause:false};
  if (last.typ==='pause_start') return {status:'ein',seit:null,inPause:true};
  if (last.typ==='pause_ende')  { const k=buch.find(b=>b.typ==='kommen'); return {status:'ein',seit:k?k.ts.slice(11,16):null,inPause:false}; }
  return {status:'aus',seit:null,inPause:false};
}

const curMonat = () => { const d=new Date(); return d.getFullYear()+'-'+pad(d.getMonth()+1); };

const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch(e) { clients.delete(res); } }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/events', (req,res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();
  res.write('event: connected\ndata: {}\n\n');
  clients.add(res);
  const ping = setInterval(()=>{ try{res.write(': ping\n\n');}catch(e){clients.delete(res);clearInterval(ping);} },25000);
  req.on('close',()=>{ clients.delete(res); clearInterval(ping); });
});

app.get('/api/users', (req,res) => res.json(DATA.users.map(u=>({id:u.id,name:u.name,role:u.role,soll_stunden:u.soll_stunden,urlaub_anspruch:u.urlaub_anspruch}))));
app.get('/api/users/:id/status', (req,res) => res.json(currentStatus(req.params.id)));

app.get('/api/anwesenheit', (req,res) => {
  const mk = curMonat();
  res.json(DATA.users.filter(u=>u.role==='ma').sort((a,b)=>a.name<b.name?-1:1).map(u=>({...u,status:currentStatus(u.id),konten:monatsKonten(u.id,mk)})));
});

app.get('/api/journal/:userId', (req,res) => {
  const mk = req.query.monat||curMonat();
  res.json({tage:tagesauswertung(req.params.userId,mk),konten:monatsKonten(req.params.userId,mk)});
});

app.post('/api/buchen', (req,res) => {
  const {userId,typ,kommentar} = req.body;
  if (!userId||!typ) return res.status(400).json({error:'Fehlt'});
  DATA.buchungen.push({id:newId(),user_id:userId,typ,ts:new Date().toISOString(),kommentar:kommentar||'',nachbuchung:false});
  saveData();
  const status = currentStatus(userId);
  broadcast('buchung',{userId,typ,status});
  res.json({ok:true,status});
});

app.post('/api/nachbuchen', (req,res) => {
  const {userId,datum,kommen,gehen,pauseMin,kommentar} = req.body;
  if (!userId||!datum||!kommen||!gehen) return res.status(400).json({error:'Fehlende Felder'});
  if (kommen>=gehen) return res.status(400).json({error:'Gehenzeit muss nach Kommenzeit liegen'});
  DATA.buchungen = DATA.buchungen.filter(b=>!(b.user_id===userId&&b.ts.startsWith(datum)));
  const ins=(typ,ts,komm)=>DATA.buchungen.push({id:newId(),user_id:userId,typ,ts,kommentar:komm||'',nachbuchung:true});
  ins('kommen',`${datum}T${kommen}:00.000Z`,kommentar||'Nachbuchung');
  if (parseInt(pauseMin)>0) {
    const [kh,km]=kommen.split(':').map(Number),[gh,gm]=gehen.split(':').map(Number);
    const mid=Math.floor((kh*60+km+gh*60+gm)/2),pe=mid+parseInt(pauseMin);
    ins('pause_start',`${datum}T${pad(Math.floor(mid/60))}:${pad(mid%60)}:00.000Z`,'');
    ins('pause_ende', `${datum}T${pad(Math.floor(pe/60))}:${pad(pe%60)}:00.000Z`,'');
  }
  ins('gehen',`${datum}T${gehen}:00.000Z`,'');
  saveData(); broadcast('nachbuchung',{userId,datum}); res.json({ok:true});
});

app.patch('/api/buchungen/kommentar', (req,res) => {
  const b=DATA.buchungen.find(b=>b.user_id===req.body.userId&&b.ts.startsWith(req.body.date)&&b.typ==='kommen');
  if(b) b.kommentar=req.body.kommentar||'';
  saveData(); res.json({ok:true});
});

app.delete('/api/buchungen/:userId/:date', (req,res) => {
  DATA.buchungen=DATA.buchungen.filter(b=>!(b.user_id===req.params.userId&&b.ts.startsWith(req.params.date)));
  saveData(); broadcast('loeschung',{userId:req.params.userId,date:req.params.date}); res.json({ok:true});
});

app.get('/api/antraege', (req,res) => {
  const alle=DATA.antraege.map(a=>({...a,userName:DATA.users.find(u=>u.id===a.user_id)?.name||'?'})).sort((a,b)=>a.ts<b.ts?1:-1);
  res.json(req.query.userId?alle.filter(a=>a.user_id===req.query.userId):alle);
});

app.post('/api/antraege', (req,res) => {
  const {userId,von,bis,tage,kommentar}=req.body;
  const id=newId();
  DATA.antraege.push({id,user_id:userId,von,bis,tage,status:'offen',kommentar:kommentar||'',ts:new Date().toISOString()});
  saveData(); broadcast('antrag_neu',{userId,id}); res.json({ok:true,id});
});

app.patch('/api/antraege/:id', (req,res) => {
  const {status}=req.body;
  if(!['genehmigt','abgelehnt'].includes(status)) return res.status(400).json({error:'Ungültig'});
  const a=DATA.antraege.find(a=>a.id===parseInt(req.params.id));
  if(a) a.status=status;
  saveData(); broadcast('antrag_update',{id:req.params.id,status}); res.json({ok:true});
});

app.get('/api/settings',(req,res)=>res.json(DATA.settings));
app.post('/api/settings',(req,res)=>{ Object.assign(DATA.settings,req.body); saveData(); res.json({ok:true}); });

app.post('/api/users',(req,res)=>{
  if(DATA.users.find(u=>u.id===req.body.id)) return res.status(409).json({error:'ID bereits vorhanden'});
  DATA.users.push({id:req.body.id,name:req.body.name,role:req.body.role||'ma',soll_stunden:req.body.soll_stunden||160,urlaub_anspruch:req.body.urlaub_anspruch||20});
  saveData(); broadcast('user_update',{}); res.json({ok:true});
});

app.patch('/api/users/:id',(req,res)=>{
  const u=DATA.users.find(u=>u.id===req.params.id);
  if(u){if(req.body.name)u.name=req.body.name;if(req.body.soll_stunden)u.soll_stunden=req.body.soll_stunden;if(req.body.urlaub_anspruch)u.urlaub_anspruch=req.body.urlaub_anspruch;}
  saveData(); broadcast('user_update',{}); res.json({ok:true});
});

app.post('/api/monatsabschluss',(req,res)=>{
  const {monat}=req.body; if(!monat) return res.status(400).json({error:'Monat fehlt'});
  DATA.buchungen=DATA.buchungen.filter(b=>!b.ts.startsWith(monat));
  saveData(); broadcast('monatsabschluss',{monat}); res.json({ok:true});
});

app.get('/api/export/csv',(req,res)=>{
  const mk=req.query.monat||curMonat();
  const users=req.query.userId?DATA.users.filter(u=>u.id===req.query.userId):DATA.users.filter(u=>u.role==='ma').sort((a,b)=>a.name<b.name?-1:1);
  const wt=['So','Mo','Di','Mi','Do','Fr','Sa'];
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="Zeiterfassung_${mk}.csv"`);
  let csv='\uFEFF'+'Mitarbeiter;Datum;Tag;Kommen;Gehen;Pause (min);Netto (h);Typ;Kommentar\n';
  users.forEach(u=>tagesauswertung(u.id,mk).forEach(t=>{
    const dw=wt[new Date(t.date+'T12:00:00').getDay()];
    csv+=`${u.name};${t.date.split('-').reverse().join('.')};${dw};${t.ein};${t.aus};${t.pauseMin};${t.netto!==null?t.netto.toFixed(2).replace('.',','):'0,00'};${t.typ};${t.kommentar}\n`;
  }));
  res.send(csv);
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,()=>console.log(`✓ Zeiterfassung läuft auf Port ${PORT}`));

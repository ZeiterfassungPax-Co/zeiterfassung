const express = require('express');
const path    = require('path');
const fs      = require('fs');
const bcrypt  = require('bcrypt');

const app  = express();
const PORT = process.env.PORT || 3000;
const SALT = 10;

const DB_DIR  = path.join(__dirname, 'data');
const DB_PATH = path.join(DB_DIR, 'zeiterfassung.json');

// ── Helpers ───────────────────────────────────────────────────────────────────
const pad     = n => String(n).padStart(2,'0');
const curMonat= () => { const d=new Date(); return d.getFullYear()+'-'+pad(d.getMonth()+1); };
const today   = () => new Date().toISOString().slice(0,10);

// ── Default-Daten ─────────────────────────────────────────────────────────────
function defaultData() {
  return {
    users: [
      {
        id:'admin', username:'admin', name:'Administrator', role:'admin',
        password_hash:null, soll_stunden:0, urlaub_anspruch:0,
        arbeitstage:[1,2,3,4,5]
      }
    ],
    buchungen:  [],
    antraege:   [],          // typ: 'urlaub' | 'korrektur'
    uebertraege: {},         // { "ma1:2025-01": { stunden: 5.5, urlaub: 2 } }
    settings: { pause6h:30, pause9h:45, firmaName:'Mein Unternehmen' },
    nextId: 1
  };
}

// ── DB laden / speichern ──────────────────────────────────────────────────────
function loadData() {
  if (fs.existsSync(DB_PATH)) {
    try { return JSON.parse(fs.readFileSync(DB_PATH,'utf8')); } catch(e) {}
  }
  return defaultData();
}

function saveData() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR,{recursive:true});
  fs.writeFileSync(DB_PATH, JSON.stringify(DATA,null,2),'utf8');
}

let DATA = loadData();

// Migration: fehlende Felder ergänzen
DATA.users.forEach(u => {
  if (!('username'    in u)) u.username     = u.id;
  if (!('arbeitstage' in u)) u.arbeitstage  = [1,2,3,4,5];
  if (!('password_hash' in u)) u.password_hash = null;
});
if (!DATA.uebertraege) DATA.uebertraege = {};
DATA.antraege.forEach(a => { if (!('typ' in a)) a.typ = 'urlaub'; });
saveData();

let nextId = DATA.nextId || 1;
function newId() { const id=nextId++; DATA.nextId=nextId; return id; }

// ── Safe User (kein Hash ans Frontend) ───────────────────────────────────────
function safeUser(u) {
  return {
    id: u.id, username: u.username, name: u.name, role: u.role,
    soll_stunden: u.soll_stunden, urlaub_anspruch: u.urlaub_anspruch,
    arbeitstage: u.arbeitstage, has_password: !!u.password_hash
  };
}

// ── Pausenberechnung (gesetzlich) ─────────────────────────────────────────────
function gesetzlichePause(bruttoH, settings) {
  if (bruttoH >= 9) return settings.pause9h || 45;
  if (bruttoH >= 6) return settings.pause6h || 30;
  return 0;
}

// ── Tagesauswertung ───────────────────────────────────────────────────────────
function tagesauswertung(userId, monat) {
  const all = DATA.buchungen.filter(b => b.user_id===userId && b.ts.startsWith(monat));
  const byDate = {};
  all.forEach(b => {
    const d = b.ts.slice(0,10);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(b);
  });

  const user     = DATA.users.find(u=>u.id===userId);
  const arbTage  = user?.arbeitstage || [1,2,3,4,5];
  const settings = DATA.settings;
  const todayStr = today();

  // alle Tage des Monats durchgehen
  const [year, mon] = monat.split('-').map(Number);
  const daysInMonth = new Date(year, mon, 0).getDate();
  const result = [];

  for (let day=1; day<=daysInMonth; day++) {
    const dateStr = `${monat}-${pad(day)}`;
    const dow     = new Date(dateStr+'T12:00:00').getDay(); // 0=So
    const istArbeitstag = arbTage.includes(dow);
    const entries = byDate[dateStr] || [];

    const krank  = entries.find(b=>b.typ==='krank');
    const urlaub = entries.find(b=>b.typ==='urlaub');

    if (krank) {
      result.push({date:dateStr,typ:'krank',ein:'',aus:'',pauseMin:0,netto:null,
        kommentar:krank.kommentar,nachbuchung:false,fehler:false});
      continue;
    }
    if (urlaub) {
      result.push({date:dateStr,typ:'urlaub',ein:'',aus:'',pauseMin:0,netto:null,
        kommentar:urlaub.kommentar,nachbuchung:false,fehler:false});
      continue;
    }
    if (!istArbeitstag) {
      result.push({date:dateStr,typ:'frei',ein:'',aus:'',pauseMin:0,netto:null,
        kommentar:'',nachbuchung:false,fehler:false});
      continue;
    }

    const kommen  = entries.filter(b=>b.typ==='kommen').sort((a,b)=>a.ts<b.ts?-1:1);
    const gehen   = entries.filter(b=>b.typ==='gehen' ).sort((a,b)=>a.ts<b.ts?-1:1);
    const pStarts = entries.filter(b=>b.typ==='pause_start');
    const pEndes  = entries.filter(b=>b.typ==='pause_ende');
    const nb      = entries.some(b=>b.nachbuchung);

    if (!kommen.length && dateStr <= todayStr) {
      // Arbeitstag in der Vergangenheit, keine Buchung → Fehler
      result.push({date:dateStr,typ:'fehler',ein:'',aus:'',pauseMin:0,netto:null,
        kommentar:'Keine Buchung',nachbuchung:false,fehler:true});
      continue;
    }
    if (!kommen.length) {
      // Zukünftiger Tag
      result.push({date:dateStr,typ:'offen',ein:'',aus:'',pauseMin:0,netto:null,
        kommentar:'',nachbuchung:false,fehler:false});
      continue;
    }

    const ein = kommen[0].ts.slice(11,16);
    let aus='', pauseMin=0, netto=null, fehler=false;

    if (!gehen.length && dateStr < todayStr) {
      // Kommen ohne Gehen → Fehler
      fehler = true;
      result.push({date:dateStr,typ:'fehler',ein,aus:'',pauseMin:0,netto:null,
        kommentar:'Kommen ohne Gehen',nachbuchung:nb,fehler:true});
      continue;
    }

    if (gehen.length) {
      aus = gehen[gehen.length-1].ts.slice(11,16);
      const bruttoH = (new Date(gehen[gehen.length-1].ts)-new Date(kommen[0].ts))/3600000;

      // Manuelle Pausen
      pStarts.forEach((ps,i)=>{
        if (pEndes[i]) pauseMin += Math.round((new Date(pEndes[i].ts)-new Date(ps.ts))/60000);
      });

      // Gesetzliche Mindestpause anwenden falls manuelle Pause zu klein
      const gesetzlich = gesetzlichePause(bruttoH, settings);
      if (pauseMin < gesetzlich) pauseMin = gesetzlich;

      netto = Math.max(0, Math.round((bruttoH - pauseMin/60)*100)/100);
    }

    const komm = entries.find(b=>b.typ==='kommen'&&b.kommentar);
    result.push({date:dateStr,typ:gehen.length?'normal':'aktiv',ein,aus,pauseMin,netto,
      kommentar:komm?komm.kommentar:'',nachbuchung:nb,fehler});
  }

  return result;
}

// ── Monatskonten ──────────────────────────────────────────────────────────────
function monatsKonten(userId, monat) {
  const user  = DATA.users.find(u=>u.id===userId);
  const tage  = tagesauswertung(userId, monat);
  const key   = `${userId}:${monat}`;
  const uebtr = DATA.uebertraege[key] || {stunden:0, urlaub:0};

  const istH  = Math.round(tage.reduce((s,t)=>s+(t.netto||0),0)*100)/100;
  const krank = tage.filter(t=>t.typ==='krank').length;
  const fehler= tage.filter(t=>t.typ==='fehler').length;

  const urlaubGenommen = DATA.antraege.filter(a =>
    a.user_id===userId && a.status==='genehmigt' && a.typ==='urlaub' &&
    a.von && a.von.startsWith(monat)
  ).reduce((s,a)=>s+(a.tage||0),0);

  const soll = user?.soll_stunden||0;
  const saldo = Math.round((istH - soll + uebtr.stunden)*100)/100;

  return {
    istH, soll, saldo,
    krank, fehler,
    urlaubGenommen,
    urlaubRest: (user?.urlaub_anspruch||0) - urlaubGenommen + uebtr.urlaub,
    uebertragStunden: uebtr.stunden,
    uebertragUrlaub:  uebtr.urlaub
  };
}

// ── Aktueller Status ──────────────────────────────────────────────────────────
function currentStatus(userId) {
  const todayStr = today();
  const buch = DATA.buchungen
    .filter(b=>b.user_id===userId && b.ts.startsWith(todayStr))
    .sort((a,b)=>a.ts<b.ts?1:-1);
  if (!buch.length) return {status:'aus',seit:null,inPause:false};
  const last = buch[0];
  if (last.typ==='kommen')      return {status:'ein',seit:last.ts.slice(11,16),inPause:false};
  if (last.typ==='pause_start') return {status:'ein',seit:null,inPause:true};
  if (last.typ==='pause_ende')  {
    const k=buch.find(b=>b.typ==='kommen');
    return {status:'ein',seit:k?k.ts.slice(11,16):null,inPause:false};
  }
  return {status:'aus',seit:null,inPause:false};
}

// ── SSE Broadcast ─────────────────────────────────────────────────────────────
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch(e) { clients.delete(res); } }
}

// ── Express Setup ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));

// ── ERSTEINRICHTUNG ───────────────────────────────────────────────────────────
app.get('/api/setup/needed', (req,res) => {
  const admin = DATA.users.find(u=>u.role==='admin');
  res.json({needed: !admin?.password_hash});
});

app.post('/api/setup', async (req,res) => {
  const admin = DATA.users.find(u=>u.role==='admin');
  if (admin?.password_hash) return res.status(403).json({error:'Setup bereits abgeschlossen.'});
  const {password} = req.body;
  if (!password||password.length<4) return res.status(400).json({error:'Mindestens 4 Zeichen.'});
  admin.password_hash = await bcrypt.hash(password, SALT);
  saveData();
  res.json({ok:true});
});

// ── LOGIN ─────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req,res) => {
  const {username, password} = req.body;
  if (!username||!password) return res.status(400).json({error:'Benutzername und Passwort erforderlich.'});
  const user = DATA.users.find(u=>u.username.toLowerCase()===username.trim().toLowerCase());
  if (!user) return res.status(401).json({error:'Ungültiger Benutzername oder Passwort.'});
  if (!user.password_hash) return res.status(401).json({error:'Kein Passwort gesetzt. Admin kontaktieren.'});
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({error:'Ungültiger Benutzername oder Passwort.'});
  res.json({ok:true, user:safeUser(user)});
});

// ── USERS ─────────────────────────────────────────────────────────────────────
app.get('/api/users', (req,res) => res.json(DATA.users.map(safeUser)));
app.get('/api/users/:id/status', (req,res) => res.json(currentStatus(req.params.id)));

app.post('/api/users', async (req,res) => {
  const {id,username,name,role,soll_stunden,urlaub_anspruch,arbeitstage,password} = req.body;
  if (DATA.users.find(u=>u.id===id)) return res.status(409).json({error:'ID bereits vorhanden.'});
  if (DATA.users.find(u=>u.username===username)) return res.status(409).json({error:'Benutzername bereits vergeben.'});
  if (!password||password.length<4) return res.status(400).json({error:'Passwort mind. 4 Zeichen.'});
  const hash = await bcrypt.hash(password, SALT);
  DATA.users.push({
    id, username, name, role:role||'ma',
    soll_stunden:soll_stunden||160,
    urlaub_anspruch:urlaub_anspruch||20,
    arbeitstage:arbeitstage||[1,2,3,4,5],
    password_hash:hash
  });
  saveData(); broadcast('user_update',{}); res.json({ok:true});
});

app.patch('/api/users/:id', async (req,res) => {
  const u = DATA.users.find(u=>u.id===req.params.id);
  if (!u) return res.status(404).json({error:'Nicht gefunden.'});
  if (req.body.username !== undefined) {
    const dup = DATA.users.find(x=>x.username===req.body.username && x.id!==u.id);
    if (dup) return res.status(409).json({error:'Benutzername bereits vergeben.'});
    u.username = req.body.username;
  }
  if (req.body.name        !== undefined) u.name         = req.body.name;
  if (req.body.soll_stunden!== undefined) u.soll_stunden = req.body.soll_stunden;
  if (req.body.urlaub_anspruch!==undefined) u.urlaub_anspruch = req.body.urlaub_anspruch;
  if (req.body.arbeitstage !== undefined) u.arbeitstage  = req.body.arbeitstage;
  if (req.body.password) u.password_hash = await bcrypt.hash(req.body.password, SALT);
  saveData(); broadcast('user_update',{}); res.json({ok:true});
});

// ── ANWESENHEIT ───────────────────────────────────────────────────────────────
app.get('/api/anwesenheit', (req,res) => {
  const mk = curMonat();
  res.json(DATA.users.filter(u=>u.role==='ma').sort((a,b)=>a.name<b.name?-1:1).map(u=>({
    ...safeUser(u), status:currentStatus(u.id), konten:monatsKonten(u.id,mk)
  })));
});

// ── JOURNAL / KALENDER ────────────────────────────────────────────────────────
app.get('/api/journal/:userId', (req,res) => {
  const mk = req.query.monat||curMonat();
  res.json({tage:tagesauswertung(req.params.userId,mk), konten:monatsKonten(req.params.userId,mk)});
});

// ── BUCHUNGEN ─────────────────────────────────────────────────────────────────
app.post('/api/buchen', (req,res) => {
  const {userId,typ,kommentar} = req.body;
  if (!userId||!typ) return res.status(400).json({error:'Fehlt.'});
  DATA.buchungen.push({id:newId(),user_id:userId,typ,ts:new Date().toISOString(),kommentar:kommentar||'',nachbuchung:false});
  saveData();
  const status = currentStatus(userId);
  broadcast('buchung',{userId,typ,status});
  res.json({ok:true,status});
});

app.post('/api/nachbuchen', (req,res) => {
  const {userId,datum,kommen,gehen,pauseMin,kommentar} = req.body;
  if (!userId||!datum||!kommen||!gehen) return res.status(400).json({error:'Fehlende Felder.'});
  if (kommen>=gehen) return res.status(400).json({error:'Gehenzeit muss nach Kommenzeit liegen.'});
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

// ── ANTRÄGE (Urlaub + Korrektur) ──────────────────────────────────────────────
app.get('/api/antraege', (req,res) => {
  let alle = DATA.antraege.map(a=>({...a, userName:DATA.users.find(u=>u.id===a.user_id)?.name||'?'}))
    .sort((a,b)=>a.ts<b.ts?1:-1);
  if (req.query.userId) alle = alle.filter(a=>a.user_id===req.query.userId);
  if (req.query.typ)    alle = alle.filter(a=>a.typ===req.query.typ);
  res.json(alle);
});

app.post('/api/antraege', (req,res) => {
  const {userId,typ,von,bis,tage,datum,kommen,gehen,pauseMin,kommentar} = req.body;
  const id = newId();
  DATA.antraege.push({
    id, user_id:userId, typ:typ||'urlaub', status:'offen',
    von:von||null, bis:bis||null, tage:tage||null,
    datum:datum||null, kommen:kommen||null, gehen:gehen||null, pauseMin:pauseMin||0,
    kommentar:kommentar||'', ts:new Date().toISOString()
  });
  saveData(); broadcast('antrag_neu',{userId,id,typ}); res.json({ok:true,id});
});

app.patch('/api/antraege/:id', (req,res) => {
  const {status} = req.body;
  if (!['genehmigt','abgelehnt'].includes(status)) return res.status(400).json({error:'Ungültig.'});
  const a = DATA.antraege.find(a=>a.id===parseInt(req.params.id));
  if (!a) return res.status(404).json({error:'Nicht gefunden.'});
  a.status = status;

  // Bei genehmigter Korrektur: direkt nachbuchen
  if (status==='genehmigt' && a.typ==='korrektur' && a.datum && a.kommen && a.gehen) {
    DATA.buchungen = DATA.buchungen.filter(b=>!(b.user_id===a.user_id&&b.ts.startsWith(a.datum)));
    const ins=(typ,ts)=>DATA.buchungen.push({id:newId(),user_id:a.user_id,typ,ts,kommentar:'Korrekturantrag genehmigt',nachbuchung:true});
    ins('kommen',`${a.datum}T${a.kommen}:00.000Z`);
    if (parseInt(a.pauseMin)>0) {
      const [kh,km]=a.kommen.split(':').map(Number),[gh,gm]=a.gehen.split(':').map(Number);
      const mid=Math.floor((kh*60+km+gh*60+gm)/2),pe=mid+parseInt(a.pauseMin);
      const pp=n=>pad(Math.floor(n/60))+':'+pad(n%60);
      ins('pause_start',`${a.datum}T${pp(mid)}:00.000Z`);
      ins('pause_ende', `${a.datum}T${pp(pe)}:00.000Z`);
    }
    ins('gehen',`${a.datum}T${a.gehen}:00.000Z`);
  }

  // Bei genehmigtem Urlaub: Buchung eintragen
  if (status==='genehmigt' && a.typ==='urlaub' && a.von && a.bis) {
    let cur = new Date(a.von);
    const end = new Date(a.bis);
    const user = DATA.users.find(u=>u.id===a.user_id);
    const arbTage = user?.arbeitstage||[1,2,3,4,5];
    while (cur<=end) {
      const dow = cur.getDay();
      if (arbTage.includes(dow)) {
        const ds = cur.toISOString().slice(0,10);
        DATA.buchungen = DATA.buchungen.filter(b=>!(b.user_id===a.user_id&&b.ts.startsWith(ds)));
        DATA.buchungen.push({id:newId(),user_id:a.user_id,typ:'urlaub',ts:`${ds}T00:00:00.000Z`,kommentar:'Urlaub genehmigt',nachbuchung:false});
      }
      cur.setDate(cur.getDate()+1);
    }
  }

  saveData(); broadcast('antrag_update',{id:req.params.id,status,typ:a.typ}); res.json({ok:true});
});

// ── ÜBERTRAG / STUNDENKONTO ───────────────────────────────────────────────────
app.get('/api/uebertrag/:userId/:monat', (req,res) => {
  const key = `${req.params.userId}:${req.params.monat}`;
  res.json(DATA.uebertraege[key]||{stunden:0,urlaub:0});
});

app.post('/api/uebertrag/:userId/:monat', (req,res) => {
  const key = `${req.params.userId}:${req.params.monat}`;
  DATA.uebertraege[key] = {
    stunden: parseFloat(req.body.stunden)||0,
    urlaub:  parseInt(req.body.urlaub)||0
  };
  saveData(); res.json({ok:true});
});

// Monatsabschluss: Saldo automatisch in nächsten Monat übertragen
app.post('/api/monatsabschluss', (req,res) => {
  const {monat} = req.body;
  if (!monat) return res.status(400).json({error:'Monat fehlt.'});

  // Für alle MAs Saldo berechnen und in nächsten Monat übertragen
  const [y,m] = monat.split('-').map(Number);
  const nextDate = new Date(y, m, 1);
  const nextMonat = nextDate.getFullYear()+'-'+pad(nextDate.getMonth()+1);

  DATA.users.filter(u=>u.role==='ma').forEach(u => {
    const konten = monatsKonten(u.id, monat);
    const nextKey = `${u.id}:${nextMonat}`;
    const existing = DATA.uebertraege[nextKey]||{stunden:0,urlaub:0};
    DATA.uebertraege[nextKey] = {
      stunden: Math.round((existing.stunden + konten.saldo)*100)/100,
      urlaub:  existing.urlaub
    };
  });

  saveData(); broadcast('monatsabschluss',{monat}); res.json({ok:true});
});

// ── SETTINGS ──────────────────────────────────────────────────────────────────
app.get('/api/settings', (req,res) => res.json(DATA.settings));
app.post('/api/settings', (req,res) => { Object.assign(DATA.settings,req.body); saveData(); res.json({ok:true}); });

// ── EXPORT CSV ────────────────────────────────────────────────────────────────
app.get('/api/export/csv', (req,res) => {
  const mk    = req.query.monat||curMonat();
  const users = req.query.userId
    ? DATA.users.filter(u=>u.id===req.query.userId)
    : DATA.users.filter(u=>u.role==='ma').sort((a,b)=>a.name<b.name?-1:1);
  const wt = ['So','Mo','Di','Mi','Do','Fr','Sa'];
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="Zeiterfassung_${mk}.csv"`);
  let csv = '\uFEFF'+'Mitarbeiter;Datum;Tag;Kommen;Gehen;Pause (min);Netto (h);Typ;Kommentar\n';
  users.forEach(u => tagesauswertung(u.id,mk).forEach(t => {
    const dw = wt[new Date(t.date+'T12:00:00').getDay()];
    csv += `${u.name};${t.date.split('-').reverse().join('.')};${dw};${t.ein};${t.aus};`+
           `${t.pauseMin};${t.netto!==null?t.netto.toFixed(2).replace('.',','):'0,00'};`+
           `${t.typ};${t.kommentar}\n`;
  }));
  res.send(csv);
});

// ── SSE ───────────────────────────────────────────────────────────────────────
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

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT, () => console.log(`✓ Zeiterfassung läuft auf Port ${PORT}`));

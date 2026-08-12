const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Datenbank ─────────────────────────────────────────────────────────────────
const DB_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(path.join(DB_DIR, 'zeiterfassung.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'ma',
    soll_stunden INTEGER NOT NULL DEFAULT 160,
    urlaub_anspruch INTEGER NOT NULL DEFAULT 20
  );
  CREATE TABLE IF NOT EXISTS buchungen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    typ TEXT NOT NULL,
    ts TEXT NOT NULL,
    kommentar TEXT DEFAULT '',
    nachbuchung INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS antraege (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    von TEXT NOT NULL,
    bis TEXT NOT NULL,
    tage INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'offen',
    kommentar TEXT DEFAULT '',
    ts TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );
`);

// Standarddaten
[['pause6h','30'],['pause9h','45'],['firmaName','Mein Unternehmen']].forEach(([k,v]) =>
  db.prepare('INSERT OR IGNORE INTO settings(k,v) VALUES(?,?)').run(k,v));

if (!db.prepare('SELECT COUNT(*) as n FROM users').get().n) {
  const ins = db.prepare('INSERT INTO users(id,name,role,soll_stunden,urlaub_anspruch) VALUES(?,?,?,?,?)');
  [['ma1','Anna Müller','ma',160,20],['ma2','Ben Schmidt','ma',160,20],
   ['ma3','Clara Weber','ma',80,10],['ma4','David Richter','ma',160,20],
   ['ma5','Eva Bauer','ma',160,20],['admin','Administrator','admin',0,0]
  ].forEach(u => ins.run(...u));
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────
const pad = n => String(n).padStart(2,'0');

function tagesauswertung(userId, monat) {
  const all = db.prepare("SELECT * FROM buchungen WHERE user_id=? AND ts LIKE ? ORDER BY ts ASC").all(userId, monat+'%');
  const byDate = {};
  all.forEach(b => { const d=b.ts.slice(0,10); if(!byDate[d]) byDate[d]=[]; byDate[d].push(b); });
  return Object.keys(byDate).sort().reverse().map(date => {
    const entries = byDate[date];
    const kommen = entries.filter(b=>b.typ==='kommen').sort((a,b)=>a.ts<b.ts?-1:1);
    const gehen  = entries.filter(b=>b.typ==='gehen').sort((a,b)=>a.ts<b.ts?-1:1);
    const pStarts= entries.filter(b=>b.typ==='pause_start');
    const pEndes = entries.filter(b=>b.typ==='pause_ende');
    const krank  = entries.find(b=>b.typ==='krank');
    const urlaub = entries.find(b=>b.typ==='urlaub');
    if (krank)  return {date,ein:'',aus:'',pauseMin:0,netto:null,typ:'krank', kommentar:krank.kommentar, nachbuchung:false};
    if (urlaub) return {date,ein:'',aus:'',pauseMin:0,netto:null,typ:'urlaub',kommentar:urlaub.kommentar,nachbuchung:false};
    let ein='',aus='',pauseMin=0,netto=null;
    if (kommen.length) ein = kommen[0].ts.slice(11,16);
    if (gehen.length)  aus = gehen[gehen.length-1].ts.slice(11,16);
    if (kommen.length && gehen.length) {
      const brutto = (new Date(gehen[gehen.length-1].ts) - new Date(kommen[0].ts)) / 3600000;
      pStarts.forEach((ps,i) => { if(pEndes[i]) pauseMin += Math.round((new Date(pEndes[i].ts)-new Date(ps.ts))/60000); });
      netto = Math.max(0, Math.round((brutto - pauseMin/60)*100)/100);
    }
    const nb   = entries.some(b=>b.nachbuchung);
    const komm = entries.find(b=>b.typ==='kommen'&&b.kommentar);
    return {date,ein,aus,pauseMin,netto,typ:'normal',kommentar:komm?komm.kommentar:'',nachbuchung:nb};
  });
}

function monatsKonten(userId, monat) {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  const tage = tagesauswertung(userId, monat);
  const istH  = Math.round(tage.reduce((s,t)=>s+(t.netto||0),0)*100)/100;
  const krank = tage.filter(t=>t.typ==='krank').length;
  const urlaubGenommen = db.prepare("SELECT COALESCE(SUM(tage),0) as s FROM antraege WHERE user_id=? AND status='genehmigt' AND von LIKE ?").get(userId,monat+'%').s;
  const soll = user?.soll_stunden||0;
  return { istH, saldo: Math.round((istH-soll)*100)/100, krank, urlaubGenommen, urlaubRest:(user?.urlaub_anspruch||0)-urlaubGenommen, soll };
}

function currentStatus(userId) {
  const today = new Date().toISOString().slice(0,10);
  const buch  = db.prepare('SELECT * FROM buchungen WHERE user_id=? AND ts LIKE ? ORDER BY ts DESC').all(userId, today+'%');
  if (!buch.length) return {status:'aus',seit:null,inPause:false};
  const last = buch[0];
  if (last.typ==='kommen')      return {status:'ein',seit:last.ts.slice(11,16),inPause:false};
  if (last.typ==='pause_start') return {status:'ein',seit:null,inPause:true};
  if (last.typ==='pause_ende')  { const k=buch.find(b=>b.typ==='kommen'); return {status:'ein',seit:k?k.ts.slice(11,16):null,inPause:false}; }
  return {status:'aus',seit:null,inPause:false};
}

const curMonat = () => { const d=new Date(); return d.getFullYear()+'-'+pad(d.getMonth()+1); };

// ── SSE Echtzeit ──────────────────────────────────────────────────────────────
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch(e) { clients.delete(res); } }
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── SSE ───────────────────────────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();
  res.write('event: connected\ndata: {}\n\n');
  clients.add(res);
  const ping = setInterval(()=>{ try{res.write(': ping\n\n');}catch(e){clients.delete(res);clearInterval(ping);} },25000);
  req.on('close', ()=>{ clients.delete(res); clearInterval(ping); });
});

// ── API ───────────────────────────────────────────────────────────────────────
app.get('/api/users', (req,res) => res.json(db.prepare('SELECT id,name,role,soll_stunden,urlaub_anspruch FROM users ORDER BY role DESC,name').all()));
app.get('/api/users/:id/status', (req,res) => res.json(currentStatus(req.params.id)));

app.get('/api/anwesenheit', (req,res) => {
  const mk  = curMonat();
  const mas = db.prepare("SELECT * FROM users WHERE role='ma' ORDER BY name").all();
  res.json(mas.map(u => ({...u, status:currentStatus(u.id), konten:monatsKonten(u.id,mk)})));
});

app.get('/api/journal/:userId', (req,res) => {
  const mk = req.query.monat||curMonat();
  res.json({ tage:tagesauswertung(req.params.userId,mk), konten:monatsKonten(req.params.userId,mk) });
});

app.post('/api/buchen', (req,res) => {
  const {userId,typ,kommentar} = req.body;
  if (!userId||!typ) return res.status(400).json({error:'Fehlt'});
  db.prepare('INSERT INTO buchungen(user_id,typ,ts,kommentar,nachbuchung) VALUES(?,?,?,?,0)').run(userId,typ,new Date().toISOString(),kommentar||'');
  const status = currentStatus(userId);
  broadcast('buchung',{userId,typ,status});
  res.json({ok:true,status});
});

app.post('/api/nachbuchen', (req,res) => {
  const {userId,datum,kommen,gehen,pauseMin,kommentar} = req.body;
  if (!userId||!datum||!kommen||!gehen) return res.status(400).json({error:'Fehlende Felder'});
  if (kommen>=gehen) return res.status(400).json({error:'Gehenzeit muss nach Kommenzeit liegen'});
  db.prepare('DELETE FROM buchungen WHERE user_id=? AND ts LIKE ?').run(userId,datum+'%');
  const ins = db.prepare('INSERT INTO buchungen(user_id,typ,ts,kommentar,nachbuchung) VALUES(?,?,?,?,1)');
  ins.run(userId,'kommen',`${datum}T${kommen}:00.000Z`,kommentar||'Nachbuchung');
  if (parseInt(pauseMin)>0) {
    const [kh,km]=kommen.split(':').map(Number),[gh,gm]=gehen.split(':').map(Number);
    const mid=Math.floor((kh*60+km+gh*60+gm)/2), pe=mid+parseInt(pauseMin);
    ins.run(userId,'pause_start',`${datum}T${pad(Math.floor(mid/60))}:${pad(mid%60)}:00.000Z`,'',1);
    ins.run(userId,'pause_ende', `${datum}T${pad(Math.floor(pe/60))}:${pad(pe%60)}:00.000Z`,'',1);
  }
  ins.run(userId,'gehen',`${datum}T${gehen}:00.000Z`,'',1);
  broadcast('nachbuchung',{userId,datum});
  res.json({ok:true});
});

app.patch('/api/buchungen/kommentar', (req,res) => {
  db.prepare("UPDATE buchungen SET kommentar=? WHERE user_id=? AND ts LIKE ? AND typ='kommen'").run(req.body.kommentar||'',req.body.userId,req.body.date+'%');
  res.json({ok:true});
});

app.delete('/api/buchungen/:userId/:date', (req,res) => {
  db.prepare('DELETE FROM buchungen WHERE user_id=? AND ts LIKE ?').run(req.params.userId,req.params.date+'%');
  broadcast('loeschung',{userId:req.params.userId,date:req.params.date});
  res.json({ok:true});
});

app.get('/api/antraege', (req,res) => {
  if (req.query.userId) {
    res.json(db.prepare('SELECT a.*,u.name as userName FROM antraege a JOIN users u ON a.user_id=u.id WHERE a.user_id=? ORDER BY a.ts DESC').all(req.query.userId));
  } else {
    res.json(db.prepare('SELECT a.*,u.name as userName FROM antraege a JOIN users u ON a.user_id=u.id ORDER BY a.ts DESC').all());
  }
});

app.post('/api/antraege', (req,res) => {
  const {userId,von,bis,tage,kommentar} = req.body;
  const r = db.prepare("INSERT INTO antraege(user_id,von,bis,tage,status,kommentar,ts) VALUES(?,?,?,?,'offen',?,?)").run(userId,von,bis,tage,kommentar||'',new Date().toISOString());
  broadcast('antrag_neu',{userId,id:r.lastInsertRowid});
  res.json({ok:true,id:r.lastInsertRowid});
});

app.patch('/api/antraege/:id', (req,res) => {
  const {status} = req.body;
  if (!['genehmigt','abgelehnt'].includes(status)) return res.status(400).json({error:'Ungültig'});
  db.prepare('UPDATE antraege SET status=? WHERE id=?').run(status,req.params.id);
  broadcast('antrag_update',{id:req.params.id,status});
  res.json({ok:true});
});

app.get('/api/settings', (req,res) => {
  const rows=db.prepare('SELECT k,v FROM settings').all(); const s={};
  rows.forEach(r=>s[r.k]=r.v); res.json(s);
});

app.post('/api/settings', (req,res) => {
  const stmt=db.prepare('INSERT OR REPLACE INTO settings(k,v) VALUES(?,?)');
  Object.entries(req.body).forEach(([k,v])=>stmt.run(k,String(v)));
  res.json({ok:true});
});

app.post('/api/users', (req,res) => {
  try {
    db.prepare('INSERT INTO users(id,name,role,soll_stunden,urlaub_anspruch) VALUES(?,?,?,?,?)').run(req.body.id,req.body.name,req.body.role||'ma',req.body.soll_stunden||160,req.body.urlaub_anspruch||20);
    broadcast('user_update',{});
    res.json({ok:true});
  } catch(e) { res.status(409).json({error:'ID bereits vorhanden'}); }
});

app.patch('/api/users/:id', (req,res) => {
  db.prepare('UPDATE users SET name=COALESCE(?,name),soll_stunden=COALESCE(?,soll_stunden),urlaub_anspruch=COALESCE(?,urlaub_anspruch) WHERE id=?').run(req.body.name||null,req.body.soll_stunden||null,req.body.urlaub_anspruch||null,req.params.id);
  broadcast('user_update',{});
  res.json({ok:true});
});

app.post('/api/monatsabschluss', (req,res) => {
  const {monat}=req.body; if(!monat) return res.status(400).json({error:'Monat fehlt'});
  db.prepare('DELETE FROM buchungen WHERE ts LIKE ?').run(monat+'%');
  broadcast('monatsabschluss',{monat}); res.json({ok:true});
});

app.get('/api/export/csv', (req,res) => {
  const mk=req.query.monat||curMonat();
  const users=req.query.userId ? db.prepare('SELECT * FROM users WHERE id=?').all(req.query.userId) : db.prepare("SELECT * FROM users WHERE role='ma' ORDER BY name").all();
  const wt=['So','Mo','Di','Mi','Do','Fr','Sa'];
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="Zeiterfassung_${mk}.csv"`);
  let csv='\uFEFF'+'Mitarbeiter;Datum;Tag;Kommen;Gehen;Pause (min);Netto (h);Typ;Kommentar\n';
  users.forEach(u => tagesauswertung(u.id,mk).forEach(t => {
    const dw=wt[new Date(t.date+'T12:00:00').getDay()];
    csv+=`${u.name};${t.date.split('-').reverse().join('.')};${dw};${t.ein};${t.aus};${t.pauseMin};${t.netto!==null?t.netto.toFixed(2).replace('.',','):'0,00'};${t.typ};${t.kommentar}\n`;
  }));
  res.send(csv);
});

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, () => console.log(`✓ Zeiterfassung läuft auf Port ${PORT}`));

const express  = require('express');
const path     = require('path');
const bcrypt   = require('bcrypt');
const mongoose = require('mongoose');

const app  = express();
const PORT = process.env.PORT || 3000;
const SALT = 10;

// ── MongoDB Verbindung ────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) { console.error('❌ MONGODB_URI fehlt!'); process.exit(1); }

mongoose.connect(MONGO_URI).then(() => console.log('✓ MongoDB verbunden'))
  .catch(e => { console.error('❌ MongoDB Fehler:', e.message); process.exit(1); });

// ── Schemas ───────────────────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  id:              { type:String, required:true, unique:true },
  username:        { type:String, required:true, unique:true },
  name:            String,
  role:            { type:String, default:'ma' },
  password_hash:   { type:String, default:null },
  soll_stunden:    { type:Number, default:160 },
  urlaub_anspruch: { type:Number, default:20 },
  arbeitstage:     { type:[Number], default:[1,2,3,4,5] },
});

const BuchungSchema = new mongoose.Schema({
  bid:       { type:Number, required:true, unique:true },
  user_id:   String,
  typ:       String,
  ts:        String,
  kommentar: { type:String, default:'' },
  nachbuchung:{ type:Boolean, default:false },
});

const AntragSchema = new mongoose.Schema({
  aid:      { type:Number, required:true, unique:true },
  user_id:  String,
  typ:      { type:String, default:'urlaub' },
  status:   { type:String, default:'offen' },
  von:      String, bis:String, tage:Number,
  datum:    String, kommen:String, gehen:String, pauseMin:{ type:Number, default:0 },
  kommentar:{ type:String, default:'' },
  ts:       String,
});

const UebertragSchema = new mongoose.Schema({
  key:     { type:String, required:true, unique:true }, // "ma1:2025-01"
  stunden: { type:Number, default:0 },
  urlaub:  { type:Number, default:0 },
});

const SettingsSchema = new mongoose.Schema({
  key:      { type:String, default:'main', unique:true },
  pause6h:  { type:Number, default:30 },
  pause9h:  { type:Number, default:45 },
  firmaName:{ type:String, default:'Mein Unternehmen' },
});

const CounterSchema = new mongoose.Schema({
  key:   { type:String, unique:true },
  value: { type:Number, default:1 },
});

const User      = mongoose.model('User',      UserSchema);
const Buchung   = mongoose.model('Buchung',   BuchungSchema);
const Antrag    = mongoose.model('Antrag',    AntragSchema);
const Uebertrag = mongoose.model('Uebertrag', UebertragSchema);
const Settings  = mongoose.model('Settings',  SettingsSchema);
const Counter   = mongoose.model('Counter',   CounterSchema);

// ── Helpers ───────────────────────────────────────────────────────────────────
const pad      = n => String(n).padStart(2,'0');
const curMonat = () => { const d=new Date(); return d.getFullYear()+'-'+pad(d.getMonth()+1); };
const today    = () => new Date().toISOString().slice(0,10);

async function newId() {
  const c = await Counter.findOneAndUpdate(
    {key:'main'}, {$inc:{value:1}}, {upsert:true, new:true, setDefaultsOnInsert:true}
  );
  return c.value;
}

function safeUser(u) {
  return {
    id:u.id, username:u.username, name:u.name, role:u.role,
    soll_stunden:u.soll_stunden, urlaub_anspruch:u.urlaub_anspruch,
    arbeitstage:u.arbeitstage, has_password:!!u.password_hash
  };
}

function gesetzlichePause(bruttoH, settings) {
  if (bruttoH >= 9) return settings.pause9h || 45;
  if (bruttoH >= 6) return settings.pause6h || 30;
  return 0;
}

// ── Tagesauswertung ───────────────────────────────────────────────────────────
async function tagesauswertung(userId, monat) {
  const buchungen = await Buchung.find({user_id:userId, ts:{$regex:`^${monat}`}}).lean();
  const user      = await User.findOne({id:userId}).lean();
  const settings  = await Settings.findOne({key:'main'}).lean() || {};
  const arbTage   = user?.arbeitstage || [1,2,3,4,5];
  const todayStr  = today();

  const byDate = {};
  buchungen.forEach(b => {
    const d = b.ts.slice(0,10);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(b);
  });

  const [year, mon] = monat.split('-').map(Number);
  const daysInMonth = new Date(year, mon, 0).getDate();
  const result = [];

  for (let day=1; day<=daysInMonth; day++) {
    const dateStr = `${monat}-${pad(day)}`;
    const dow     = new Date(dateStr+'T12:00:00').getDay();
    const istArbeitstag = arbTage.includes(dow);
    const entries = byDate[dateStr] || [];

    const krank  = entries.find(b=>b.typ==='krank');
    const urlaub = entries.find(b=>b.typ==='urlaub');

    if (krank)  { result.push({date:dateStr,typ:'krank', ein:'',aus:'',pauseMin:0,netto:null,kommentar:krank.kommentar, nachbuchung:false,fehler:false}); continue; }
    if (urlaub) { result.push({date:dateStr,typ:'urlaub',ein:'',aus:'',pauseMin:0,netto:null,kommentar:urlaub.kommentar,nachbuchung:false,fehler:false}); continue; }
    if (!istArbeitstag) { result.push({date:dateStr,typ:'frei',ein:'',aus:'',pauseMin:0,netto:null,kommentar:'',nachbuchung:false,fehler:false}); continue; }

    const kommen  = entries.filter(b=>b.typ==='kommen').sort((a,b)=>a.ts<b.ts?-1:1);
    const gehen   = entries.filter(b=>b.typ==='gehen' ).sort((a,b)=>a.ts<b.ts?-1:1);
    const pStarts = entries.filter(b=>b.typ==='pause_start');
    const pEndes  = entries.filter(b=>b.typ==='pause_ende');
    const nb      = entries.some(b=>b.nachbuchung);

    if (!kommen.length && dateStr <= todayStr) { result.push({date:dateStr,typ:'fehler',ein:'',aus:'',pauseMin:0,netto:null,kommentar:'Keine Buchung',nachbuchung:false,fehler:true}); continue; }
    if (!kommen.length) { result.push({date:dateStr,typ:'offen',ein:'',aus:'',pauseMin:0,netto:null,kommentar:'',nachbuchung:false,fehler:false}); continue; }

    const ein = kommen[0].ts.slice(11,16);
    if (!gehen.length && dateStr < todayStr) { result.push({date:dateStr,typ:'fehler',ein,aus:'',pauseMin:0,netto:null,kommentar:'Kommen ohne Gehen',nachbuchung:nb,fehler:true}); continue; }

    let aus='', pauseMin=0, netto=null;
    if (gehen.length) {
      aus = gehen[gehen.length-1].ts.slice(11,16);
      const bruttoH = (new Date(gehen[gehen.length-1].ts)-new Date(kommen[0].ts))/3600000;
      pStarts.forEach((ps,i)=>{ if(pEndes[i]) pauseMin+=Math.round((new Date(pEndes[i].ts)-new Date(ps.ts))/60000); });
      const gesetzlich = gesetzlichePause(bruttoH, settings);
      if (pauseMin < gesetzlich) pauseMin = gesetzlich;
      netto = Math.max(0, Math.round((bruttoH - pauseMin/60)*100)/100);
    }
    const komm = entries.find(b=>b.typ==='kommen'&&b.kommentar);
    result.push({date:dateStr,typ:gehen.length?'normal':'aktiv',ein,aus,pauseMin,netto,kommentar:komm?komm.kommentar:'',nachbuchung:nb,fehler:false});
  }
  return result;
}

// ── Monatskonten ──────────────────────────────────────────────────────────────
async function monatsKonten(userId, monat) {
  const user  = await User.findOne({id:userId}).lean();
  const tage  = await tagesauswertung(userId, monat);
  const uebtr = await Uebertrag.findOne({key:`${userId}:${monat}`}).lean() || {stunden:0,urlaub:0};

  const istH   = Math.round(tage.reduce((s,t)=>s+(t.netto||0),0)*100)/100;
  const krank  = tage.filter(t=>t.typ==='krank').length;
  const fehler = tage.filter(t=>t.typ==='fehler').length;

  const antraege = await Antrag.find({user_id:userId,status:'genehmigt',typ:'urlaub'}).lean();
  const urlaubGenommen = antraege.filter(a=>a.von&&a.von.startsWith(monat)).reduce((s,a)=>s+(a.tage||0),0);
  const soll  = user?.soll_stunden||0;
  const saldo = Math.round((istH - soll + uebtr.stunden)*100)/100;

  return { istH, soll, saldo, krank, fehler, urlaubGenommen,
    urlaubRest:(user?.urlaub_anspruch||0)-urlaubGenommen+uebtr.urlaub,
    uebertragStunden:uebtr.stunden, uebertragUrlaub:uebtr.urlaub };
}

// ── Aktueller Status ──────────────────────────────────────────────────────────
async function currentStatus(userId) {
  const todayStr = today();
  const buch = await Buchung.find({user_id:userId, ts:{$regex:`^${todayStr}`}}).lean();
  buch.sort((a,b)=>a.ts<b.ts?1:-1);
  if (!buch.length) return {status:'aus',seit:null,inPause:false};
  const last = buch[0];
  if (last.typ==='kommen')      return {status:'ein',seit:last.ts.slice(11,16),inPause:false};
  if (last.typ==='pause_start') return {status:'ein',seit:null,inPause:true};
  if (last.typ==='pause_ende')  { const k=buch.find(b=>b.typ==='kommen'); return {status:'ein',seit:k?k.ts.slice(11,16):null,inPause:false}; }
  return {status:'aus',seit:null,inPause:false};
}

// ── SSE ───────────────────────────────────────────────────────────────────────
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch(e) { clients.delete(res); } }
}

app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));

// ── ERSTEINRICHTUNG ───────────────────────────────────────────────────────────
app.get('/api/setup/needed', async (req,res) => {
  const admin = await User.findOne({role:'admin'}).lean();
  res.json({needed: !admin?.password_hash});
});

app.post('/api/setup', async (req,res) => {
  const admin = await User.findOne({role:'admin'});
  if (admin?.password_hash) return res.status(403).json({error:'Setup bereits abgeschlossen.'});
  const {password} = req.body;
  if (!password||password.length<4) return res.status(400).json({error:'Mindestens 4 Zeichen.'});
  if (!admin) {
    await User.create({id:'admin',username:'admin',name:'Administrator',role:'admin',
      password_hash:await bcrypt.hash(password,SALT),soll_stunden:0,urlaub_anspruch:0,arbeitstage:[1,2,3,4,5]});
  } else {
    admin.password_hash = await bcrypt.hash(password, SALT);
    await admin.save();
  }
  res.json({ok:true});
});

// ── LOGIN ─────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req,res) => {
  const {username,password} = req.body;
  if (!username||!password) return res.status(400).json({error:'Benutzername und Passwort erforderlich.'});
  const user = await User.findOne({username:{$regex:`^${username.trim()}$`,$options:'i'}}).lean();
  if (!user) return res.status(401).json({error:'Ungültiger Benutzername oder Passwort.'});
  if (!user.password_hash) return res.status(401).json({error:'Kein Passwort gesetzt. Admin kontaktieren.'});
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({error:'Ungültiger Benutzername oder Passwort.'});
  res.json({ok:true, user:safeUser(user)});
});

// ── USERS ─────────────────────────────────────────────────────────────────────
app.get('/api/users', async (req,res) => {
  const users = await User.find().lean();
  res.json(users.map(safeUser));
});

app.get('/api/users/:id/status', async (req,res) => res.json(await currentStatus(req.params.id)));

app.post('/api/users', async (req,res) => {
  const {id,username,name,role,soll_stunden,urlaub_anspruch,arbeitstage,password} = req.body;
  if (await User.findOne({id})) return res.status(409).json({error:'ID bereits vorhanden.'});
  if (await User.findOne({username})) return res.status(409).json({error:'Benutzername bereits vergeben.'});
  if (!password||password.length<4) return res.status(400).json({error:'Passwort mind. 4 Zeichen.'});
  const hash = await bcrypt.hash(password, SALT);
  await User.create({id,username,name,role:role||'ma',soll_stunden:soll_stunden||160,
    urlaub_anspruch:urlaub_anspruch||20,arbeitstage:arbeitstage||[1,2,3,4,5],password_hash:hash});
  broadcast('user_update',{}); res.json({ok:true});
});

app.patch('/api/users/:id', async (req,res) => {
  const u = await User.findOne({id:req.params.id});
  if (!u) return res.status(404).json({error:'Nicht gefunden.'});
  if (req.body.username!==undefined) {
    const dup = await User.findOne({username:req.body.username,id:{$ne:u.id}});
    if (dup) return res.status(409).json({error:'Benutzername bereits vergeben.'});
    u.username = req.body.username;
  }
  if (req.body.name            !==undefined) u.name             = req.body.name;
  if (req.body.soll_stunden    !==undefined) u.soll_stunden     = req.body.soll_stunden;
  if (req.body.urlaub_anspruch !==undefined) u.urlaub_anspruch  = req.body.urlaub_anspruch;
  if (req.body.arbeitstage     !==undefined) u.arbeitstage      = req.body.arbeitstage;
  if (req.body.password) u.password_hash = await bcrypt.hash(req.body.password, SALT);
  await u.save();
  broadcast('user_update',{}); res.json({ok:true});
});

// ── ANWESENHEIT ───────────────────────────────────────────────────────────────
app.get('/api/anwesenheit', async (req,res) => {
  const mk    = curMonat();
  const users = await User.find({role:'ma'}).lean();
  users.sort((a,b)=>a.name<b.name?-1:1);
  const result = await Promise.all(users.map(async u=>({
    ...safeUser(u), status:await currentStatus(u.id), konten:await monatsKonten(u.id,mk)
  })));
  res.json(result);
});

// ── JOURNAL ───────────────────────────────────────────────────────────────────
app.get('/api/journal/:userId', async (req,res) => {
  const mk = req.query.monat||curMonat();
  const [tage, konten] = await Promise.all([tagesauswertung(req.params.userId,mk), monatsKonten(req.params.userId,mk)]);
  res.json({tage, konten});
});

// ── BUCHUNGEN ─────────────────────────────────────────────────────────────────
app.post('/api/buchen', async (req,res) => {
  const {userId,typ,kommentar} = req.body;
  if (!userId||!typ) return res.status(400).json({error:'Fehlt.'});
  const bid = await newId();
  await Buchung.create({bid,user_id:userId,typ,ts:new Date().toISOString(),kommentar:kommentar||'',nachbuchung:false});
  const status = await currentStatus(userId);
  broadcast('buchung',{userId,typ,status});
  res.json({ok:true,status});
});

app.post('/api/nachbuchen', async (req,res) => {
  const {userId,datum,kommen,gehen,pauseMin,kommentar} = req.body;
  if (!userId||!datum||!kommen||!gehen) return res.status(400).json({error:'Fehlende Felder.'});
  if (kommen>=gehen) return res.status(400).json({error:'Gehenzeit muss nach Kommenzeit liegen.'});
  await Buchung.deleteMany({user_id:userId,ts:{$regex:`^${datum}`}});
  const ins=async(typ,ts,komm)=>{ const bid=await newId(); await Buchung.create({bid,user_id:userId,typ,ts,kommentar:komm||'',nachbuchung:true}); };
  await ins('kommen',`${datum}T${kommen}:00.000Z`,kommentar||'Nachbuchung');
  if (parseInt(pauseMin)>0) {
    const [kh,km]=kommen.split(':').map(Number),[gh,gm]=gehen.split(':').map(Number);
    const mid=Math.floor((kh*60+km+gh*60+gm)/2),pe=mid+parseInt(pauseMin);
    await ins('pause_start',`${datum}T${pad(Math.floor(mid/60))}:${pad(mid%60)}:00.000Z`,'');
    await ins('pause_ende', `${datum}T${pad(Math.floor(pe/60))}:${pad(pe%60)}:00.000Z`,'');
  }
  await ins('gehen',`${datum}T${gehen}:00.000Z`,'');
  broadcast('nachbuchung',{userId,datum}); res.json({ok:true});
});

app.patch('/api/buchungen/kommentar', async (req,res) => {
  await Buchung.findOneAndUpdate({user_id:req.body.userId,ts:{$regex:`^${req.body.date}`},typ:'kommen'},{kommentar:req.body.kommentar||''});
  res.json({ok:true});
});

app.delete('/api/buchungen/:userId/:date', async (req,res) => {
  await Buchung.deleteMany({user_id:req.params.userId,ts:{$regex:`^${req.params.date}`}});
  broadcast('loeschung',{userId:req.params.userId,date:req.params.date}); res.json({ok:true});
});

// ── ANTRÄGE ───────────────────────────────────────────────────────────────────
app.get('/api/antraege', async (req,res) => {
  const users = await User.find().lean();
  let alle = await Antrag.find().lean();
  alle = alle.map(a=>({...a,userName:users.find(u=>u.id===a.user_id)?.name||'?'}))
             .sort((a,b)=>a.ts<b.ts?1:-1);
  if (req.query.userId) alle=alle.filter(a=>a.user_id===req.query.userId);
  if (req.query.typ)    alle=alle.filter(a=>a.typ===req.query.typ);
  res.json(alle);
});

app.post('/api/antraege', async (req,res) => {
  const {userId,typ,von,bis,tage,datum,kommen,gehen,pauseMin,kommentar} = req.body;
  const aid = await newId();
  await Antrag.create({aid,user_id:userId,typ:typ||'urlaub',status:'offen',
    von:von||null,bis:bis||null,tage:tage||null,
    datum:datum||null,kommen:kommen||null,gehen:gehen||null,pauseMin:pauseMin||0,
    kommentar:kommentar||'',ts:new Date().toISOString()});
  broadcast('antrag_neu',{userId,id:aid,typ}); res.json({ok:true,id:aid});
});

app.patch('/api/antraege/:id', async (req,res) => {
  const {status} = req.body;
  if (!['genehmigt','abgelehnt'].includes(status)) return res.status(400).json({error:'Ungültig.'});
  const a = await Antrag.findOne({aid:parseInt(req.params.id)});
  if (!a) return res.status(404).json({error:'Nicht gefunden.'});
  a.status = status;

  if (status==='genehmigt' && a.typ==='korrektur' && a.datum && a.kommen && a.gehen) {
    await Buchung.deleteMany({user_id:a.user_id,ts:{$regex:`^${a.datum}`}});
    const ins=async(typ,ts)=>{ const bid=await newId(); await Buchung.create({bid,user_id:a.user_id,typ,ts,kommentar:'Korrekturantrag genehmigt',nachbuchung:true}); };
    await ins('kommen',`${a.datum}T${a.kommen}:00.000Z`);
    if (parseInt(a.pauseMin)>0) {
      const [kh,km]=a.kommen.split(':').map(Number),[gh,gm]=a.gehen.split(':').map(Number);
      const mid=Math.floor((kh*60+km+gh*60+gm)/2),pe=mid+parseInt(a.pauseMin);
      const pp=n=>pad(Math.floor(n/60))+':'+pad(n%60);
      await ins('pause_start',`${a.datum}T${pp(mid)}:00.000Z`);
      await ins('pause_ende', `${a.datum}T${pp(pe)}:00.000Z`);
    }
    await ins('gehen',`${a.datum}T${a.gehen}:00.000Z`);
  }

  if (status==='genehmigt' && a.typ==='urlaub' && a.von && a.bis) {
    const user = await User.findOne({id:a.user_id}).lean();
    const arbTage = user?.arbeitstage||[1,2,3,4,5];
    let cur = new Date(a.von);
    const end = new Date(a.bis);
    while (cur<=end) {
      const dow = cur.getDay();
      if (arbTage.includes(dow)) {
        const ds = cur.toISOString().slice(0,10);
        await Buchung.deleteMany({user_id:a.user_id,ts:{$regex:`^${ds}`}});
        const bid=await newId();
        await Buchung.create({bid,user_id:a.user_id,typ:'urlaub',ts:`${ds}T00:00:00.000Z`,kommentar:'Urlaub genehmigt',nachbuchung:false});
      }
      cur.setDate(cur.getDate()+1);
    }
  }

  await a.save();
  broadcast('antrag_update',{id:req.params.id,status,typ:a.typ}); res.json({ok:true});
});

// ── ÜBERTRAG ─────────────────────────────────────────────────────────────────
app.get('/api/uebertrag/:userId/:monat', async (req,res) => {
  const u = await Uebertrag.findOne({key:`${req.params.userId}:${req.params.monat}`}).lean();
  res.json(u||{stunden:0,urlaub:0});
});

app.post('/api/uebertrag/:userId/:monat', async (req,res) => {
  await Uebertrag.findOneAndUpdate(
    {key:`${req.params.userId}:${req.params.monat}`},
    {stunden:parseFloat(req.body.stunden)||0, urlaub:parseInt(req.body.urlaub)||0},
    {upsert:true}
  );
  res.json({ok:true});
});

// ── MONATSABSCHLUSS ───────────────────────────────────────────────────────────
app.post('/api/monatsabschluss', async (req,res) => {
  const {monat} = req.body;
  if (!monat) return res.status(400).json({error:'Monat fehlt.'});
  const [y,m] = monat.split('-').map(Number);
  const nextDate  = new Date(y,m,1);
  const nextMonat = nextDate.getFullYear()+'-'+pad(nextDate.getMonth()+1);
  const users = await User.find({role:'ma'}).lean();
  await Promise.all(users.map(async u => {
    const konten  = await monatsKonten(u.id, monat);
    const nextKey = `${u.id}:${nextMonat}`;
    const existing= await Uebertrag.findOne({key:nextKey}).lean()||{stunden:0,urlaub:0};
    await Uebertrag.findOneAndUpdate({key:nextKey},
      {stunden:Math.round((existing.stunden+konten.saldo)*100)/100, urlaub:existing.urlaub},
      {upsert:true});
  }));
  broadcast('monatsabschluss',{monat}); res.json({ok:true});
});

// ── SETTINGS ──────────────────────────────────────────────────────────────────
app.get('/api/settings', async (req,res) => {
  const s = await Settings.findOne({key:'main'}).lean();
  res.json(s||{pause6h:30,pause9h:45,firmaName:'Mein Unternehmen'});
});

app.post('/api/settings', async (req,res) => {
  await Settings.findOneAndUpdate({key:'main'}, req.body, {upsert:true});
  res.json({ok:true});
});

// ── EXPORT CSV ────────────────────────────────────────────────────────────────
app.get('/api/export/csv', async (req,res) => {
  const mk    = req.query.monat||curMonat();
  const query = req.query.userId ? {id:req.query.userId} : {role:'ma'};
  const users = await User.find(query).lean();
  users.sort((a,b)=>a.name<b.name?-1:1);
  const wt = ['So','Mo','Di','Mi','Do','Fr','Sa'];
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="Zeiterfassung_${mk}.csv"`);
  let csv = '\uFEFF'+'Mitarbeiter;Datum;Tag;Kommen;Gehen;Pause (min);Netto (h);Typ;Kommentar\n';
  for (const u of users) {
    const tage = await tagesauswertung(u.id, mk);
    tage.forEach(t => {
      const dw = wt[new Date(t.date+'T12:00:00').getDay()];
      csv += `${u.name};${t.date.split('-').reverse().join('.')};${dw};${t.ein};${t.aus};`+
             `${t.pauseMin};${t.netto!==null?t.netto.toFixed(2).replace('.',','):'0,00'};`+
             `${t.typ};${t.kommentar}\n`;
    });
  }
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

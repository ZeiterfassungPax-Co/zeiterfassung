const express  = require('express');
const path     = require('path');
const bcrypt   = require('bcrypt');
const mongoose = require('mongoose');

const app  = express();
const PORT = process.env.PORT || 3000;
const SALT = 10;

// ── MongoDB ───────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) { 
  console.error('❌ MONGODB_URI fehlt in den Umgebungsvariablen!'); 
  process.exit(1); 
}

mongoose.connect(MONGO_URI)
  .then(() => console.log('✓ MongoDB verbunden'))
  .catch(e => { console.error('❌ MongoDB Verbindungsfehler:', e.message); process.exit(1); });

// ── Schemas ───────────────────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  id:              { type: String, required: true, unique: true },
  username:        { type: String, required: true, unique: true },
  name:            String,
  role:            { type: String, default: 'ma' },
  password_hash:   { type: String, default: null },
  firma:           { type: String, default: '', index: false },
  urlaub_anspruch: { type: Number, default: 20 },
  arbeitstage:     { type: [Number], default: [1, 2, 3, 4, 5] },
  soll_pro_tag:    { type: Map, of: Number, default: { 1: 8, 2: 8, 3: 8, 4: 8, 5: 8 } },
});

const BuchungSchema = new mongoose.Schema({
  bid:         { type: Number, required: true, unique: true },
  user_id:     String, 
  typ:         String, 
  ts:          String,
  kommentar:   { type: String, default: '' },
  nachbuchung: { type: Boolean, default: false },
});

const AntragSchema = new mongoose.Schema({
  aid:       { type: Number, required: true, unique: true },
  user_id:   String, 
  typ:       { type: String, default: 'urlaub' }, 
  status:    { type: String, default: 'offen' },
  von:       String, 
  bis:       String, 
  tage:      Number,
  datum:     String, 
  kommen:    String, 
  gehen:     String, 
  pauseMin:  { type: Number, default: 0 },
  kommentar: { type: String, default: '' }, 
  ts:        String,
});

const UebertragSchema = new mongoose.Schema({
  key:     { type: String, required: true, unique: true },
  stunden: { type: Number, default: 0 }, 
  urlaub:  { type: Number, default: 0 },
});

const FirmaSchema = new mongoose.Schema({
  fid:   { type: String, required: true, unique: true },
  name:  String,
  farbe: { type: String, default: '#2563eb' },
});

const SettingsSchema = new mongoose.Schema({
  key:        { type: String, default: 'main', unique: true },
  pause6h:    { type: Number, default: 30 },
  pause9h:    { type: Number, default: 45 },
  firmaName:  { type: String, default: 'Mein Unternehmen' },
  bundesland: { type: String, default: 'NW' },
});

const CounterSchema = new mongoose.Schema({ key: { type: String, unique: true }, value: { type: Number, default: 1 } });

const User      = mongoose.model('User', UserSchema);
const Buchung   = mongoose.model('Buchung', BuchungSchema);
const Antrag    = mongoose.model('Antrag', AntragSchema);
const Uebertrag = mongoose.model('Uebertrag', UebertragSchema);
const Firma     = mongoose.model('Firma', FirmaSchema);
const Settings  = mongoose.model('Settings', SettingsSchema);
const Counter   = mongoose.model('Counter', CounterSchema);

// ── Helpers ───────────────────────────────────────────────────────────────────
const pad      = n => String(n).padStart(2, '0');
const curMonat = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1); };
const today    = () => new Date().toISOString().slice(0, 10);

async function newId() {
  const c = await Counter.findOneAndUpdate(
    { key: 'main' }, { $inc: { value: 1 } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  return c.value;
}

function safeUser(u) {
  const spt = u.soll_pro_tag instanceof Map
    ? Object.fromEntries(u.soll_pro_tag)
    : (u.soll_pro_tag || { 1: 8, 2: 8, 3: 8, 4: 8, 5: 8 });
  return {
    id: u.id, username: u.username, name: u.name, role: u.role, firma: u.firma || '',
    urlaub_anspruch: u.urlaub_anspruch, arbeitstage: u.arbeitstage,
    soll_pro_tag: spt, has_password: !!u.password_hash
  };
}

// ── Feiertage (Deutschland) ───────────────────────────────────────────────────
function osterSonntag(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function getFeiertage(year, bundesland = 'NW') {
  const os = osterSonntag(year);
  const add = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const fmt = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

  const feste = {
    [`${year}-01-01`]: 'Neujahr',
    [`${year}-05-01`]: 'Tag der Arbeit',
    [`${year}-10-03`]: 'Tag der Deutschen Einheit',
    [`${year}-12-25`]: '1. Weihnachtstag',
    [`${year}-12-26`]: '2. Weihnachtstag',
    [fmt(add(os, -2))]: 'Karfreitag',
    [fmt(add(os, 1))]: 'Ostermontag',
    [fmt(add(os, 39))]: 'Christi Himmelfahrt',
    [fmt(add(os, 50))]: 'Pfingstmontag',
  };

  const bl = bundesland.toUpperCase();
  if (['BW', 'BY', 'ST'].includes(bl)) feste[`${year}-01-06`] = 'Heilige Drei Könige';
  if (['BW', 'BY', 'HE', 'NW', 'RP', 'SL', 'SN', 'TH'].includes(bl)) feste[fmt(add(os, 60))] = 'Fronleichnam';
  if (['SL', 'BY'].includes(bl)) feste[`${year}-08-15`] = 'Mariä Himmelfahrt';
  if (['BB', 'MV', 'SN', 'ST', 'TH', 'HH', 'HB', 'NI', 'SH'].includes(bl)) feste[`${year}-10-31`] = 'Reformationstag';
  if (['BW', 'BY', 'NW', 'RP', 'SL'].includes(bl)) feste[`${year}-11-01`] = 'Allerheiligen';
  if (bl === 'SN') feste[fmt(add(osterSonntag(year), -11))] = 'Buß- und Bettag';

  return feste;
}

function berechneSoll(user, monat, feiertage) {
  const spt = user.soll_pro_tag instanceof Map
    ? Object.fromEntries(user.soll_pro_tag)
    : (user.soll_pro_tag || { 1: 8, 2: 8, 3: 8, 4: 8, 5: 8 });
  const arbTage = user.arbeitstage || [1, 2, 3, 4, 5];
  const [year, mon] = monat.split('-').map(Number);
  const daysInMonth = new Date(year, mon, 0).getDate();
  let soll = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const ds = `${monat}-${pad(day)}`;
    const dow = new Date(ds + 'T12:00:00').getDay();
    if (arbTage.includes(dow) && !feiertage[ds]) {
      soll += parseFloat(spt[dow] || spt[String(dow)] || 0);
    }
  }
  return Math.round(soll * 100) / 100;
}

function gesetzlichePause(bruttoH, settings) {
  if (bruttoH >= 9) return settings.pause9h || 45;
  if (bruttoH >= 6) return settings.pause6h || 30;
  return 0;
}

// ── Tagesauswertung ───────────────────────────────────────────────────────────
async function tagesauswertung(userId, monat) {
  const [buchungen, user, settings] = await Promise.all([
    Buchung.find({ user_id: userId, ts: { $regex: `^${monat}` } }).lean(),
    User.findOne({ id: userId }).lean(),
    Settings.findOne({ key: 'main' }).lean() || {},
  ]);
  const arbTage  = user?.arbeitstage || [1, 2, 3, 4, 5];
  const todayStr = today();
  const [year, mon] = monat.split('-').map(Number);
  const feiertage  = getFeiertage(year, settings?.bundesland || 'NW');
  const spt = user?.soll_pro_tag instanceof Map
    ? Object.fromEntries(user.soll_pro_tag)
    : (user?.soll_pro_tag || { 1: 8, 2: 8, 3: 8, 4: 8, 5: 8 });

  const byDate = {};
  buchungen.forEach(b => { const d = b.ts.slice(0, 10); if (!byDate[d]) byDate[d] = []; byDate[d].push(b); });

  const daysInMonth = new Date(year, mon, 0).getDate();
  const result = [];

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${monat}-${pad(day)}`;
    const dow     = new Date(dateStr + 'T12:00:00').getDay();
    const istFeiertag   = !!feiertage[dateStr];
    const istArbeitstag = arbTage.includes(dow) && !istFeiertag;
    const entries = byDate[dateStr] || [];
    const sollH   = istArbeitstag ? parseFloat(spt[dow] || spt[String(dow)] || 0) : 0;

    const krank  = entries.find(b => b.typ === 'krank');
    const urlaub = entries.find(b => b.typ === 'urlaub');

    if (istFeiertag && !krank && !urlaub) {
      result.push({ date: dateStr, typ: 'feiertag', ein: '', aus: '', pauseMin: 0, netto: null, kommentar: feiertage[dateStr], nachbuchung: false, fehler: false, sollH, dow }); continue;
    }
    if (krank)  { result.push({ date: dateStr, typ: 'krank', ein: '', aus: '', pauseMin: 0, netto: null, kommentar: krank.kommentar, nachbuchung: false, fehler: false, sollH, dow }); continue; }
    if (urlaub) { result.push({ date: dateStr, typ: 'urlaub', ein: '', aus: '', pauseMin: 0, netto: null, kommentar: urlaub.kommentar, nachbuchung: false, fehler: false, sollH, dow }); continue; }
    if (!istArbeitstag) { result.push({ date: dateStr, typ: 'frei', ein: '', aus: '', pauseMin: 0, netto: null, kommentar: '', nachbuchung: false, fehler: false, sollH: 0, dow }); continue; }

    const kommen  = entries.filter(b => b.typ === 'kommen').sort((a, b) => a.ts < b.ts ? -1 : 1);
    const gehen   = entries.filter(b => b.typ === 'gehen').sort((a, b) => a.ts < b.ts ? -1 : 1);
    const pStarts = entries.filter(b => b.typ === 'pause_start');
    const pEndes  = entries.filter(b => b.typ === 'pause_ende');
    const nb      = entries.some(b => b.nachbuchung);

    if (!kommen.length && dateStr <= todayStr) { result.push({ date: dateStr, typ: 'fehler', ein: '', aus: '', pauseMin: 0, netto: null, kommentar: 'Keine Buchung', nachbuchung: false, fehler: true, sollH, dow }); continue; }
    if (!kommen.length) { result.push({ date: dateStr, typ: 'offen', ein: '', aus: '', pauseMin: 0, netto: null, kommentar: '', nachbuchung: false, fehler: false, sollH, dow }); continue; }

    const ein = kommen[0].ts.slice(11, 16);
    if (!gehen.length && dateStr < todayStr) { result.push({ date: dateStr, typ: 'fehler', ein, aus: '', pauseMin: 0, netto: null, kommentar: 'Kommen ohne Gehen', nachbuchung: nb, fehler: true, sollH, dow }); continue; }

    let aus = '', pauseMin = 0, netto = null;
    if (gehen.length) {
      aus = gehen[gehen.length - 1].ts.slice(11, 16);
      const bruttoH = (new Date(gehen[gehen.length - 1].ts) - new Date(kommen[0].ts)) / 3600000;
      pStarts.forEach((ps, i) => { if (pEndes[i]) pauseMin += Math.round((new Date(pEndes[i].ts) - new Date(ps.ts)) / 60000); });
      const gesetzlich = gesetzlichePause(bruttoH, settings || {});
      if (pauseMin < gesetzlich) pauseMin = gesetzlich;
      netto = Math.max(0, Math.round((bruttoH - pauseMin / 60) * 100) / 100);
    }
    const komm = entries.find(b => b.typ === 'kommen' && b.kommentar);
    result.push({ date: dateStr, typ: gehen.length ? 'normal' : 'aktiv', ein, aus, pauseMin, netto, kommentar: komm ? komm.kommentar : '', nachbuchung: nb, fehler: false, sollH, dow });
  }
  return result;
}

// ── Monatskonten ──────────────────────────────────────────────────────────────
async function monatsKonten(userId, monat) {
  const [user, settings] = await Promise.all([
    User.findOne({ id: userId }).lean(),
    Settings.findOne({ key: 'main' }).lean() || {},
  ]);
  const tage   = await tagesauswertung(userId, monat);
  const uebtr  = await Uebertrag.findOne({ key: `${userId}:${monat}` }).lean() || { stunden: 0, urlaub: 0 };
  const [year] = monat.split('-').map(Number);
  const feiertage = getFeiertage(year, settings?.bundesland || 'NW');

  const istH   = Math.round(tage.reduce((s, t) => s + (t.netto || 0), 0) * 100) / 100;
  const krank  = tage.filter(t => t.typ === 'krank').length;
  const fehler = tage.filter(t => t.typ === 'fehler').length;
  const soll   = berechneSoll(user, monat, feiertage);

  const antraege = await Antrag.find({ user_id: userId, status: 'genehmigt', typ: 'urlaub' }).lean();
  const urlaubGenommen = antraege.filter(a => a.von && a.von.startsWith(monat)).reduce((s, a) => s + (a.tage || 0), 0);
  const saldo = Math.round((istH - soll + uebtr.stunden) * 100) / 100;

  return {
    istH, soll, saldo, krank, fehler, urlaubGenommen,
    urlaubRest: (user?.urlaub_anspruch || 0) - urlaubGenommen + uebtr.urlaub,
    uebertragStunden: uebtr.stunden, uebertragUrlaub: uebtr.urlaub
  };
}

// ── Aktueller Status ──────────────────────────────────────────────────────────
async function currentStatus(userId) {
  const todayStr = today();
  const buch = await Buchung.find({ user_id: userId, ts: { $regex: `^${todayStr}` } }).lean();
  buch.sort((a, b) => a.ts < b.ts ? 1 : -1);
  if (!buch.length) return { status: 'aus', seit: null, inPause: false };
  const last = buch[0];
  if (last.typ === 'kommen')      return { status: 'ein', seit: last.ts.slice(11, 16), inPause: false };
  if (last.typ === 'pause_start') return { status: 'ein', seit: null, inPause: true };
  if (last.typ === 'pause_ende')  { const k = buch.find(b => b.typ === 'kommen'); return { status: 'ein', seit: k ? k.ts.slice(11, 16) : null, inPause: false }; }
  return { status: 'aus', seit: null, inPause: false };
}

// ── SSE ───────────────────────────────────────────────────────────────────────
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch (e) { clients.delete(res); } }
}

// Middlewares
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Optional: Auth-Middlewares Erweiterung für Produktionsbetrieb
const requireAuth = (req, res, next) => next();
const requireAdmin = (req, res, next) => next();

// ── SETUP & LOGIN ─────────────────────────────────────────────────────────────
app.get('/api/setup/needed', async (req, res) => {
  const admin = await User.findOne({ role: 'admin' }).lean();
  res.json({ needed: !admin?.password_hash });
});

app.post('/api/setup', async (req, res) => {
  const admin = await User.findOne({ role: 'admin' });
  if (admin?.password_hash) return res.status(403).json({ error: 'Setup bereits abgeschlossen.' });
  const { password } = req.body;
  if (!password || password.length < 4) return res.status(400).json({ error: 'Mindestens 4 Zeichen.' });
  if (!admin) {
    await User.create({
      id: 'admin', username: 'admin', name: 'Administrator', role: 'admin',
      password_hash: await bcrypt.hash(password, SALT), urlaub_anspruch: 0, arbeitstage: [1, 2, 3, 4, 5], soll_pro_tag: {}
    });
  } else { admin.password_hash = await bcrypt.hash(password, SALT); await admin.save(); }
  res.json({ ok: true });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort erforderlich.' });
  const user = await User.findOne({ username: { $regex: `^${username.trim()}$`, $options: 'i' } }).lean();
  if (!user || !user.password_hash) return res.status(401).json({ error: 'Ungültiger Benutzername oder Passwort.' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Ungültiger Benutzername oder Passwort.' });
  res.json({ ok: true, user: safeUser(user) });
});

// ── USERS ─────────────────────────────────────────────────────────────────────
app.get('/api/users', requireAuth, async (req, res) => {
  const users = await User.find().lean(); res.json(users.map(safeUser));
});

app.get('/api/users/:id/status', requireAuth, async (req, res) => res.json(await currentStatus(req.params.id)));

app.post('/api/users', requireAdmin, async (req, res) => {
  const { id, username, name, role, urlaub_anspruch, arbeitstage, soll_pro_tag, password, firma } = req.body;
  if (await User.findOne({ id })) return res.status(409).json({ error: 'ID bereits vorhanden.' });
  if (await User.findOne({ username })) return res.status(409).json({ error: 'Benutzername bereits vergeben.' });
  if (!password || password.length < 4) return res.status(400).json({ error: 'Passwort mind. 4 Zeichen.' });
  const hash = await bcrypt.hash(password, SALT);
  await User.create({
    id, username, name, role: role || 'ma', firma: firma || '',
    urlaub_anspruch: urlaub_anspruch || 20, arbeitstage: arbeitstage || [1, 2, 3, 4, 5],
    soll_pro_tag: soll_pro_tag || { 1: 8, 2: 8, 3: 8, 4: 8, 5: 8 }, password_hash: hash
  });
  broadcast('user_update', {}); res.json({ ok: true });
});

app.patch('/api/users/:id', requireAdmin, async (req, res) => {
  const u = await User.findOne({ id: req.params.id });
  if (!u) return res.status(404).json({ error: 'Nicht gefunden.' });
  if (req.body.username !== undefined) {
    const dup = await User.findOne({ username: req.body.username, id: { $ne: u.id } });
    if (dup) return res.status(409).json({ error: 'Benutzername bereits vergeben.' });
    u.username = req.body.username;
  }
  if (req.body.name            !== undefined) u.name = req.body.name;
  if (req.body.firma           !== undefined) u.firma = req.body.firma;
  if (req.body.urlaub_anspruch !== undefined) u.urlaub_anspruch = req.body.urlaub_anspruch;
  if (req.body.arbeitstage     !== undefined) u.arbeitstage = req.body.arbeitstage;
  if (req.body.soll_pro_tag    !== undefined) u.soll_pro_tag = req.body.soll_pro_tag;
  if (req.body.password) u.password_hash = await bcrypt.hash(req.body.password, SALT);
  await u.save(); broadcast('user_update', {}); res.json({ ok: true });
});

// ── FIRMEN ────────────────────────────────────────────────────────────────────
app.get('/api/firmen', requireAuth, async (req, res) => res.json(await Firma.find().lean()));

app.post('/api/firmen', requireAdmin, async (req, res) => {
  const { fid, name, farbe } = req.body;
  if (!fid || !name) return res.status(400).json({ error: 'fid und name erforderlich.' });
  if (await Firma.findOne({ fid })) return res.status(409).json({ error: 'ID bereits vorhanden.' });
  await Firma.create({ fid, name, farbe: farbe || '#2563eb' });
  res.json({ ok: true });
});

app.patch('/api/firmen/:fid', requireAdmin, async (req, res) => {
  const f = await Firma.findOne({ fid: req.params.fid });
  if (!f) return res.status(404).json({ error: 'Nicht gefunden.' });
  if (req.body.name)  f.name = req.body.name;
  if (req.body.farbe) f.farbe = req.body.farbe;
  await f.save(); res.json({ ok: true });
});

app.delete('/api/firmen/:fid', requireAdmin, async (req, res) => {
  await Firma.deleteOne({ fid: req.params.fid }); res.json({ ok: true });
});

// ── FEIERTAGE ─────────────────────────────────────────────────────────────────
app.get('/api/feiertage/:year', requireAuth, async (req, res) => {
  const s = await Settings.findOne({ key: 'main' }).lean() || {};
  res.json(getFeiertage(parseInt(req.params.year), s.bundesland || 'NW'));
});

// ── ANWESENHEIT & JOURNAL ─────────────────────────────────────────────────────
app.get('/api/anwesenheit', requireAuth, async (req, res) => {
  const mk = curMonat();
  let users = await User.find({ role: 'ma' }).lean();
  if (req.query.firma) users = users.filter(u => u.firma === req.query.firma);
  users.sort((a, b) => a.name < b.name ? -1 : 1);
  const result = await Promise.all(users.map(async u => ({
    ...safeUser(u), status: await currentStatus(u.id), konten: await monatsKonten(u.id, mk)
  })));
  res.json(result);
});

app.get('/api/journal/:userId', requireAuth, async (req, res) => {
  const mk = req.query.monat || curMonat();
  const [tage, konten] = await Promise.all([tagesauswertung(req.params.userId, mk), monatsKonten(req.params.userId, mk)]);
  res.json({ tage, konten });
});

// ── BUCHUNGEN ─────────────────────────────────────────────────────────────────
app.post('/api/buchen', requireAuth, async (req, res) => {
  const { userId, typ, kommentar } = req.body;
  if (!userId || !typ) return res.status(400).json({ error: 'Fehlt.' });
  const bid = await newId();
  await Buchung.create({ bid, user_id: userId, typ, ts: new Date().toISOString(), kommentar: kommentar || '', nachbuchung: false });
  const status = await currentStatus(userId);
  broadcast('buchung', { userId, typ, status }); res.json({ ok: true, status });
});

app.post('/api/nachbuchen', requireAuth, async (req, res) => {
  const { userId, datum, kommen, gehen, pauseMin, kommentar } = req.body;
  if (!userId || !datum || !kommen || !gehen) return res.status(400).json({ error: 'Fehlende Felder.' });
  if (kommen >= gehen) return res.status(400).json({ error: 'Gehenzeit muss nach Kommenzeit liegen.' });

  await Buchung.deleteMany({ user_id: userId, ts: { $regex: `^${datum}` } });

  const ins = async (typ, timeStr, komm) => {
    const bid = await newId();
    await Buchung.create({ bid, user_id: userId, typ, ts: `${datum}T${timeStr}:00.000`, kommentar: komm || '', nachbuchung: true });
  };

  await ins('kommen', kommen, kommentar || 'Nachbuchung');
  if (parseInt(pauseMin) > 0) {
    const [kh, km] = kommen.split(':').map(Number), [gh, gm] = gehen.split(':').map(Number);
    const mid = Math.floor((kh * 60 + km + gh * 60 + gm) / 2), pe = mid + parseInt(pauseMin);
    await ins('pause_start', `${pad(Math.floor(mid / 60))}:${pad(mid % 60)}`, '');
    await ins('pause_ende', `${pad(Math.floor(pe / 60))}:${pad(pe % 60)}`, '');
  }
  await ins('gehen', gehen, '');
  broadcast('nachbuchung', { userId, datum }); res.json({ ok: true });
});

app.patch('/api/buchungen/kommentar', requireAuth, async (req, res) => {
  await Buchung.findOneAndUpdate({ user_id: req.body.userId, ts: { $regex: `^${req.body.date}` }, typ: 'kommen' }, { kommentar: req.body.kommentar || '' });
  res.json({ ok: true });
});

app.delete('/api/buchungen/:userId/:date', requireAdmin, async (req, res) => {
  await Buchung.deleteMany({ user_id: req.params.userId, ts: { $regex: `^${req.params.date}` } });
  broadcast('loeschung', { userId: req.params.userId, date: req.params.date }); res.json({ ok: true });
});

// ── ANTRÄGE ───────────────────────────────────────────────────────────────────
app.get('/api/antraege', requireAuth, async (req, res) => {
  const users = await User.find().lean();
  let alle = await Antrag.find().lean();
  alle = alle.map(a => ({ ...a, userName: users.find(u => u.id === a.user_id)?.name || '?' })).sort((a, b) => a.ts < b.ts ? 1 : -1);
  if (req.query.userId) alle = alle.filter(a => a.user_id === req.query.userId);
  if (req.query.typ)    alle = alle.filter(a => a.typ === req.query.typ);
  res.json(alle);
});

app.post('/api/antraege', requireAuth, async (req, res) => {
  const { userId, typ, von, bis, tage, datum, kommen, gehen, pauseMin, kommentar } = req.body;
  const aid = await newId();
  await Antrag.create({
    aid, user_id: userId, typ: typ || 'urlaub', status: 'offen',
    von: von || null, bis: bis || null, tage: tage || null,
    datum: datum || null, kommen: kommen || null, gehen: gehen || null, pauseMin: pauseMin || 0,
    kommentar: kommentar || '', ts: new Date().toISOString()
  });
  broadcast('antrag_neu', { userId, id: aid, typ }); res.json({ ok: true, id: aid });
});

app.patch('/api/antraege/:id', requireAdmin, async (req, res) => {
  const { status } = req.body;
  if (!['genehmigt', 'abgelehnt'].includes(status)) return res.status(400).json({ error: 'Ungültig.' });
  const a = await Antrag.findOne({ aid: parseInt(req.params.id) });
  if (!a) return res.status(404).json({ error: 'Nicht gefunden.' });
  a.status = status;

  if (status === 'genehmigt' && a.typ === 'korrektur' && a.datum && a.kommen && a.gehen) {
    await Buchung.deleteMany({ user_id: a.user_id, ts: { $regex: `^${a.datum}` } });
    const ins = async (typ, timeStr) => {
      const bid = await newId();
      await Buchung.create({ bid, user_id: a.user_id, typ, ts: `${a.datum}T${timeStr}:00.000`, kommentar: 'Korrekturantrag genehmigt', nachbuchung: true });
    };
    await ins('kommen', a.kommen);
    if (parseInt(a.pauseMin) > 0) {
      const [kh, km] = a.kommen.split(':').map(Number), [gh, gm] = a.gehen.split(':').map(Number);
      const mid = Math.floor((kh * 60 + km + gh * 60 + gm) / 2), pe = mid + parseInt(a.pauseMin);
      const pp = n => pad(Math.floor(n / 60)) + ':' + pad(n % 60);
      await ins('pause_start', pp(mid));
      await ins('pause_ende', pp(pe));
    }
    await ins('gehen', a.gehen);
  }

  if (status === 'genehmigt' && a.typ === 'urlaub' && a.von && a.bis) {
    const user = await User.findOne({ id: a.user_id }).lean();
    const arbTage = user?.arbeitstage || [1, 2, 3, 4, 5];
    let cur = new Date(a.von + 'T12:00:00');
    const end = new Date(a.bis + 'T12:00:00');

    while (cur <= end) {
      const dow = cur.getDay();
      if (arbTage.includes(dow)) {
        const ds = cur.toISOString().slice(0, 10);
        await Buchung.deleteMany({ user_id: a.user_id, ts: { $regex: `^${ds}` } });
        const bid = await newId();
        await Buchung.create({ bid, user_id: a.user_id, typ: 'urlaub', ts: `${ds}T00:00:00.000`, kommentar: 'Urlaub genehmigt', nachbuchung: false });
      }
      cur.setDate(cur.getDate() + 1);
    }
  }

  await a.save(); broadcast('antrag_update', { id: req.params.id, status, typ: a.typ }); res.json({ ok: true });
});

// ── ÜBERTRAG & MONATSABSCHLUSS ────────────────────────────────────────────────
app.get('/api/uebertrag/:userId/:monat', requireAuth, async (req, res) => {
  const u = await Uebertrag.findOne({ key: `${req.params.userId}:${req.params.monat}` }).lean();
  res.json(u || { stunden: 0, urlaub: 0 });
});

app.post('/api/uebertrag/:userId/:monat', requireAdmin, async (req, res) => {
  await Uebertrag.findOneAndUpdate(
    { key: `${req.params.userId}:${req.params.monat}` },
    { stunden: parseFloat(req.body.stunden) || 0, urlaub: parseInt(req.body.urlaub) || 0 },
    { upsert: true });
  res.json({ ok: true });
});

app.post('/api/monatsabschluss', requireAdmin, async (req, res) => {
  const { monat } = req.body;
  if (!monat) return res.status(400).json({ error: 'Monat fehlt.' });
  const [y, m] = monat.split('-').map(Number);
  const nextDate = new Date(y, m, 1);
  const nextMonat = nextDate.getFullYear() + '-' + pad(nextDate.getMonth() + 1);
  const users = await User.find({ role: 'ma' }).lean();

  await Promise.all(users.map(async u => {
    const konten = await monatsKonten(u.id, monat);
    const nextKey = `${u.id}:${nextMonat}`;
    const existing = await Uebertrag.findOne({ key: nextKey }).lean() || { stunden: 0, urlaub: 0 };
    await Uebertrag.findOneAndUpdate({ key: nextKey },
      { stunden: Math.round((existing.stunden + konten.saldo) * 100) / 100, urlaub: existing.urlaub },
      { upsert: true });
  }));
  broadcast('monatsabschluss', { monat }); res.json({ ok: true });
});

// ── SETTINGS ──────────────────────────────────────────────────────────────────
app.get('/api/settings', requireAuth, async (req, res) => {
  const s = await Settings.findOne({ key: 'main' }).lean();
  res.json(s || { pause6h: 30, pause9h: 45, firmaName: 'Mein Unternehmen', bundesland: 'NW' });
});

app.post('/api/settings', requireAdmin, async (req, res) => {
  await Settings.findOneAndUpdate({ key: 'main' }, req.body, { upsert: true });
  res.json({ ok: true });
});

// ── EXPORT CSV ────────────────────────────────────────────────────────────────
app.get('/api/export/csv', requireAuth, async (req, res) => {
  const mk = req.query.monat || curMonat();
  let query = req.query.userId ? { id: req.query.userId } : { role: 'ma' };
  let users = await User.find(query).lean();
  if (req.query.firma) users = users.filter(u => u.firma === req.query.firma);
  users.sort((a, b) => a.name < b.name ? -1 : 1);
  const wt = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="Zeiterfassung_${mk}.csv"`);
  let csv = '\uFEFF' + 'Mitarbeiter;Firma;Datum;Tag;Kommen;Gehen;Pause (min);Soll (h);Netto (h);Diff (h);Typ;Kommentar\n';

  for (const u of users) {
    const tage = await tagesauswertung(u.id, mk);
    tage.forEach(t => {
      const dw = wt[new Date(t.date + 'T12:00:00').getDay()];
      const diff = t.netto !== null ? (t.netto - t.sollH).toFixed(2).replace('.', ',') : '';
      csv += `${u.name};${u.firma || ''};${t.date.split('-').reverse().join('.')};${dw};` +
             `${t.ein};${t.aus};${t.pauseMin};` +
             `${t.sollH ? t.sollH.toFixed(2).replace('.', ',') : '0,00'};` +
             `${t.netto !== null ? t.netto.toFixed(2).replace('.', ',') : '0,00'};` +
             `${diff};${t.typ};${t.kommentar}\n`;
    });
  }
  res.send(csv);
});

// ── SSE ───────────────────────────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders(); res.write('event: connected\ndata: {}\n\n');
  clients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { clients.delete(res); clearInterval(ping); } }, 25000);
  req.on('close', () => { clients.delete(res); clearInterval(ping); });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`✓ Zeiterfassung läuft auf Port ${PORT}`));

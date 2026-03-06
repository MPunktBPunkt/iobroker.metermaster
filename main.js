'use strict';

const utils  = require('@iobroker/adapter-core');
const http   = require('http');
const crypto = require('crypto');

const adapter = new utils.Adapter('metermaster');

let server           = null;
let readingsReceived = 0;

// ─── In-Memory Datencache ─────────────────────────────────────────────────────
// Struktur: receivedData[house][apartment][meter] = { latest, latestDate, unit, typeName, history[] }
// Wird bei jedem storeReading() befüllt und für /api/data ausgeliefert.
const receivedData = {};

function cacheReading(house, apt, meter, value, unit, typeName, readingDate, ts) {
    if (!receivedData[house])               receivedData[house] = {};
    if (!receivedData[house][apt])          receivedData[house][apt] = {};
    if (!receivedData[house][apt][meter])   receivedData[house][apt][meter] = { unit, typeName, history: [] };

    const entry = receivedData[house][apt][meter];
    entry.latest     = value;
    entry.latestDate = readingDate;
    entry.unit       = unit;
    entry.typeName   = typeName;

    // Nur in Cache-History hinzufügen wenn noch nicht vorhanden
    if (!entry.history.some(h => h.ts === ts)) {
        entry.history.push({ value, readingDate, ts });
        entry.history.sort((a, b) => a.ts - b.ts);
    }
}

// ─── Log-System ───────────────────────────────────────────────────────────────
const logBuffer = [];
let   logBufferMaxSize = 500;

const LVL = { DEBUG: 'debug', INFO: 'info', WARN: 'warn', ERROR: 'error' };
const CAT = { SYSTEM: 'SYSTEM', AUTH: 'AUTH', CONNECT: 'CONNECT', DATAPOINT: 'DATAPOINT', SYNC: 'SYNC', HISTORY: 'HISTORY', IMPORT: 'IMPORT' };

function log(level, category, message, detail) {
    const fullMsg = detail ? `[${category}] ${message} — ${detail}` : `[${category}] ${message}`;
    switch (level) {
        case LVL.DEBUG: adapter.log.debug(fullMsg); break;
        case LVL.WARN:  adapter.log.warn(fullMsg);  break;
        case LVL.ERROR: adapter.log.error(fullMsg); break;
        default:        adapter.log.info(fullMsg);  break;
    }
    if (!adapter.config.verboseLogging && level === LVL.DEBUG) return;
    logBuffer.push({ ts: Date.now(), level, category, message, detail: detail || null });
    while (logBuffer.length > logBufferMaxSize) logBuffer.shift();
}

// ─── ready ────────────────────────────────────────────────────────────────────
adapter.on('ready', async () => {
    logBufferMaxSize = parseInt(adapter.config?.logBufferSize) || 500;
    log(LVL.INFO, CAT.SYSTEM, `MeterMaster Adapter v1.0.0 gestartet`,
        `Port: ${adapter.config.port || 8089} | Logging: ${adapter.config.verboseLogging ? 'ausführlich' : 'standard'} | Puffer: ${logBufferMaxSize}`);

    await adapter.setStateAsync('info.connection',       { val: false, ack: true });
    await adapter.setStateAsync('info.lastSync',         { val: '',    ack: true });
    await adapter.setStateAsync('info.readingsReceived', { val: 0,     ack: true });

    const savedState = await adapter.getStateAsync('info.readingsReceived');
    if (savedState && typeof savedState.val === 'number') {
        readingsReceived = savedState.val;
        log(LVL.DEBUG, CAT.SYSTEM, `Zähler wiederhergestellt`, `${readingsReceived} Ablesungen bisher`);
    }
    startHttpServer();
});

adapter.on('unload', (callback) => {
    log(LVL.INFO, CAT.SYSTEM, 'Adapter wird gestoppt');
    try { if (server) { server.close(() => callback()); } else { callback(); } }
    catch (e) { callback(); }
});

// ─── HTTP-Server ──────────────────────────────────────────────────────────────
function startHttpServer() {
    const port     = parseInt(adapter.config.port)     || 8089;
    const user     = (adapter.config.user     || '').trim();
    const password = (adapter.config.password || '').trim();

    server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin',  '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

        const url      = req.url.split('?')[0];
        const clientIp = req.socket.remoteAddress || '?';

        // Web-UI und read-only API ohne Auth
        if (req.method === 'GET' && (url === '/' || url === '/logs' || url === '/data' || url === '/import')) {
            serveWebApp(res, port); return;
        }
        if (req.method === 'GET'  && url === '/api/logs')  { serveLogsJson(req, res);  return; }
        if (req.method === 'GET'  && url === '/api/stats') { serveStats(res);           return; }
        if (req.method === 'GET'  && url === '/api/data')  { serveDataJson(res);        return; }

        // Basic Auth für schreibende Endpunkte
        if (user && password) {
            const authHeader = req.headers['authorization'] || '';
            if (!authHeader.startsWith('Basic ')) {
                log(LVL.WARN, CAT.AUTH, `Kein Auth-Header`, `IP: ${clientIp} | ${url}`);
                res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="MeterMaster"' });
                res.end(JSON.stringify({ error: 'Authentifizierung erforderlich' })); return;
            }
            const decoded  = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
            const colonIdx = decoded.indexOf(':');
            const reqUser  = colonIdx >= 0 ? decoded.slice(0, colonIdx)  : decoded;
            const reqPass  = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : '';
            let authOk = false;
            try {
                const maxU = Math.max(reqUser.length, user.length, 1);
                const maxP = Math.max(reqPass.length, password.length, 1);
                const uBuf = Buffer.alloc(maxU); Buffer.from(reqUser,   'utf-8').copy(uBuf);
                const pBuf = Buffer.alloc(maxP); Buffer.from(reqPass,   'utf-8').copy(pBuf);
                const uRef = Buffer.alloc(maxU); Buffer.from(user,     'utf-8').copy(uRef);
                const pRef = Buffer.alloc(maxP); Buffer.from(password, 'utf-8').copy(pRef);
                authOk = crypto.timingSafeEqual(uBuf, uRef) && crypto.timingSafeEqual(pBuf, pRef);
            } catch { authOk = false; }
            if (!authOk) {
                log(LVL.WARN, CAT.AUTH, `Ungültige Zugangsdaten`, `IP: ${clientIp} | User: "${reqUser}"`);
                res.writeHead(403); res.end(JSON.stringify({ error: 'Ungültige Zugangsdaten' })); return;
            }
            log(LVL.DEBUG, CAT.AUTH, `Auth OK`, `IP: ${clientIp} | User: "${reqUser}"`);
        }

        if      (req.method === 'GET'  && url === '/api/ping')     { handlePing(res, clientIp); }
        else if (req.method === 'POST' && url === '/api/reading')  { readBody(req, b => handleReading(b, res, clientIp)); }
        else if (req.method === 'POST' && url === '/api/readings') { readBody(req, b => handleReadings(b, res, clientIp)); }
        else if (req.method === 'POST' && url === '/api/import')   { readBody(req, b => handleImport(b, res, clientIp)); }
        else {
            log(LVL.WARN, CAT.CONNECT, `Unbekannte URL`, `${req.method} ${url} von ${clientIp}`);
            res.writeHead(404); res.end(JSON.stringify({ error: 'Nicht gefunden' }));
        }
    });

    server.on('error', err => {
        log(LVL.ERROR, CAT.SYSTEM, `HTTP-Fehler: ${err.message}`,
            err.code === 'EADDRINUSE' ? `Port ${port} belegt!` : undefined);
    });
    server.listen(port, '0.0.0.0', () => {
        log(LVL.INFO, CAT.SYSTEM, `Lauscht auf Port ${port}`, `Web-UI: http://IP:${port}/`);
        adapter.setState('info.connection', { val: true, ack: true });
    });
}

// ─── Ping ─────────────────────────────────────────────────────────────────────
function handlePing(res, clientIp) {
    log(LVL.DEBUG, CAT.CONNECT, `Ping`, `IP: ${clientIp}`);
    sendJson(res, 200, { ok: true, adapter: 'metermaster', version: '1.0.0', received: readingsReceived });
}

// ─── Einzelne Ablesung ────────────────────────────────────────────────────────
async function handleReading(body, res, clientIp) {
    let data;
    try { data = JSON.parse(body); } catch {
        log(LVL.WARN, CAT.SYNC, `Ungültiges JSON`, `IP: ${clientIp}`);
        sendJson(res, 400, { error: 'Ungültiges JSON' }); return;
    }
    const err = validateReading(data);
    if (err) { log(LVL.WARN, CAT.SYNC, `Validierungsfehler`, err); sendJson(res, 422, { error: err }); return; }
    log(LVL.INFO, CAT.SYNC, `Ablesung empfangen`,
        `${data.house}/${data.apartment}/${data.meter} = ${data.value} ${data.unit||''} (${data.readingDate})`);
    try {
        const path = await storeReading(data);
        sendJson(res, 200, { ok: true, path });
    } catch (e) {
        log(LVL.ERROR, CAT.SYNC, `Speicherfehler`, e.message);
        sendJson(res, 500, { error: e.message });
    }
}

// ─── Batch ────────────────────────────────────────────────────────────────────
async function handleReadings(body, res, clientIp) {
    let items;
    try { items = JSON.parse(body); if (!Array.isArray(items)) items = [items]; } catch {
        log(LVL.WARN, CAT.SYNC, `Ungültiges JSON im Batch`, `IP: ${clientIp}`);
        sendJson(res, 400, { error: 'Array erwartet' }); return;
    }
    log(LVL.INFO, CAT.SYNC, `Batch empfangen`, `IP: ${clientIp} | ${items.length} Ablesungen`);
    let stored = 0, failed = 0;
    const errors = [];
    for (const data of items) {
        const err = validateReading(data);
        if (err) { failed++; errors.push(`${data.meter||'?'}: ${err}`); continue; }
        try { await storeReading(data); stored++; }
        catch (e) { failed++; errors.push(`${data.meter||'?'}: ${e.message}`); log(LVL.ERROR, CAT.SYNC, `Batch-Fehler`, `${data.meter}: ${e.message}`); }
    }
    const summary = `${stored} gespeichert, ${failed} fehlgeschlagen`;
    if (failed === 0) log(LVL.INFO, CAT.SYNC, `Batch ✓`, summary);
    else              log(LVL.WARN, CAT.SYNC, `Batch mit Fehlern`, summary);
    sendJson(res, 200, { ok: failed === 0, stored, failed, errors });
}

// ─── Import (App-Export Schema 2.0) ──────────────────────────────────────────
async function handleImport(body, res, clientIp) {
    let data;
    try { data = JSON.parse(body); } catch {
        log(LVL.WARN, CAT.IMPORT, `Ungültiges JSON`, `IP: ${clientIp}`);
        sendJson(res, 400, { error: 'Ungültiges JSON' }); return;
    }

    // Schema-Prüfung
    if (!data.Apartments || !data.Meters || !data.Readings) {
        sendJson(res, 422, { error: 'Ungültiges Format: Apartments, Meters und Readings erforderlich' }); return;
    }

    const schema  = data.SchemaVersion || '1.0';
    const house   = data.HouseName || adapter.config.houseName || 'MeinHaus';
    log(LVL.INFO, CAT.IMPORT, `Import gestartet`,
        `Schema: ${schema} | ${data.Apartments.length} Wohnungen | ${data.Meters.length} Zähler | ${data.Readings.length} Ablesungen | IP: ${clientIp}`);

    // ID-Maps aufbauen: JSON-Id → Objekt
    const aptMap   = {};  // aptId   → Apartment
    const meterMap = {};  // meterId → Meter

    for (const apt of data.Apartments)  aptMap[apt.Id]   = apt;
    for (const m   of data.Meters)      meterMap[m.Id]   = m;

    let stored = 0, skipped = 0, failed = 0;
    const errors = [];

    for (const reading of data.Readings) {
        const meter = meterMap[reading.MeterId];
        if (!meter) {
            skipped++;
            log(LVL.WARN, CAT.IMPORT, `Zähler nicht gefunden`, `MeterId: ${reading.MeterId}`);
            continue;
        }

        const apt = meter.ApartmentId ? aptMap[meter.ApartmentId] : null;

        const payload = {
            house:       house,
            apartment:   apt ? apt.Name : 'shared',
            meter:       meter.Name,
            value:       reading.Value,
            unit:        meter.Unit     || '',
            typeName:    meter.TypeName || (meter.Type !== undefined ? String(meter.Type) : ''),
            readingDate: reading.ReadingDate,
        };

        const err = validateReading(payload);
        if (err) {
            skipped++;
            log(LVL.WARN, CAT.IMPORT, `Ungültige Ablesung übersprungen`, `${meter.Name}: ${err}`);
            continue;
        }

        try {
            await storeReading(payload);
            stored++;
        } catch (e) {
            failed++;
            errors.push(`${meter.Name}: ${e.message}`);
            log(LVL.ERROR, CAT.IMPORT, `Speicherfehler`, `${meter.Name}: ${e.message}`);
        }
    }

    const summary = `${stored} importiert, ${skipped} übersprungen, ${failed} fehlgeschlagen`;
    if (failed === 0) log(LVL.INFO, CAT.IMPORT, `Import abgeschlossen ✓`, summary);
    else              log(LVL.WARN, CAT.IMPORT, `Import mit Fehlern`,      summary);

    sendJson(res, 200, { ok: failed === 0, stored, skipped, failed, errors, summary });
}

// ─── Kernspeicherlogik ────────────────────────────────────────────────────────
async function storeReading(data) {
    const house  = sanitize(data.house);
    const apt    = sanitize(data.apartment);
    const meter  = sanitize(data.meter);
    const base   = `${house}.${apt}.${meter}`;
    const ts     = new Date(data.readingDate).getTime();
    const value  = parseFloat(data.value);

    const isNew = await ensureChannel(`${house}`, data.house);
    await ensureChannel(`${house}.${apt}`,  data.apartment);
    await ensureChannel(`${base}`,          data.meter);
    await ensureChannel(`${base}.readings`, 'Ablesungen');

    if (isNew) log(LVL.INFO, CAT.DATAPOINT, `Neuer Zähler`, `metermaster.0.${base}`);

    const dpNew = await ensureState(`${base}.readings.latest`,     { name: `${data.meter} – Letzter Wert`, type: 'number', role: 'value', unit: data.unit||'', read: true, write: false });
    await ensureState(`${base}.readings.latestDate`, { name: 'Ablesedatum',          type: 'string', role: 'value.datetime', read: true, write: false });
    await ensureState(`${base}.name`,                { name: 'Zählername',           type: 'string', role: 'info.name',      read: true, write: false });
    await ensureState(`${base}.unit`,                { name: 'Einheit',              type: 'string', role: 'value.unit',     read: true, write: false });
    await ensureState(`${base}.typeName`,            { name: 'Zählertyp',            type: 'string', role: 'info.type',      read: true, write: false });
    await ensureState(`${base}.readings.history`,    { name: 'Historische Ablesungen', type: 'array', role: 'list',          read: true, write: false });

    if (dpNew) log(LVL.INFO, CAT.DATAPOINT, `Datenpunkte angelegt`, `${base}.readings.{latest,latestDate,history} + name/unit/typeName`);

    await adapter.setStateAsync(`${base}.readings.latest`,     { val: value,              ts, ack: true });
    await adapter.setStateAsync(`${base}.readings.latestDate`, { val: data.readingDate,   ts, ack: true });
    await adapter.setStateAsync(`${base}.name`,                { val: data.meter,         ts, ack: true });
    await adapter.setStateAsync(`${base}.unit`,                { val: data.unit||'',      ts, ack: true });
    await adapter.setStateAsync(`${base}.typeName`,            { val: data.typeName||'',  ts, ack: true });

    log(LVL.DEBUG, CAT.SYNC, `State geschrieben`, `metermaster.0.${base} = ${value} ${data.unit||''} | ${data.readingDate}`);

    const histResult = await updateHistory(base, { value, unit: data.unit||'', readingDate: data.readingDate, ts });
    if (histResult === 'added')     log(LVL.DEBUG, CAT.HISTORY, `Historie +1`, `${base} @ ${data.readingDate}`);
    if (histResult === 'duplicate') log(LVL.DEBUG, CAT.HISTORY, `Duplikat`,    `${base} @ ${data.readingDate}`);

    // In-Memory-Cache aktualisieren
    cacheReading(house, apt, meter, value, data.unit||'', data.typeName||'', data.readingDate, ts);

    readingsReceived++;
    await adapter.setStateAsync('info.lastSync',         { val: new Date().toISOString(), ack: true });
    await adapter.setStateAsync('info.readingsReceived', { val: readingsReceived,         ack: true });
    return base;
}

// ─── Historie ─────────────────────────────────────────────────────────────────
async function updateHistory(base, entry) {
    const stateId = `${base}.readings.history`;
    const keep    = parseInt(adapter.config.keepHistory) || 0;
    let   history = [];
    try {
        const ex = await adapter.getStateAsync(stateId);
        if (ex && ex.val) { history = JSON.parse(ex.val); if (!Array.isArray(history)) history = []; }
    } catch { history = []; }
    if (history.some(h => h.ts === entry.ts)) return 'duplicate';
    history.push(entry);
    history.sort((a, b) => a.ts - b.ts);
    if (keep > 0 && history.length > keep) history = history.slice(history.length - keep);
    await adapter.setStateAsync(stateId, { val: JSON.stringify(history), ts: entry.ts, ack: true });
    return 'added';
}

// ─── Objekt-Helfer ────────────────────────────────────────────────────────────
async function ensureChannel(id, name) {
    const ex = await adapter.getObjectAsync(id).catch(() => null);
    if (ex) return false;
    await adapter.setObjectNotExistsAsync(id, { type: 'channel', common: { name: name||id }, native: {} });
    return true;
}
async function ensureState(id, common) {
    const ex = await adapter.getObjectAsync(id).catch(() => null);
    if (ex) return false;
    await adapter.setObjectNotExistsAsync(id, {
        type: 'state',
        common: { ...common,
            read:  common.read  !== undefined ? common.read  : true,
            write: common.write !== undefined ? common.write : false,
            def:   common.type  === 'number'  ? 0 : (common.type === 'array' ? '[]' : '')
        },
        native: {}
    });
    return true;
}

// ─── API Endpunkte ────────────────────────────────────────────────────────────
function serveDataJson(res) {
    sendJson(res, 200, { data: receivedData, receivedTotal: readingsReceived });
}
function serveLogsJson(req, res) {
    const u        = new URL(req.url, 'http://localhost');
    const since    = parseInt(u.searchParams.get('since')    || '0');
    const level    = u.searchParams.get('level')    || '';
    const category = u.searchParams.get('category') || '';
    const limit    = parseInt(u.searchParams.get('limit')    || '200');
    let   entries  = logBuffer.filter(e => e.ts > since);
    if (level)    entries = entries.filter(e => e.level    === level);
    if (category) entries = entries.filter(e => e.category === category);
    sendJson(res, 200, {
        entries:  entries.slice(-limit),
        total:    logBuffer.length,
        maxSize:  logBufferMaxSize,
        newest:   logBuffer.length ? logBuffer[logBuffer.length-1].ts : 0
    });
}
function serveStats(res) {
    sendJson(res, 200, {
        adapter: 'metermaster', version: '1.0.0',
        readingsReceived, logEntries: logBuffer.length, uptime: process.uptime()
    });
}

// ─── Web-Oberfläche ───────────────────────────────────────────────────────────
function serveWebApp(res, port) {
const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MeterMaster</title>
<style>
:root{--bg:#0f0f1a;--bg2:#1a1a2e;--bg3:#16213e;--border:#2d2b55;--acc:#7c3aed;--acc2:#a78bfa;--text:#e2e8f0;--muted:#64748b;--debug:#60a5fa;--info:#34d399;--warn:#fbbf24;--err:#f87171;--card:#1e1b38;}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;}
header{background:linear-gradient(135deg,#1e0e5a,#2d1b69);border-bottom:1px solid var(--border);padding:12px 20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;flex-shrink:0;}
.logo{font-size:1.3em;font-weight:700;color:var(--acc2);}.logo span{font-weight:300;color:var(--text);}
.hstats{display:flex;gap:16px;margin-left:auto;flex-wrap:wrap;}
.hstat{font-size:.8em;color:var(--muted);}.hstat b{color:var(--acc2);}
nav{background:var(--bg2);border-bottom:1px solid var(--border);padding:0 20px;display:flex;gap:0;flex-shrink:0;}
.tab{padding:12px 20px;cursor:pointer;font-size:.9em;color:var(--muted);border-bottom:3px solid transparent;transition:all .2s;user-select:none;}
.tab:hover{color:var(--text);}
.tab.active{color:var(--acc2);border-bottom-color:var(--acc);}
.page{flex:1;overflow-y:auto;padding:20px;display:none;}
.page.active{display:block;}

/* ── Daten-Tab ── */
.house-block{margin-bottom:24px;}
.house-title{font-size:1.1em;font-weight:700;color:var(--acc2);margin-bottom:12px;display:flex;align-items:center;gap:8px;}
.apt-block{margin-bottom:16px;margin-left:12px;}
.apt-title{font-size:.95em;font-weight:600;color:#94a3b8;margin-bottom:8px;padding-left:10px;border-left:3px solid var(--border);}
.meters-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;margin-left:22px;}
.meter-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px;transition:border-color .2s;}
.meter-card:hover{border-color:var(--acc);}
.mc-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;}
.mc-name{font-weight:600;font-size:1em;}
.mc-type{font-size:.75em;color:var(--muted);background:var(--bg3);padding:2px 8px;border-radius:12px;}
.mc-value{font-size:1.8em;font-weight:700;color:var(--acc2);line-height:1;}
.mc-unit{font-size:.85em;color:var(--muted);margin-left:4px;}
.mc-date{font-size:.78em;color:var(--muted);margin-top:4px;}
.mc-hist-btn{font-size:.75em;color:var(--acc);cursor:pointer;margin-top:8px;display:inline-block;}
.mc-hist-btn:hover{color:var(--acc2);}
.mc-history{display:none;margin-top:10px;border-top:1px solid var(--border);padding-top:8px;max-height:200px;overflow-y:auto;}
.mc-history.open{display:block;}
.hist-row{display:flex;justify-content:space-between;font-size:.78em;padding:3px 0;color:var(--muted);border-bottom:1px solid rgba(255,255,255,.04);}
.hist-row:last-child{border:none;}
.hist-val{color:var(--text);font-weight:600;}
.empty-state{text-align:center;padding:60px 20px;color:var(--muted);}
.empty-state .ico{font-size:3em;margin-bottom:12px;}

/* ── Import-Tab ── */
.import-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:680px;}
.import-card h3{font-size:1.1em;margin-bottom:8px;color:var(--acc2);}
.import-card p{font-size:.88em;color:var(--muted);margin-bottom:16px;line-height:1.6;}
.schema-box{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:12px;font-family:monospace;font-size:.78em;color:#90CAF9;margin-bottom:16px;white-space:pre;overflow-x:auto;}
.drop-zone{border:2px dashed var(--border);border-radius:10px;padding:32px;text-align:center;cursor:pointer;transition:all .2s;margin-bottom:16px;}
.drop-zone:hover,.drop-zone.drag{border-color:var(--acc);background:rgba(124,58,237,.08);}
.drop-zone .ico{font-size:2.5em;margin-bottom:8px;}
.drop-zone p{color:var(--muted);font-size:.88em;}
input[type=file]{display:none;}
.preview-box{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px;display:none;}
.preview-box h4{font-size:.9em;color:var(--acc2);margin-bottom:10px;}
.preview-stat{display:flex;justify-content:space-between;font-size:.85em;padding:4px 0;border-bottom:1px solid var(--border);}
.preview-stat:last-child{border:none;}
.preview-stat span{color:var(--muted);}
.preview-stat b{color:var(--text);}
.imp-house-row{display:flex;align-items:center;gap:10px;margin-bottom:12px;}
.imp-house-row label{font-size:.88em;color:var(--muted);}
input[type=text]{background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:7px 12px;border-radius:7px;font-size:.88em;width:220px;}
input[type=text]:focus{outline:none;border-color:var(--acc);}
button.primary{background:var(--acc);color:#fff;border:none;padding:10px 22px;border-radius:8px;cursor:pointer;font-size:.9em;transition:opacity .2s;}
button.primary:hover{opacity:.85;}
button.primary:disabled{opacity:.4;cursor:default;}
button.sec{background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:8px 16px;border-radius:8px;cursor:pointer;font-size:.88em;}
.result-box{border-radius:8px;padding:14px;font-size:.88em;margin-top:16px;display:none;}
.result-box.ok{background:#0d2818;border:1px solid #1b5e20;color:#a5d6a7;}
.result-box.warn{background:#1a1400;border:1px solid #f59e0b;color:#fcd34d;}
.result-box.err{background:#1a0808;border:1px solid #991b1b;color:#fca5a5;}

/* ── Log-Tab ── */
.log-toolbar{background:var(--bg2);border-bottom:1px solid var(--border);padding:10px 20px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;flex-shrink:0;margin:-20px -20px 16px -20px;}
select{background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;font-size:.85em;}
input.search{background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;font-size:.85em;width:180px;}
.lbl{font-size:.82em;color:var(--muted);display:flex;align-items:center;gap:6px;}
#lc{font-family:'Cascadia Code','Fira Code',Consolas,monospace;font-size:.8em;}
.le{display:grid;grid-template-columns:90px 52px 90px 1fr;gap:0 10px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.03);align-items:start;}
.le:hover{background:rgba(124,58,237,.06);}
.le.new{animation:fi .4s;}@keyframes fi{from{background:rgba(124,58,237,.25)}to{background:transparent}}
.ts{color:var(--muted);font-size:.88em;white-space:nowrap;}
.bdg{display:inline-block;padding:1px 6px;border-radius:4px;font-size:.72em;font-weight:700;}
.ld{color:var(--debug);}.li{color:var(--info);}.lw{color:var(--warn);}.le2{color:var(--err);font-weight:600;}
.cAUTH{color:#c084fc;}.cCONNECT{color:#38bdf8;}.cDATAPOINT{color:#4ade80;}.cSYNC{color:#fb923c;}.cHISTORY{color:#e879f9;}.cSYSTEM{color:#94a3b8;}.cIMPORT{color:#f0abfc;}
.msg{color:var(--text);}.det{color:var(--muted);font-size:.9em;}
.log-empty{text-align:center;padding:40px;color:var(--muted);}
#ni{position:fixed;bottom:20px;right:20px;background:var(--acc);color:#fff;padding:8px 16px;border-radius:20px;font-size:.85em;cursor:pointer;display:none;box-shadow:0 4px 20px rgba(124,58,237,.4);}
</style>
</head>
<body>

<header>
  <div class="logo">⚡ MeterMaster <span>Adapter</span></div>
  <div class="hstats">
    <div class="hstat">Ablesungen: <b id="st-rx">–</b></div>
    <div class="hstat">Logs: <b id="st-lg">–</b></div>
    <div class="hstat">Uptime: <b id="st-up">–</b></div>
    <div class="hstat" id="st-live" style="color:var(--info)">● Live</div>
  </div>
</header>

<nav>
  <div class="tab active" onclick="showTab('data')"   id="tab-data">📊 Daten</div>
  <div class="tab"        onclick="showTab('import')" id="tab-import">📥 Import</div>
  <div class="tab"        onclick="showTab('logs')"   id="tab-logs">📋 Logs</div>
</nav>

<!-- ══ TAB: DATEN ══════════════════════════════════════════════════════════════ -->
<div class="page active" id="page-data">
  <div id="data-container">
    <div class="empty-state"><div class="ico">📡</div><p>Noch keine Ablesungen empfangen.<br>Starte einen Sync in der MeterMaster App.</p></div>
  </div>
</div>

<!-- ══ TAB: IMPORT ════════════════════════════════════════════════════════════ -->
<div class="page" id="page-import">
  <div class="import-card">
    <h3>📥 App-Backup importieren</h3>
    <p>Importiere einen Backup-Export aus der MeterMaster App direkt in den Adapter. Alle Ablesungen werden mit ihren originalen Zeitstempeln gespeichert — ideal für die erstmalige Befüllung oder das Nachführen historischer Daten.</p>

    <p style="font-size:.85em;color:#90CAF9;margin-bottom:6px;"><b>Kompatibles Format (Schema 2.0):</b></p>
    <div class="schema-box">{ "SchemaVersion": "2.0", "Source": "MeterMaster",
  "Apartments": [ { "Id": 1, "Name": "Westerheim", "ExternalId": "..." } ],
  "Meters":     [ { "Id": 1, "Name": "Warmwasser", "ApartmentId": 1, "Unit": "m³", ... } ],
  "Readings":   [ { "MeterId": 1, "Value": 128.75, "ReadingDate": "2024-02-12T09:30:00" } ]
}</div>

    <div class="imp-house-row">
      <label>Hausname (ioBroker-Pfad):</label>
      <input type="text" id="imp-house" value="MeinHaus" placeholder="z.B. MeinHaus">
    </div>

    <div class="drop-zone" id="drop-zone" onclick="document.getElementById('file-in').click()">
      <div class="ico">📂</div>
      <p>JSON-Datei hier ablegen oder klicken zum Auswählen</p>
    </div>
    <input type="file" id="file-in" accept=".json">

    <div class="preview-box" id="preview-box">
      <h4>📋 Vorschau</h4>
      <div id="preview-content"></div>
    </div>

    <div style="display:flex;gap:10px;align-items:center;">
      <button class="primary" id="imp-btn" disabled onclick="doImport()">⬆ Importieren</button>
      <button class="sec" onclick="clearImport()">✕ Zurücksetzen</button>
    </div>

    <div class="result-box" id="imp-result"></div>
  </div>
</div>

<!-- ══ TAB: LOGS ══════════════════════════════════════════════════════════════ -->
<div class="page" id="page-logs">
  <div class="log-toolbar">
    <select id="fl"><option value="">Alle Level</option><option value="debug">DEBUG</option><option value="info">INFO</option><option value="warn">WARN</option><option value="error">ERROR</option></select>
    <select id="fc"><option value="">Alle Kategorien</option><option value="SYSTEM">SYSTEM</option><option value="AUTH">AUTH</option><option value="CONNECT">CONNECT</option><option value="DATAPOINT">DATAPOINT</option><option value="SYNC">SYNC</option><option value="HISTORY">HISTORY</option><option value="IMPORT">IMPORT</option></select>
    <input class="search" type="text" id="ft" placeholder="Suche…">
    <button class="sec" onclick="clearLogs()">🗑 Leeren</button>
    <button class="sec" onclick="exportLogs()">⬇ Export</button>
    <label class="lbl"><input type="checkbox" id="as" checked> Auto-Scroll</label>
    <label class="lbl"><input type="checkbox" id="ar" checked> Live</label>
  </div>
  <div id="lc"><div class="log-empty" id="log-empty">Keine Log-Einträge vorhanden.</div></div>
</div>

<div id="ni" onclick="scrollLogBottom()">↓ Neue Einträge</div>

<script>
// ── Tab-Navigation ────────────────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-'+name).classList.add('active');
  document.getElementById('page-'+name).classList.add('active');
  if (name === 'data')  fetchData();
  if (name === 'logs')  scrollLogBottom();
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fmtTs = ts => {
  const d = new Date(ts);
  return d.toLocaleDateString('de-DE') + ' ' + d.toLocaleTimeString('de-DE',{hour12:false});
};
const fmtUp = s => Math.floor(s/3600)+'h '+Math.floor(s%3600/60)+'m '+Math.floor(s%60)+'s';

// ── Stats ─────────────────────────────────────────────────────────────────────
async function fetchStats() {
  try {
    const d = await fetch('/api/stats').then(r=>r.json());
    document.getElementById('st-rx').textContent = d.readingsReceived;
    document.getElementById('st-lg').textContent = d.logEntries;
    document.getElementById('st-up').textContent = fmtUp(d.uptime);
    document.getElementById('st-live').textContent = '● Live';
    document.getElementById('st-live').style.color = 'var(--info)';
  } catch {
    document.getElementById('st-live').textContent = '✗ Getrennt';
    document.getElementById('st-live').style.color = 'var(--err)';
  }
}

// ── DATEN-TAB ─────────────────────────────────────────────────────────────────
const typeIcons = {
  Electricity:'⚡', Gas:'🔥', Water:'💧', HotWater:'🌡️', ColdWater:'❄️',
  Heat:'🏠', Cooling:'🧊', Oil:'🛢️', Other:'📟'
};

async function fetchData() {
  try {
    const d   = await fetch('/api/data').then(r=>r.json());
    const con = document.getElementById('data-container');

    if (!d.data || Object.keys(d.data).length === 0) {
      con.innerHTML = '<div class="empty-state"><div class="ico">📡</div><p>Noch keine Ablesungen empfangen.</p></div>';
      return;
    }

    let html = '';
    for (const [house, apts] of Object.entries(d.data)) {
      html += '<div class="house-block">';
      html += '<div class="house-title">🏠 ' + esc(house) + '</div>';
      for (const [apt, meters] of Object.entries(apts)) {
        html += '<div class="apt-block">';
        html += '<div class="apt-title">🏘 ' + esc(apt) + '</div>';
        html += '<div class="meters-grid">';
        for (const [meterKey, m] of Object.entries(meters)) {
          const icon = typeIcons[m.typeName] || '📟';
          const histId = 'hist-' + house + '-' + apt + '-' + meterKey;
          const histRows = (m.history||[]).slice().reverse().map(h =>
            '<div class="hist-row"><span>'+esc(fmtTs(h.ts))+'</span><span class="hist-val">'+h.value+' '+esc(m.unit||'')+'</span></div>'
          ).join('');
          html +=
            '<div class="meter-card">' +
              '<div class="mc-header">' +
                '<div class="mc-name">' + icon + ' ' + esc(meterKey) + '</div>' +
                '<div class="mc-type">' + esc(m.typeName||'') + '</div>' +
              '</div>' +
              '<div>' +
                '<span class="mc-value">' + (m.latest !== undefined ? m.latest : '–') + '</span>' +
                '<span class="mc-unit">' + esc(m.unit||'') + '</span>' +
              '</div>' +
              '<div class="mc-date">📅 ' + esc(m.latestDate ? fmtTs(new Date(m.latestDate).getTime()) : '–') + '</div>' +
              (histRows ? '<div class="mc-hist-btn" onclick="toggleHist(\''+histId+'\')">📈 Verlauf (' + (m.history||[]).length + ' Einträge)</div>' +
                          '<div class="mc-history" id="'+histId+'">' + histRows + '</div>' : '') +
            '</div>';
        }
        html += '</div></div>';
      }
      html += '</div>';
    }
    con.innerHTML = html;
  } catch(e) {
    document.getElementById('data-container').innerHTML = '<div class="empty-state"><div class="ico">⚠️</div><p>Fehler beim Laden: '+esc(e.message)+'</p></div>';
  }
}

function toggleHist(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('open');
}

// ── IMPORT-TAB ────────────────────────────────────────────────────────────────
let importData = null;

const dz = document.getElementById('drop-zone');
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
dz.addEventListener('dragleave', ()=> dz.classList.remove('drag'));
dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag'); loadFile(e.dataTransfer.files[0]); });
document.getElementById('file-in').addEventListener('change', e => loadFile(e.target.files[0]));

function loadFile(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = e => {
    try {
      importData = JSON.parse(e.target.result);
      showPreview(importData, file.name);
    } catch {
      showResult('err', '❌ Ungültige JSON-Datei');
    }
  };
  r.readAsText(file);
}

function showPreview(d, fname) {
  const pb = document.getElementById('preview-box');
  const pc = document.getElementById('preview-content');

  const schema = d.SchemaVersion || '?';
  const apts   = (d.Apartments||[]).length;
  const meters = (d.Meters||[]).length;
  const rdgs   = (d.Readings||[]).length;
  const valid  = d.Apartments && d.Meters && d.Readings;

  pc.innerHTML =
    row('Datei',       esc(fname)) +
    row('Schema',      schema) +
    row('Wohnungen',   apts) +
    row('Zähler',      meters) +
    row('Ablesungen',  rdgs) +
    row('Kompatibel',  valid ? '✅ Ja' : '❌ Nein (Felder fehlen)');

  pb.style.display = 'block';
  document.getElementById('imp-btn').disabled = !valid;
}

function row(label, val) {
  return '<div class="preview-stat"><span>' + label + '</span><b>' + val + '</b></div>';
}

async function doImport() {
  if (!importData) return;
  const house  = document.getElementById('imp-house').value.trim() || 'MeinHaus';
  const btn    = document.getElementById('imp-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Importiere…';

  // Haus ins Payload einbetten
  const payload = { ...importData, HouseName: house };

  try {
    const res  = await fetch('/api/import', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.ok) {
      showResult('ok', '✅ Import erfolgreich: ' + data.summary);
      fetchData(); fetchStats();
    } else {
      showResult('warn', '⚠️ ' + data.summary + (data.errors.length ? '<br>' + data.errors.slice(0,5).map(esc).join('<br>') : ''));
    }
  } catch(e) {
    showResult('err', '❌ Netzwerkfehler: ' + esc(e.message));
  } finally {
    btn.disabled    = false;
    btn.textContent = '⬆ Importieren';
  }
}

function showResult(type, msg) {
  const rb = document.getElementById('imp-result');
  rb.className   = 'result-box ' + type;
  rb.innerHTML   = msg;
  rb.style.display = 'block';
}

function clearImport() {
  importData = null;
  document.getElementById('file-in').value = '';
  document.getElementById('preview-box').style.display = 'none';
  document.getElementById('imp-result').style.display  = 'none';
  document.getElementById('imp-btn').disabled = true;
}

// ── LOG-TAB ───────────────────────────────────────────────────────────────────
let newestTs = 0, displayed = [], logTimer;
const lc = () => document.getElementById('lc');
const gf = () => ({
  level: document.getElementById('fl').value,
  cat:   document.getElementById('fc').value,
  txt:   document.getElementById('ft').value.toLowerCase()
});
const matchLog = (e,f) => {
  if (f.level && e.level    !== f.level) return false;
  if (f.cat   && e.category !== f.cat)   return false;
  if (f.txt   && !(e.message+' '+(e.detail||'')).toLowerCase().includes(f.txt)) return false;
  return true;
};
const lvlCls = l => ({debug:'ld',info:'li',warn:'lw',error:'le2'}[l]||'li');
const fmtLogTs = ts => {
  const d = new Date(ts);
  return d.toLocaleTimeString('de-DE',{hour12:false}) + '.' + String(d.getMilliseconds()).padStart(3,'0');
};

function renderLog(e, isNew) {
  const f = gf(); if (!matchLog(e,f)) return null;
  const d = document.createElement('div');
  d.className = 'le' + (isNew?' new':''); d.dataset.ts = e.ts;
  d.innerHTML =
    '<span class="ts">'  + fmtLogTs(e.ts) + '</span>' +
    '<span class="bdg '  + lvlCls(e.level) + '">' + e.level.toUpperCase() + '</span>' +
    '<span class="bdg c' + e.category + '">' + e.category + '</span>' +
    '<span class="msg">'  + esc(e.message) + (e.detail ? '<br><span class="det">' + esc(e.detail) + '</span>' : '') + '</span>';
  return d;
}

async function fetchLogs() {
  try {
    const f   = gf();
    const url = '/api/logs?since='+newestTs+'&limit=100' + (f.level?'&level='+f.level:'') + (f.cat?'&category='+f.cat:'');
    const d   = await fetch(url).then(r=>r.json());
    const c   = lc();
    const atB = c.scrollHeight - c.scrollTop - c.clientHeight < 80;

    if (d.entries.length > 0) {
      document.getElementById('log-empty').style.display = 'none';
      d.entries.forEach(e => { const el = renderLog(e,true); if(el) c.appendChild(el); displayed.push(e); });
      newestTs = d.newest;
      const rows = c.querySelectorAll('.le');
      if (rows.length > 1000) for (let i=0;i<rows.length-1000;i++) rows[i].remove();
      if (document.getElementById('as').checked && atB) scrollLogBottom();
      else if (!atB) document.getElementById('ni').style.display = 'block';
    }
    document.getElementById('st-lg').textContent = d.total;
  } catch {}
}

function scrollLogBottom() {
  const c = lc(); c.scrollTop = c.scrollHeight;
  document.getElementById('ni').style.display = 'none';
}
function clearLogs() {
  lc().querySelectorAll('.le').forEach(e=>e.remove());
  document.getElementById('log-empty').style.display = '';
  newestTs = Date.now(); displayed = [];
}
function applyLogFilter() {
  const f = gf();
  lc().querySelectorAll('.le').forEach(el => {
    const e = displayed.find(d=>d.ts==el.dataset.ts);
    if (e) el.style.display = matchLog(e,f) ? '' : 'none';
  });
}
function exportLogs() {
  const f = gf(); const data = displayed.filter(e=>matchLog(e,f));
  const txt = data.map(e=>'['+new Date(e.ts).toISOString()+'] ['+e.level.toUpperCase()+'] ['+e.category+'] '+e.message+(e.detail?' — '+e.detail:'')).join('\\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([txt],{type:'text/plain'}));
  a.download = 'metermaster-log-'+new Date().toISOString().slice(0,19)+'.txt';
  a.click();
}

['fl','fc'].forEach(id=>document.getElementById(id).addEventListener('change',applyLogFilter));
document.getElementById('ft').addEventListener('input',applyLogFilter);
document.getElementById('ar').addEventListener('change',e=>{if(e.target.checked)startLiveRefresh();else clearInterval(logTimer);});

function startLiveRefresh() {
  clearInterval(logTimer);
  logTimer = setInterval(async()=>{ await fetchLogs(); await fetchStats(); }, 3000);
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  // Logs vorladen
  try {
    const d = await fetch('/api/logs?limit=500').then(r=>r.json());
    if (d.entries.length > 0) {
      document.getElementById('log-empty').style.display = 'none';
      d.entries.forEach(e=>{const el=renderLog(e,false);if(el)lc().appendChild(el);});
      displayed = d.entries; newestTs = d.newest;
    }
  } catch {}

  // Daten vorladen
  await fetchData();
  await fetchStats();
  startLiveRefresh();
}

init();
</script>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
}

// ─── Validierung ──────────────────────────────────────────────────────────────
function validateReading(data) {
    if (!data)                                           return 'Leerer Body';
    if (!data.house)                                     return '"house" fehlt';
    if (!data.apartment)                                 return '"apartment" fehlt';
    if (!data.meter)                                     return '"meter" fehlt';
    if (data.value === undefined || data.value === null) return '"value" fehlt';
    if (isNaN(parseFloat(data.value)))                   return '"value" keine Zahl';
    if (!data.readingDate)                               return '"readingDate" fehlt';
    if (isNaN(new Date(data.readingDate).getTime()))     return '"readingDate" ungültig';
    return null;
}

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────
function sanitize(input) {
    if (!input) return 'unknown';
    return input
        .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue')
        .replace(/Ä/g,'Ae').replace(/Ö/g,'Oe').replace(/Ü/g,'Ue')
        .replace(/ß/g,'ss').replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_\-]/g,'')
        || 'unknown';
}
function readBody(req, cb) { let b=''; req.on('data',c=>{b+=c.toString();}); req.on('end',()=>cb(b)); }
function sendJson(res, status, data) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); }

if (require.main === module) { adapter.start(); }
module.exports = adapter;

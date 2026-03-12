'use strict';

const utils  = require('@iobroker/adapter-core');
const http   = require('http');
const crypto = require('crypto');
const https  = require('https');
const { exec } = require('child_process');

const CURRENT_VERSION = '0.5.0';
const GITHUB_REPO     = 'MPunktBPunkt/iobroker.metermaster';
const GITHUB_URL      = 'https://github.com/MPunktBPunkt/iobroker.metermaster';

// Node gilt als online wenn lastSeen < NODE_ONLINE_SEC Sekunden
const NODE_ONLINE_SEC = 120;

const adapter = new utils.Adapter('metermaster');

let server           = null;
let readingsReceived = 0;

// ─── In-Memory Datencache ─────────────────────────────────────────────────────
// Struktur: receivedData[house][apartment][meter] = { latest, latestDate, unit, typeName, history[] }
const receivedData = {};

// ─── ESP32 Node-Cache ─────────────────────────────────────────────────────────
// Struktur: nodesCache[mac] = { mac, ip, name, version, lastSeen, config, configAck }
const nodesCache = {};

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
const CAT = { SYSTEM: 'SYSTEM', AUTH: 'AUTH', CONNECT: 'CONNECT', DATAPOINT: 'DATAPOINT', SYNC: 'SYNC', HISTORY: 'HISTORY', IMPORT: 'IMPORT', NODE: 'NODE' };

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
    log(LVL.INFO, CAT.SYSTEM, `MeterMaster Adapter v${CURRENT_VERSION} gestartet`,
        `Port: ${adapter.config.port || 8089} | Logging: ${adapter.config.verboseLogging ? 'ausführlich' : 'standard'} | Puffer: ${logBufferMaxSize}`);

    await adapter.setStateAsync('info.connection', { val: false, ack: true });

    // readingsReceived aus persistentem State wiederherstellen
    const savedRx = await adapter.getStateAsync('info.readingsReceived');
    if (savedRx && typeof savedRx.val === 'number') {
        readingsReceived = savedRx.val;
    }

    // In-Memory-Cache aus gespeicherten ioBroker-States wiederherstellen
    await restoreCacheFromStates();
    await restoreNodesFromStates();

    // ESP32-Node-States beobachten (Heartbeat-Erkennung via simple-api)
    adapter.subscribeStates('nodes.*');

    startHttpServer();
});

adapter.on('unload', (callback) => {
    log(LVL.INFO, CAT.SYSTEM, 'Adapter wird gestoppt');
    try { if (server) { server.close(() => callback()); } else { callback(); } }
    catch (e) { callback(); }
});

// ─── State-Change-Handler (ESP32 Heartbeats via simple-api) ──────────────────
adapter.on('stateChange', async (id, state) => {
    if (!state || state.val === null) return;
    const ns       = `${adapter.namespace}.`;
    const relative = id.startsWith(ns) ? id.slice(ns.length) : id;
    const parts    = relative.split('.');
    if (parts.length < 3 || parts[0] !== 'nodes') return;

    const mac   = parts[1];
    const field = parts.slice(2).join('.');

    if (!nodesCache[mac]) nodesCache[mac] = { mac };

    if (field === 'ip')        nodesCache[mac].ip        = String(state.val);
    if (field === 'name')      nodesCache[mac].name      = String(state.val);
    if (field === 'version')   nodesCache[mac].version   = String(state.val);
    if (field === 'lastSeen')  nodesCache[mac].lastSeen  = Number(state.val);
    if (field === 'configAck') nodesCache[mac].configAck = String(state.val);
    if (field === 'config')    nodesCache[mac].config    = String(state.val);

    if (field === 'lastSeen') {
        const n = nodesCache[mac];
        log(LVL.INFO, CAT.NODE, `Heartbeat`, `${mac} | IP: ${n.ip || '?'} | v${n.version || '?'} | ${n.name || 'unbenannt'}`);
        await ensureNodeStates(mac);
    }
});

// ─── Cache-Wiederherstellung beim Start ───────────────────────────────────────
async function restoreCacheFromStates() {
    try {
        // getStatesAsync('*') gibt Keys MIT vollständigem Namespace zurück:
        // "metermaster.0.MeinHaus.Westerheim.Wasseruhr.readings.latest"
        const allStates = await adapter.getStatesAsync('*');
        if (!allStates) return;

        const ns = `${adapter.namespace}.`; // "metermaster.0."

        const latestKeys = Object.keys(allStates).filter(k =>
            k.endsWith('.readings.latest') && allStates[k] && allStates[k].val !== null
        );

        if (latestKeys.length === 0) {
            log(LVL.DEBUG, CAT.SYSTEM, 'Cache-Wiederherstellung', 'Keine gespeicherten Ablesungen gefunden');
            return;
        }

        let restored = 0;
        for (const key of latestKeys) {
            // Key ohne Namespace: "MeinHaus.Westerheim.Wasseruhr.readings.latest"
            const relative = key.startsWith(ns) ? key.slice(ns.length) : key;
            const parts    = relative.split('.');
            // Letzten 2 Teile ("readings", "latest") entfernen → [house, apt, meter, ...]
            const segments = parts.slice(0, parts.length - 2);
            if (segments.length < 3) continue;
            const [house, apt, ...meterParts] = segments;
            const meter = meterParts.join('.');

            const base = `${ns}${segments.join('.')}`;  // vollständiger Pfad mit Namespace

            const latest     = allStates[key]?.val;
            const latestDate = allStates[`${base}.readings.latestDate`]?.val || '';
            const unit       = allStates[`${base}.unit`]?.val               || '';
            const typeName   = allStates[`${base}.typeName`]?.val           || '';
            const histRaw    = allStates[`${base}.readings.history`]?.val   || '[]';

            let history = [];
            try { history = JSON.parse(histRaw); if (!Array.isArray(history)) history = []; } catch {}

            if (!receivedData[house])       receivedData[house] = {};
            if (!receivedData[house][apt])  receivedData[house][apt] = {};
            receivedData[house][apt][meter] = { latest, latestDate, unit, typeName, history };
            restored++;
        }

        log(LVL.INFO, CAT.SYSTEM, `Cache wiederhergestellt`, `${restored} Zähler aus ioBroker-States geladen`);
    } catch (e) {
        log(LVL.WARN, CAT.SYSTEM, 'Cache-Wiederherstellung fehlgeschlagen', e.message);
    }
}

// ─── ESP32 Node-Wiederherstellung beim Start ──────────────────────────────────
async function restoreNodesFromStates() {
    try {
        const allStates = await adapter.getStatesAsync('nodes.*');
        if (!allStates) return;
        const ns    = `${adapter.namespace}.`;
        let   count = 0;

        for (const [key, state] of Object.entries(allStates)) {
            if (!state || state.val === null) continue;
            const relative = key.startsWith(ns) ? key.slice(ns.length) : key;
            const parts    = relative.split('.');
            if (parts.length < 3 || parts[0] !== 'nodes') continue;
            const mac   = parts[1];
            const field = parts.slice(2).join('.');
            if (!nodesCache[mac]) { nodesCache[mac] = { mac }; count++; }
            if (field === 'ip')        nodesCache[mac].ip        = String(state.val);
            if (field === 'name')      nodesCache[mac].name      = String(state.val);
            if (field === 'version')   nodesCache[mac].version   = String(state.val);
            if (field === 'lastSeen')  nodesCache[mac].lastSeen  = Number(state.val);
            if (field === 'configAck') nodesCache[mac].configAck = String(state.val);
            if (field === 'config')    nodesCache[mac].config    = String(state.val);
        }
        if (count > 0) log(LVL.INFO, CAT.NODE, `Nodes wiederhergestellt`, `${count} ESP32-Node(s) aus States geladen`);
        else           log(LVL.DEBUG, CAT.NODE, 'Keine registrierten Nodes gefunden');
    } catch (e) {
        log(LVL.WARN, CAT.NODE, 'Node-Wiederherstellung fehlgeschlagen', e.message);
    }
}

// ─── ESP32 Node States anlegen ────────────────────────────────────────────────
async function ensureNodeStates(mac) {
    const base = `nodes.${mac}`;
    await ensureChannel('nodes',      'ESP32 Nodes');
    await ensureChannel(base,         `ESP32 Node ${mac}`);
    await ensureState(`${base}.ip`,        { name: 'IP-Adresse',           type: 'string', role: 'info.ip',      read: true, write: false });
    await ensureState(`${base}.name`,      { name: 'Gerätename',           type: 'string', role: 'info.name',    read: true, write: false });
    await ensureState(`${base}.version`,   { name: 'Firmware-Version',     type: 'string', role: 'info.version', read: true, write: false });
    await ensureState(`${base}.lastSeen`,  { name: 'Zuletzt gesehen (ms)', type: 'number', role: 'value.time',   read: true, write: false });
    await ensureState(`${base}.config`,    { name: 'Konfiguration (JSON)', type: 'string', role: 'value',        read: true, write: true  });
    await ensureState(`${base}.configAck`, { name: 'Config-Quittierung',   type: 'string', role: 'value',        read: true, write: false });
}

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
        if (req.method === 'GET' && (url === '/' || url === '/logs' || url === '/data' || url === '/import' || url === '/nodes')) {
            serveWebApp(res, port); return;
        }
        if (req.method === 'GET'  && url === '/api/logs')    { serveLogsJson(req, res);  return; }
        if (req.method === 'GET'  && url === '/api/stats')   { serveStats(res);           return; }
        if (req.method === 'GET'  && url === '/api/data')    { serveDataJson(res);        return; }
        if (req.method === 'GET'  && url === '/api/version') { serveVersion(res);        return; }
        if (req.method === 'GET'  && url === '/api/nodes')   { serveNodesJson(res);      return; }
        if (req.method === 'GET'  && url === '/api/discover'){ serveDiscoverJson(res);   return; }
        if (req.method === 'POST' && url === '/api/update')  { handleUpdate(req, res);   return; }

        // Favicon ohne Auth durchlassen (Browser ruft das automatisch ab)
        if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }

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
            // Node-Config: POST /api/nodes/{MAC}/config
            const nodeMatch = url.match(/^\/api\/nodes\/([A-Fa-f0-9]+)\/config$/);
            if (req.method === 'POST' && nodeMatch) {
                readBody(req, b => handleNodeConfig(nodeMatch[1].toUpperCase(), b, res, clientIp));
            } else {
                log(LVL.WARN, CAT.CONNECT, `Unbekannte URL`, `${req.method} ${url} von ${clientIp}`);
                res.writeHead(404); res.end(JSON.stringify({ error: 'Nicht gefunden' }));
            }
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
    sendJson(res, 200, { ok: true, adapter: 'metermaster', version: CURRENT_VERSION, received: readingsReceived });
}

// ─── Validierung ─────────────────────────────────────────────────────────────
function validateReading(data) {
    if (!data || typeof data !== 'object') return 'Kein Objekt';
    if (!data.house      || typeof data.house      !== 'string') return 'Pflichtfeld fehlt: house';
    if (!data.apartment  || typeof data.apartment  !== 'string') return 'Pflichtfeld fehlt: apartment';
    if (!data.meter      || typeof data.meter      !== 'string') return 'Pflichtfeld fehlt: meter';
    if (data.value === undefined || data.value === null)         return 'Pflichtfeld fehlt: value';
    if (isNaN(parseFloat(data.value)))                           return 'value muss eine Zahl sein';
    if (!data.readingDate)                                       return 'Pflichtfeld fehlt: readingDate';
    if (isNaN(new Date(data.readingDate).getTime()))             return 'readingDate: kein gültiges Datum';
    return null;
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
    const nodeCount   = Object.keys(nodesCache).length;
    const onlineCount = Object.values(nodesCache).filter(n =>
        n.lastSeen && (Date.now() - n.lastSeen) < NODE_ONLINE_SEC * 1000
    ).length;
    sendJson(res, 200, {
        adapter: 'metermaster', version: CURRENT_VERSION,
        readingsReceived, logEntries: logBuffer.length, uptime: process.uptime(),
        nodeCount, onlineCount
    });
}

// ─── Nodes API ────────────────────────────────────────────────────────────────
function serveNodesJson(res) {
    const now   = Date.now();
    const nodes = Object.values(nodesCache).map(n => ({
        mac:       n.mac,
        name:      n.name      || '',
        ip:        n.ip        || '',
        version:   n.version   || '',
        lastSeen:  n.lastSeen  || 0,
        online:    n.lastSeen  ? (now - n.lastSeen) < NODE_ONLINE_SEC * 1000 : false,
        config:    n.config    || '',
        configAck: n.configAck || '',
    }));
    nodes.sort((a, b) => b.lastSeen - a.lastSeen);
    sendJson(res, 200, nodes);
}

// ─── Discover: alle bekannten Zähler-State-IDs ───────────────────────────────
function serveDiscoverJson(res) {
    const result = [];
    const ns     = adapter.namespace;
    for (const [house, apts] of Object.entries(receivedData)) {
        for (const [apt, meters] of Object.entries(apts)) {
            for (const [meter, data] of Object.entries(meters)) {
                result.push({
                    stateId:   `${ns}.${house}.${apt}.${meter}.readings.latest`,
                    label:     meter,
                    unit:      data.unit     || '',
                    typeName:  data.typeName || '',
                    house, apartment: apt, meter,
                    latest:    data.latest,
                });
            }
        }
    }
    result.sort((a, b) =>
        `${a.house}/${a.apartment}/${a.meter}`.localeCompare(`${b.house}/${b.apartment}/${b.meter}`)
    );
    sendJson(res, 200, result);
}

// ─── Node Config schreiben ────────────────────────────────────────────────────
async function handleNodeConfig(mac, body, res, clientIp) {
    let data;
    try { data = JSON.parse(body); } catch {
        sendJson(res, 400, { error: 'Ungültiges JSON' }); return;
    }
    const sid   = (data.sid   || '').trim();
    const label = (data.label || '').trim();
    const unit  = (data.unit  || '').trim();

    const config = {
        sid,
        label,
        unit,
        carouselActive: data.carouselActive || false,
        carouselSec:    data.carouselSec    || 10,
        carousel:       data.carousel       || [],
    };
    const configStr = JSON.stringify(config);

    try {
        await ensureNodeStates(mac);
        await adapter.setStateAsync(`nodes.${mac}.config`, { val: configStr, ack: true });
        if (!nodesCache[mac]) nodesCache[mac] = { mac };
        nodesCache[mac].config = configStr;
        log(LVL.INFO, CAT.NODE, `Config gesetzt`, `${mac} \u2192 ${sid || '(leer)'} | IP: ${nodesCache[mac]?.ip || '?'}`);
        sendJson(res, 200, { ok: true, mac, config });
    } catch (e) {
        log(LVL.ERROR, CAT.NODE, `Config-Fehler`, `${mac}: ${e.message}`);
        sendJson(res, 500, { error: e.message });
    }
}

// ─── Web-Oberfläche ───────────────────────────────────────────────────────────
// ─── Versions-Check (GitHub) ──────────────────────────────────────────────────
function githubGet(path) {
    return new Promise((resolve, reject) => {
        const req = https.get({
            hostname: 'api.github.com',
            path,
            headers: { 'User-Agent': 'iobroker.metermaster' }
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch(e) { reject(e); } });
        });
        req.on('error', reject);
        req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

async function fetchGitHubVersion() {
    // 1. Versuch: Releases-API
    try {
        const r = await githubGet(`/repos/${GITHUB_REPO}/releases/latest`);
        if (r.status === 200 && r.body.tag_name) {
            return r.body.tag_name.replace(/^v/, '');
        }
    } catch(_) { /* weiter zum Fallback */ }

    // 2. Fallback: Tags-API (wenn noch keine Releases existieren)
    try {
        const r = await githubGet(`/repos/${GITHUB_REPO}/tags`);
        if (r.status === 200 && Array.isArray(r.body) && r.body.length > 0) {
            return r.body[0].name.replace(/^v/, '');
        }
    } catch(_) { /* weiter */ }

    return null; // kein Release und kein Tag → null statt '0.0.0'
}

function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i]||0) > (pb[i]||0)) return  1;
        if ((pa[i]||0) < (pb[i]||0)) return -1;
    }
    return 0;
}


async function serveVersion(res) {
    try {
        const latest      = await fetchGitHubVersion();
        const updateAvail = latest ? compareVersions(latest, CURRENT_VERSION) > 0 : false;
        sendJson(res, 200, { current: CURRENT_VERSION, latest, updateAvailable: updateAvail });
    } catch(e) {
        sendJson(res, 200, { current: CURRENT_VERSION, latest: null, updateAvailable: false, error: e.message });
    }
}

function handleUpdate(req, res) {
    log(LVL.INFO, CAT.SYSTEM, 'Update gestartet', `von ${CURRENT_VERSION} → GitHub`);
    const cmd = `iobroker upgrade metermaster ${GITHUB_URL}`;
    exec(cmd, { timeout: 180000 }, (err, stdout, stderr) => {
        const out = (stdout + '\n' + stderr).trim();
        if (err) {
            log(LVL.ERROR, CAT.SYSTEM, 'Update fehlgeschlagen', err.message);
            sendJson(res, 500, { ok: false, error: err.message, output: out });
        } else {
            log(LVL.INFO, CAT.SYSTEM, 'Update erfolgreich — starte neu…');
            sendJson(res, 200, { ok: true, output: out });
            setTimeout(() => exec('iobroker restart metermaster', () => {}), 2000);
        }
    });
}



function serveWebApp(res, port) {

// SVG-Logo identisch mit appicon.svg (inline, ohne width/height-Attribute)
const LOGO_SVG = `<svg viewBox="0 0 108 108" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="lbg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#3b1fa8"/>
      <stop offset="100%" stop-color="#1a0e5a"/>
    </linearGradient>
    <linearGradient id="larc" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0%" stop-color="#7c3aed"/>
      <stop offset="100%" stop-color="#a78bfa"/>
    </linearGradient>
    <filter id="lglow">
      <feGaussianBlur stdDeviation="1.2" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="108" height="108" rx="24" fill="url(#lbg)"/>
  <circle cx="54" cy="56" r="37" fill="none" stroke="#512BD4" stroke-width="2.5" opacity="0.6"/>
  <circle cx="54" cy="56" r="33" fill="#1e1252"/>
  <path d="M 37.5 84.6 A 33 33 0 1 1 70.5 84.6" fill="none" stroke="#2d1b80" stroke-width="5.5" stroke-linecap="round"/>
  <path d="M 37.5 84.6 A 33 33 0 0 1 54 23" fill="none" stroke="url(#larc)" stroke-width="5.5" stroke-linecap="round" filter="url(#lglow)"/>
  <g stroke="#6d4fc4" stroke-linecap="round">
    <line x1="54" y1="25" x2="54" y2="30" stroke-width="2"   transform="rotate(-120 54 56)"/>
    <line x1="54" y1="25" x2="54" y2="28" stroke-width="1.2" transform="rotate(-96 54 56)"/>
    <line x1="54" y1="25" x2="54" y2="28" stroke-width="1.2" transform="rotate(-72 54 56)"/>
    <line x1="54" y1="25" x2="54" y2="30" stroke-width="2"   transform="rotate(-48 54 56)"/>
    <line x1="54" y1="25" x2="54" y2="28" stroke-width="1.2" transform="rotate(-24 54 56)"/>
    <line x1="54" y1="25" x2="54" y2="30" stroke-width="2"   transform="rotate(0 54 56)"/>
    <line x1="54" y1="25" x2="54" y2="28" stroke-width="1.2" transform="rotate(24 54 56)"/>
    <line x1="54" y1="25" x2="54" y2="30" stroke-width="2"   transform="rotate(48 54 56)"/>
    <line x1="54" y1="25" x2="54" y2="28" stroke-width="1.2" transform="rotate(72 54 56)"/>
    <line x1="54" y1="25" x2="54" y2="28" stroke-width="1.2" transform="rotate(96 54 56)"/>
    <line x1="54" y1="25" x2="54" y2="30" stroke-width="2"   transform="rotate(120 54 56)"/>
  </g>
  <g transform="rotate(0 54 56)">
    <line x1="54" y1="56" x2="54" y2="29" stroke="white" stroke-width="2.2" stroke-linecap="round" filter="url(#lglow)"/>
    <line x1="54" y1="56" x2="54" y2="63" stroke="#512BD4" stroke-width="2.2" stroke-linecap="round"/>
  </g>
  <circle cx="54" cy="56" r="5" fill="#2d1b80" stroke="#7c3aed" stroke-width="1.5"/>
  <circle cx="54" cy="56" r="2" fill="#c4b5fd"/>
  <text x="54" y="93" font-family="Arial,sans-serif" font-weight="700" font-size="10" fill="#a78bfa" text-anchor="middle" letter-spacing="1.5">MM</text>
</svg>`;

// Typ-Icons nach typeName (spiegelt App-Icons wider)
const TYPE_ICONS = {
  Electricity:'⚡', Gas:'🔥', Water:'💧', HotWater:'🌡',
  ColdWater:'❄', Heat:'🏠', Cooling:'🧊', Oil:'🛢', Other:'📟'
};

const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MeterMaster</title>
<style>
/* ── Exakte App-Farben aus Colors.xaml ───────────────────────────────────── */
:root {
  /* Hintergründe */
  --bg-deep:    #0F0B1A;   /* BgDeep – Haupt-Seitenhintergrund */
  --bg-surface: #1A1430;   /* BgSurface – Karten/Panels */
  --bg-surface2:#241C40;   /* BgSurface2 – Eingabefelder */
  --bg-surface3:#2E2456;   /* BgSurface3 – Hover/aktiv */

  /* Akzentfarben */
  --primary:     #7B54C4;  /* Primary – Haupt-Lila */
  --primary-dark:#5C35A0;  /* PrimaryDark */
  --primary-deep:#3D2070;  /* PrimaryDeep */
  --secondary:   #C8B8FF;  /* Secondary – helles Lila, Text-Akzent */

  /* Status */
  --accent:  #4CAF50;      /* Grün */
  --danger:  #F44336;      /* Rot */
  --warning: #FF9800;      /* Orange */
  --info:    #2196F3;      /* Blau */

  /* Text */
  --text:        #E8E0FF;  /* TextPrimary */
  --text-dim:    #9585BB;  /* TextSecondary */
  --text-muted:  #5E4D8A;  /* TextMuted */

  /* Rahmen */
  --border:       #2A2050; /* BorderColor */
  --border-light: #3D2E6A; /* BorderLight */

  /* Log-Level-Farben */
  --log-debug: #9585BB;
  --log-info:  #4CAF50;
  --log-warn:  #FF9800;
  --log-error: #F44336;
}

* { box-sizing:border-box; margin:0; padding:0; }
body { background:var(--bg-deep); color:var(--text); font-family:'Segoe UI',system-ui,sans-serif; min-height:100vh; display:flex; flex-direction:column; }

/* ── Header ─────────────────────────────────────────────────────────────── */
header {
  background: linear-gradient(135deg, #3D2070 0%, #1A1430 100%);
  border-bottom: 1px solid var(--border-light);
  padding: 10px 20px;
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  flex-shrink: 0;
}
.logo-icon { width: 38px; height: 38px; flex-shrink: 0; }
.logo-text { display: flex; flex-direction: column; line-height: 1.15; }
.logo-title { font-size: 1.15em; font-weight: 700; color: var(--secondary); letter-spacing: .5px; }
.logo-sub   { font-size: .72em; color: var(--text-dim); letter-spacing: 1.5px; text-transform: uppercase; }
.hstats { display: flex; gap: 18px; margin-left: auto; flex-wrap: wrap; align-items: center; }
.hstat  { font-size: .78em; color: var(--text-dim); }
.hstat b { color: var(--secondary); }
.live-dot { font-size: .78em; color: var(--accent); }

/* ── Navigation ─────────────────────────────────────────────────────────── */
nav {
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border);
  padding: 0 20px;
  display: flex; flex-shrink: 0;
}
.tab {
  padding: 11px 22px; cursor: pointer !important; font-size: .88em;
  color: var(--text-dim); border-bottom: 3px solid transparent;
  transition: color .2s, border-color .2s; user-select: none;
  pointer-events: all !important;
  /* button-Reset */
  background: none; border-top: none; border-left: none; border-right: none;
  outline: none; font-family: inherit; -webkit-appearance: none; appearance: none;
}
.tab:hover { color: var(--text); }
.tab.active { color: var(--secondary); border-bottom-color: var(--primary); }

/* ── Seiten ──────────────────────────────────────────────────────────────── */
.page { flex:1; overflow-y:auto; padding:20px; display:none; }
.page.active { display:block; }

/* ── Daten-Tab ───────────────────────────────────────────────────────────── */
.house-block { margin-bottom: 28px; }
.house-title {
  font-size: 1em; font-weight: 700; color: var(--secondary);
  margin-bottom: 12px; display: flex; align-items: center; gap: 8px;
  padding-bottom: 8px; border-bottom: 1px solid var(--border);
}
.apt-block  { margin-bottom: 14px; margin-left: 10px; }
.apt-title  {
  font-size: .88em; font-weight: 600; color: var(--text-dim);
  margin-bottom: 8px; padding: 4px 10px;
  border-left: 3px solid var(--primary-deep); background: var(--bg-surface);
  border-radius: 0 6px 6px 0;
}
.meters-grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(270px,1fr)); gap: 12px; margin-left: 20px; }

/* Zählerkarte – wie App-Karte */
.meter-card {
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 12px; padding: 14px 16px;
  transition: border-color .2s, background .2s;
}
.meter-card:hover { border-color: var(--border-light); background: var(--bg-surface2); }
.mc-head  { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; }
.mc-name  { font-weight: 600; font-size: .95em; color: var(--text); }
.mc-badge {
  font-size: .7em; font-weight: 700; padding: 2px 8px;
  border-radius: 20px; background: var(--primary-deep);
  color: var(--secondary); letter-spacing: .4px;
}
.mc-value-row { display: flex; align-items: baseline; gap: 4px; }
.mc-value { font-size: 2em; font-weight: 700; color: var(--secondary); line-height: 1; }
.mc-unit  { font-size: .88em; color: var(--text-dim); }
.mc-date  { font-size: .76em; color: var(--text-muted); margin-top: 5px; }
.mc-hist-toggle {
  display: inline-block; margin-top: 10px; font-size: .76em;
  color: var(--primary); cursor: pointer; border: none; background: none;
  padding: 0; transition: color .15s;
}
.mc-hist-toggle:hover { color: var(--secondary); }
.mc-history {
  display: none; margin-top: 8px;
  border-top: 1px solid var(--border); padding-top: 8px;
  max-height: 180px; overflow-y: auto;
}
.mc-history.open { display: block; }
.hist-row {
  display: flex; justify-content: space-between;
  font-size: .76em; padding: 3px 0; color: var(--text-dim);
  border-bottom: 1px solid var(--bg-surface3);
}
.hist-row:last-child { border: none; }
.hist-val { color: var(--text); font-weight: 600; }

.empty-state { text-align: center; padding: 70px 20px; color: var(--text-dim); }
.empty-state .ico { font-size: 3em; margin-bottom: 14px; }
.empty-state p { line-height: 1.7; }

/* ── Import-Tab ──────────────────────────────────────────────────────────── */
.import-card {
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 14px; padding: 26px; max-width: 660px;
}
.import-card h3 { font-size: 1.05em; color: var(--secondary); margin-bottom: 8px; }
.import-card > p { font-size: .86em; color: var(--text-dim); line-height: 1.65; margin-bottom: 18px; }
.schema-box {
  background: var(--bg-deep); border: 1px solid var(--border);
  border-radius: 8px; padding: 12px 14px; font-family: Consolas,monospace;
  font-size: .78em; color: #90CAF9; margin-bottom: 18px;
  white-space: pre; overflow-x: auto;
}
.house-row { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.house-row label { font-size: .86em; color: var(--text-dim); }
input[type=text] {
  background: var(--bg-surface2); border: 1px solid var(--border-light);
  color: var(--text); padding: 7px 12px; border-radius: 8px;
  font-size: .86em; width: 200px; outline: none;
  transition: border-color .2s;
}
input[type=text]:focus { border-color: var(--primary); }
.drop-zone {
  border: 2px dashed var(--border-light); border-radius: 12px;
  padding: 34px; text-align: center; cursor: pointer;
  transition: border-color .2s, background .2s; margin-bottom: 16px;
}
.drop-zone:hover, .drop-zone.drag {
  border-color: var(--primary); background: rgba(123,84,196,.08);
}
.drop-zone .dz-ico { font-size: 2.4em; margin-bottom: 8px; }
.drop-zone p { color: var(--text-dim); font-size: .86em; }
input[type=file] { display: none; }

.preview-box {
  background: var(--bg-deep); border: 1px solid var(--border);
  border-radius: 8px; padding: 14px 16px; margin-bottom: 16px; display: none;
}
.preview-box h4 { font-size: .88em; color: var(--secondary); margin-bottom: 10px; }
.preview-row {
  display: flex; justify-content: space-between;
  font-size: .84em; padding: 4px 0; border-bottom: 1px solid var(--border);
}
.preview-row:last-child { border: none; }
.preview-row span { color: var(--text-dim); }
.preview-row b { color: var(--text); }

.btn-row { display: flex; gap: 10px; align-items: center; }
button.primary {
  background: var(--primary); color: #fff; border: none;
  padding: 9px 22px; border-radius: 9px; cursor: pointer;
  font-size: .88em; font-weight: 600;
  transition: background .2s, opacity .2s;
}
button.primary:hover    { background: var(--primary-dark); }
button.primary:disabled { opacity: .4; cursor: default; }
button.ghost {
  background: transparent; border: 1px solid var(--border-light);
  color: var(--text-dim); padding: 8px 16px; border-radius: 9px;
  cursor: pointer; font-size: .86em; transition: border-color .2s, color .2s;
}
button.ghost:hover { border-color: var(--primary); color: var(--text); }

.result-box {
  border-radius: 8px; padding: 12px 14px; font-size: .85em;
  margin-top: 14px; display: none; line-height: 1.6;
}
.result-box.ok   { background: rgba(76,175,80,.12); border:1px solid rgba(76,175,80,.3);  color: #A5D6A7; }
.result-box.warn { background: rgba(255,152,0,.1);  border:1px solid rgba(255,152,0,.3);  color: #FFCC80; }
.result-box.err  { background: rgba(244,67,54,.1);  border:1px solid rgba(244,67,54,.3);  color: #EF9A9A; }

/* ── Log-Tab ─────────────────────────────────────────────────────────────── */
.log-toolbar {
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 10px; padding: 10px 14px;
  display: flex; gap: 10px; flex-wrap: wrap; align-items: center;
  margin-bottom: 14px;
}
select {
  background: var(--bg-surface2); border: 1px solid var(--border-light);
  color: var(--text); padding: 6px 10px; border-radius: 7px; font-size: .83em; outline: none;
}
input.search {
  background: var(--bg-surface2); border: 1px solid var(--border-light);
  color: var(--text); padding: 6px 10px; border-radius: 7px;
  font-size: .83em; width: 170px; outline: none;
}
.lbl { font-size: .8em; color: var(--text-dim); display: flex; align-items: center; gap: 5px; }
#lc { font-family: 'Cascadia Code','Fira Code',Consolas,monospace; font-size: .8em; }
.le {
  display: grid; grid-template-columns: 88px 50px 88px 1fr;
  gap: 0 10px; padding: 4px 2px;
  border-bottom: 1px solid var(--bg-surface3); align-items: start;
}
.le:hover { background: rgba(123,84,196,.07); }
.le.new { animation: fadeIn .4s; }
@keyframes fadeIn { from { background: rgba(123,84,196,.22); } to { background: transparent; } }
.ts  { color: var(--text-muted); font-size: .88em; white-space: nowrap; }
.bdg { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: .7em; font-weight: 700; }
/* Level-Farben */
.ld { color: var(--log-debug); }
.li { color: var(--log-info);  }
.lw { color: var(--log-warn);  }
.le2{ color: var(--log-error); font-weight: 700; }
/* Kategorie-Badges – subtile Hintergrundtönung */
.cSYSTEM    { color: var(--text-dim);  background: rgba(94,77,138,.25);  }
.cAUTH      { color: #CE93D8;          background: rgba(156,39,176,.2);  }
.cCONNECT   { color: #81D4FA;          background: rgba(33,150,243,.2);  }
.cDATAPOINT { color: #A5D6A7;          background: rgba(76,175,80,.2);   }
.cSYNC      { color: #FFCC80;          background: rgba(255,152,0,.2);   }
.cHISTORY   { color: #CE93D8;          background: rgba(123,84,196,.2);  }
.cIMPORT    { color: var(--secondary); background: rgba(123,84,196,.25); }
.msg { color: var(--text); }
.det { color: var(--text-dim); font-size: .9em; }
.log-empty { text-align: center; padding: 50px; color: var(--text-dim); }

/* ── System-Tab ──────────────────────────────────────────────────────────────── */
.sys-card {
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 14px; padding: 24px 28px; max-width: 560px; margin-bottom: 18px;
}
.sys-card h3 { font-size: 1em; color: var(--secondary); margin-bottom: 16px; }
.ver-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 9px 0; border-bottom: 1px solid var(--border);
  font-size: .88em;
}
.ver-row:last-of-type { border: none; }
.ver-label { color: var(--text-dim); }
.ver-val   { color: var(--text); font-weight: 600; font-family: Consolas,monospace; }
.badge-ok   { background:rgba(76,175,80,.15);  color:#A5D6A7; border:1px solid rgba(76,175,80,.3);  padding:2px 10px; border-radius:20px; font-size:.8em; }
.badge-new  { background:rgba(33,150,243,.15); color:#90CAF9; border:1px solid rgba(33,150,243,.3); padding:2px 10px; border-radius:20px; font-size:.8em; }
.badge-warn { background:rgba(255,152,0,.12);  color:#FFCC80; border:1px solid rgba(255,152,0,.3);  padding:2px 10px; border-radius:20px; font-size:.8em; }
.badge-err  { background:rgba(244,67,54,.12);  color:#EF9A9A; border:1px solid rgba(244,67,54,.3);  padding:2px 10px; border-radius:20px; font-size:.8em; }
.sys-btn-row { display:flex; gap:10px; margin-top:18px; flex-wrap:wrap; align-items:center; }
.sys-out {
  margin-top:14px; background:var(--bg-deep); border:1px solid var(--border);
  border-radius:8px; padding:12px 14px; font-family:Consolas,monospace;
  font-size:.78em; color:var(--text-dim); max-height:180px; overflow-y:auto;
  white-space:pre-wrap; display:none;
}
.cmd-row {
  display:flex; align-items:center; gap:8px;
  background:var(--bg-deep); border:1px solid var(--border);
  border-radius:8px; padding:8px 10px;
}
.cmd-code {
  flex:1; font-family:Consolas,monospace; font-size:.8em;
  color:var(--secondary); background:none; border:none; outline:none;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.cmd-copy {
  flex-shrink:0; background:var(--bg-card); border:1px solid var(--border);
  border-radius:6px; padding:4px 8px; cursor:pointer; font-size:.88em;
  color:var(--text-dim); transition:all .15s;
}
.cmd-copy:hover  { background:var(--primary); color:#fff; border-color:var(--primary); }
.cmd-copy.copied { background:var(--accent);  color:#fff; border-color:var(--accent); }

#ni {
  position: fixed; bottom: 22px; right: 22px;
  background: var(--primary); color: #fff;
  padding: 8px 18px; border-radius: 20px;
  font-size: .83em; cursor: pointer; display: none;
  box-shadow: 0 4px 20px rgba(123,84,196,.45);
  transition: background .2s;
}
#ni:hover { background: var(--primary-dark); }
</style>
</head>
<body>

<!-- ══ HEADER ════════════════════════════════════════════════════════════════ -->
<header>
  <div class="logo-icon">${LOGO_SVG}</div>
  <div class="logo-text">
    <span class="logo-title">MeterMaster</span>
    <span class="logo-sub">ioBroker Adapter &nbsp;<span style="color:var(--primary);font-size:.95em;letter-spacing:.5px">v${CURRENT_VERSION}</span></span>
  </div>
  <div class="hstats">
    <div class="hstat">Ablesungen: <b id="st-rx">–</b></div>
    <div class="hstat">Nodes: <b id="st-nodes">–</b></div>
    <div class="hstat">Uptime: <b id="st-up">–</b></div>
    <div class="live-dot" id="st-live">● Live</div>
  </div>
</header>

<!-- ══ NAV ═══════════════════════════════════════════════════════════════════ -->
<nav>
  <button class="tab active" id="tab-data"   data-tab="data"   onclick="showTab('data')"  >📊 Daten</button>
  <button class="tab"        id="tab-nodes"  data-tab="nodes"  onclick="showTab('nodes')" >📡 Nodes</button>
  <button class="tab"        id="tab-import" data-tab="import" onclick="showTab('import')">📥 Import</button>
  <button class="tab"        id="tab-logs"   data-tab="logs"   onclick="showTab('logs')"  >📋 Logs</button>
  <button class="tab"        id="tab-system" data-tab="system" onclick="showTab('system')">⚙️ System</button>
</nav>

<!-- ══ DATEN ══════════════════════════════════════════════════════════════════ -->
<div class="page active" id="page-data">
  <div id="data-container">
    <div class="empty-state">
      <div class="ico">📡</div>
      <p>Noch keine Ablesungen empfangen.<br>Starte einen Sync in der MeterMaster App oder lade ein Backup hoch.</p>
    </div>
  </div>
</div>

<!-- ══ NODES ═════════════════════════════════════════════════════════════════ -->
<div class="page" id="page-nodes">
  <div id="nodes-page-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
    <div>
      <h2 style="font-size:1em;color:var(--secondary);margin-bottom:2px;">📡 Registrierte ESP32 Nodes</h2>
      <div style="font-size:.82em;color:var(--text-dim);">Gesamt: <b id="nd-total" style="color:var(--text);">0</b> &nbsp;|&nbsp; Online: <b id="nd-online" style="color:var(--accent);">0</b></div>
    </div>
    <button class="ghost" onclick="fetchNodes()">↻ Aktualisieren</button>
  </div>
  <div id="nodes-container">
    <div class="empty-state">
      <div class="ico">📡</div>
      <p>Noch keine ESP32 Nodes registriert.<br>Wenn ein MeterMaster Node startet und seinen Heartbeat sendet, erscheint er hier automatisch.</p>
    </div>
  </div>
</div>

<!-- ══ IMPORT ════════════════════════════════════════════════════════════════ -->
<div class="page" id="page-import">
  <div class="import-card">
    <h3>📥 App-Backup importieren</h3>
    <p>Importiere einen Backup-Export aus der MeterMaster App direkt in den Adapter. Alle Ablesungen werden mit ihren originalen Zeitstempeln gespeichert — ideal für die erstmalige Befüllung oder das Nachführen historischer Daten.</p>

    <div class="schema-box">{ "SchemaVersion": "2.0", "Source": "MeterMaster",
  "Apartments": [ { "Id": 1, "Name": "Westerheim" } ],
  "Meters":     [ { "Id": 1, "Name": "Warmwasser", "ApartmentId": 1, "Unit": "m³" } ],
  "Readings":   [ { "MeterId": 1, "Value": 128.75, "ReadingDate": "2024-02-12T09:30:00" } ]
}</div>

    <div class="house-row">
      <label>Hausname (ioBroker-Pfad):</label>
      <input type="text" id="imp-house" value="MeinHaus" placeholder="z.B. MeinHaus">
    </div>

    <div class="drop-zone" id="drop-zone" onclick="document.getElementById('file-in').click()">
      <div class="dz-ico">📂</div>
      <p>JSON-Datei hier ablegen oder klicken zum Auswählen</p>
    </div>
    <input type="file" id="file-in" accept=".json">

    <div class="preview-box" id="preview-box">
      <h4>📋 Vorschau</h4>
      <div id="preview-content"></div>
    </div>

    <div class="btn-row">
      <button class="primary" id="imp-btn" disabled onclick="doImport()">⬆ Importieren</button>
      <button class="ghost" onclick="clearImport()">✕ Zurücksetzen</button>
    </div>
    <div class="result-box" id="imp-result"></div>
  </div>
</div>

<!-- ══ LOGS ═══════════════════════════════════════════════════════════════════ -->
<div class="page" id="page-logs">
  <div class="log-toolbar">
    <select id="fl">
      <option value="">Alle Level</option>
      <option value="debug">DEBUG</option>
      <option value="info">INFO</option>
      <option value="warn">WARN</option>
      <option value="error">ERROR</option>
    </select>
    <select id="fc">
      <option value="">Alle Kategorien</option>
      <option value="SYSTEM">SYSTEM</option>
      <option value="AUTH">AUTH</option>
      <option value="CONNECT">CONNECT</option>
      <option value="DATAPOINT">DATAPOINT</option>
      <option value="SYNC">SYNC</option>
      <option value="HISTORY">HISTORY</option>
      <option value="IMPORT">IMPORT</option>
      <option value="NODE">NODE</option>
    </select>
    <input class="search" type="text" id="ft" placeholder="Suche…">
    <button class="ghost" onclick="clearLogs()">🗑 Leeren</button>
    <button class="ghost" onclick="exportLogs()">⬇ Export</button>
    <label class="lbl"><input type="checkbox" id="as" checked> Auto-Scroll</label>
    <label class="lbl"><input type="checkbox" id="ar" checked> Live</label>
  </div>
  <div id="lc"><div class="log-empty" id="log-empty">Keine Log-Einträge vorhanden.</div></div>
</div>


<!-- ══ SYSTEM ════════════════════════════════════════════════════════════════ -->
<div class="page" id="page-system">

  <div class="sys-card">
    <h3>📊 Statistiken</h3>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div style="background:var(--bg-deep);border:1px solid var(--border);border-radius:9px;padding:12px 14px;">
        <div style="font-size:1.6em;font-weight:700;color:var(--secondary);" id="sys-rx">–</div>
        <div style="font-size:.78em;color:var(--text-dim);margin-top:3px;">Ablesungen gesamt</div>
      </div>
      <div style="background:var(--bg-deep);border:1px solid var(--border);border-radius:9px;padding:12px 14px;">
        <div style="font-size:1.6em;font-weight:700;color:var(--secondary);" id="sys-up">–</div>
        <div style="font-size:.78em;color:var(--text-dim);margin-top:3px;">Uptime</div>
      </div>
      <div style="background:var(--bg-deep);border:1px solid var(--border);border-radius:9px;padding:12px 14px;">
        <div style="font-size:1.6em;font-weight:700;color:var(--accent);" id="sys-online">–</div>
        <div style="font-size:.78em;color:var(--text-dim);margin-top:3px;">Nodes online</div>
      </div>
      <div style="background:var(--bg-deep);border:1px solid var(--border);border-radius:9px;padding:12px 14px;">
        <div style="font-size:1.6em;font-weight:700;color:var(--secondary);" id="sys-total">–</div>
        <div style="font-size:.78em;color:var(--text-dim);margin-top:3px;">Nodes gesamt</div>
      </div>
    </div>
  </div>

  <div class="sys-card">
    <h3>🔄 Adapter-Version</h3>
    <div class="ver-row"><span class="ver-label">Installiert</span>  <span class="ver-val" id="sv-cur">–</span></div>
    <div class="ver-row"><span class="ver-label">Aktuell (GitHub)</span><span class="ver-val" id="sv-lat">–</span></div>
    <div class="ver-row"><span class="ver-label">Status</span>        <span id="sv-status"><span class="badge-warn">Noch nicht geprüft</span></span></div>
    <div class="sys-btn-row">
      <button class="ghost" id="sv-check-btn">🔍 Auf Updates prüfen</button>
      <button class="primary" id="sv-upd-btn" style="display:none">⬆ Update installieren</button>
      <span id="sv-spin" style="display:none;font-size:.84em;color:var(--text-dim)">⏳ Bitte warten…</span>
    </div>
    <div class="sys-out" id="sv-out"></div>
  </div>

  <div class="sys-card">
    <h3>ℹ️ Adapter-Info</h3>
    <div class="ver-row"><span class="ver-label">Adapter</span>      <span class="ver-val">iobroker.metermaster</span></div>
    <div class="ver-row"><span class="ver-label">Port</span>         <span class="ver-val">${port}</span></div>
    <div class="ver-row"><span class="ver-label">Repository</span>
      <a href="https://github.com/MPunktBPunkt/iobroker.metermaster" target="_blank"
         style="color:var(--primary);font-size:.84em">GitHub ↗</a>
    </div>
  </div>

  <div class="sys-card">
    <h3>🔄 Update-Befehle</h3>
    <p style="font-size:.82em;color:var(--text-dim);margin:0 0 12px">
      Adapter aktualisieren — Befehle in der ioBroker-Konsole ausführen:
    </p>
    <div class="cmd-row">
      <code class="cmd-code">iobroker url https://github.com/MPunktBPunkt/iobroker.metermaster</code>
      <button class="cmd-copy" onclick="copyCmd(this)" data-cmd="iobroker url https://github.com/MPunktBPunkt/iobroker.metermaster" title="Kopieren">📋</button>
    </div>
    <div class="cmd-row" style="margin-top:8px">
      <code class="cmd-code">iobroker restart metermaster.0</code>
      <button class="cmd-copy" onclick="copyCmd(this)" data-cmd="iobroker restart metermaster.0" title="Kopieren">📋</button>
    </div>
    <div class="cmd-row" style="margin-top:8px">
      <code class="cmd-code">sleep 5 &amp;&amp; iobroker status metermaster.0</code>
      <button class="cmd-copy" onclick="copyCmd(this)" data-cmd="sleep 5 && iobroker status metermaster.0" title="Kopieren">📋</button>
    </div>
    <p style="font-size:.78em;color:var(--text-dim);margin:10px 0 0">
      💡 Tipp: Alle drei Befehle nacheinander ausführen — warten bis jeder abgeschlossen ist.
    </p>
  </div>

</div>

<div id="ni" onclick="scrollLogBottom()">↓ Neue Einträge</div>

<script>
const TYPE_ICONS = ${JSON.stringify(TYPE_ICONS)};

// \u2500\u2500 Tab-Navigation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
window.showTab = function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-'+name).classList.add('active');
  document.getElementById('page-'+name).classList.add('active');
  if (name === 'data')   fetchData();
  if (name === 'nodes')  fetchNodes();
  if (name === 'logs')   fetchLogs();
  if (name === 'system') { checkVersion(); fetchSysStats(); }
}

const esc    = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fmtDt  = ts => new Date(ts).toLocaleString('de-DE',{hour12:false});
const fmtUp  = s  => Math.floor(s/3600)+'h '+Math.floor(s%3600/60)+'m '+Math.floor(s%60)+'s';
const fmtLog = ts => {
  const d = new Date(ts);
  return d.toLocaleTimeString('de-DE',{hour12:false})+'.'+String(d.getMilliseconds()).padStart(3,'0');
};
const fmtAgo = ts => {
  if (!ts) return '\u2013';
  const s = Math.floor((Date.now()-ts)/1000);
  if (s < 5)    return 'gerade eben';
  if (s < 60)   return 'vor '+s+'s';
  if (s < 3600) return 'vor '+Math.floor(s/60)+'min';
  return new Date(ts).toLocaleString('de-DE',{hour12:false});
};

// \u2500\u2500 Stats \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function fetchStats() {
  try {
    const d = await fetch('/api/stats').then(r => r.json());
    document.getElementById('st-rx').textContent    = d.readingsReceived;
    document.getElementById('st-nodes').textContent = d.onlineCount+'/'+d.nodeCount;
    document.getElementById('st-up').textContent    = fmtUp(d.uptime);
    document.getElementById('st-live').textContent  = '\u25CF Live';
    document.getElementById('st-live').style.color  = 'var(--accent)';
  } catch {
    document.getElementById('st-live').textContent = '\u2717 Getrennt';
    document.getElementById('st-live').style.color = 'var(--danger)';
  }
}

async function fetchSysStats() {
  try {
    const d = await fetch('/api/stats').then(r => r.json());
    const sRx = document.getElementById('sys-rx');     if (sRx) sRx.textContent     = d.readingsReceived;
    const sUp = document.getElementById('sys-up');     if (sUp) sUp.textContent     = fmtUp(d.uptime);
    const sOn = document.getElementById('sys-online'); if (sOn) sOn.textContent = d.onlineCount;
    const sTt = document.getElementById('sys-total');  if (sTt) sTt.textContent  = d.nodeCount;
  } catch {}
}

// \u2500\u2500 DATEN-TAB \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function fetchData() {
  try {
    const d   = await fetch('/api/data').then(r => r.json());
    const con = document.getElementById('data-container');
    if (!d.data || !Object.keys(d.data).length) {
      con.innerHTML = '<div class="empty-state"><div class="ico">\uD83D\uDCE1</div><p>Noch keine Ablesungen empfangen.<br>Starte einen Sync in der MeterMaster App.</p></div>';
      return;
    }
    let html = '';
    for (const [house, apts] of Object.entries(d.data)) {
      html += '<div class="house-block"><div class="house-title">\uD83C\uDFE0 '+esc(house)+'</div>';
      for (const [apt, meters] of Object.entries(apts)) {
        html += '<div class="apt-block"><div class="apt-title">\uD83C\uDFD8 '+esc(apt)+'</div><div class="meters-grid">';
        for (const [key, m] of Object.entries(meters)) {
          const icon   = TYPE_ICONS[m.typeName] || '\uD83D\uDCDF';
          const histId = 'h-'+CSS.escape(house+apt+key);
          const rows   = (m.history||[]).slice().reverse().map(h =>
            '<div class="hist-row"><span>'+esc(fmtDt(h.ts))+'</span><span class="hist-val">'+h.value+' '+esc(m.unit||'')+'</span></div>'
          ).join('');
          html +=
            '<div class="meter-card">'+
              '<div class="mc-head">'+
                '<div class="mc-name">'+icon+' '+esc(key)+'</div>'+
                '<div class="mc-badge">'+esc(m.typeName||'?')+'</div>'+
              '</div>'+
              '<div class="mc-value-row">'+
                '<span class="mc-value">'+(m.latest !== undefined ? m.latest : '\u2013')+'</span>'+
                '<span class="mc-unit">'+esc(m.unit||'')+'</span>'+
              '</div>'+
              '<div class="mc-date">\uD83D\uDCC5 '+esc(m.latestDate ? fmtDt(new Date(m.latestDate).getTime()) : '\u2013')+'</div>'+
              (rows
                ? '<button class="mc-hist-toggle" data-hist="'+histId+'">\uD83D\uDCC8 Verlauf ('+(m.history||[]).length+')</button>'+
                  '<div class="mc-history" id="'+histId+'">'+rows+'</div>'
                : '')+
            '</div>';
        }
        html += '</div></div>';
      }
      html += '</div>';
    }
    con.innerHTML = html;
  } catch(e) {
    document.getElementById('data-container').innerHTML =
      '<div class="empty-state"><div class="ico">\u26A0</div><p>Fehler: '+esc(e.message)+'</p></div>';
  }
}

function toggleHist(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('open');
}
// \u2500\u2500 NODES-TAB \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
let discoverCache = [];

async function fetchNodes() {
  const con = document.getElementById('nodes-container');
  try {
    const [nodes, discover] = await Promise.all([
      fetch('/api/nodes').then(r => r.json()),
      fetch('/api/discover').then(r => r.json())
    ]);
    discoverCache = discover;
    const total  = nodes.length;
    const online = nodes.filter(n => n.online).length;
    const elTot = document.getElementById('nd-total');  if (elTot) elTot.textContent  = total;
    const elOn  = document.getElementById('nd-online'); if (elOn)  elOn.textContent   = online;
    if (!total) {
      con.innerHTML = '<div class="empty-state"><div class="ico">\uD83D\uDCE1</div><p>Noch keine ESP32 Nodes registriert.<br>Wenn ein MeterMaster Node startet, erscheint er automatisch hier.</p></div>';
      return;
    }
    const buildOptions = (currentSid) => {
      let opts = '<option value="">\u2014 Kein Z\u00E4hler zugewiesen \u2014</option>';
      for (const m of discover) {
        const lbl = m.house + ' \u203A ' + m.apartment + ' \u203A ' + m.meter + (m.latest !== undefined ? '  (' + m.latest + ' ' + esc(m.unit) + ')' : '');
        opts += '<option value="'+esc(m.stateId)+'"'+(m.stateId===currentSid?' selected':'')+'>'+esc(lbl)+'</option>';
      }
      return opts;
    };
    let html = '<div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;">';
    html += '<table style="width:100%;border-collapse:collapse;font-size:.85em;">';
    html += '<thead><tr style="text-align:left;">';
    const th = (t) => '<th style="padding:10px 12px;color:var(--text-dim);font-size:.8em;text-transform:uppercase;letter-spacing:.6px;border-bottom:2px solid var(--border);background:var(--bg-surface);">'+t+'</th>';
    html += th('Status')+th('Name')+th('IP-Adresse')+th('FW-Version')+th('Zuletzt gesehen')+th('Z\u00E4hler zuweisen');
    html += '</tr></thead><tbody>';
    for (const n of nodes) {
      let currentSid = '';
      try { currentSid = JSON.parse(n.config||'{}').sid || ''; } catch {}
      const onBadge  = '<span style="display:inline-flex;align-items:center;gap:5px;font-size:.8em;font-weight:700;padding:2px 9px;border-radius:20px;background:rgba(76,175,80,.15);color:#A5D6A7;border:1px solid rgba(76,175,80,.3);"><span style="width:7px;height:7px;border-radius:50%;background:var(--accent);display:inline-block;box-shadow:0 0 4px var(--accent);"></span>Online</span>';
      const offBadge = '<span style="display:inline-flex;align-items:center;gap:5px;font-size:.8em;font-weight:700;padding:2px 9px;border-radius:20px;background:rgba(244,67,54,.12);color:#EF9A9A;border:1px solid rgba(244,67,54,.3);"><span style="width:7px;height:7px;border-radius:50%;background:var(--danger);display:inline-block;"></span>Offline</span>';
      const badge    = n.online ? onBadge : offBadge;
      const ackHint  = n.configAck ? '<div style="font-size:.75em;color:var(--text-muted);margin-top:3px;">\u2713 Ack</div>' : '';
      const ipCell   = n.ip ? '<a href="http://'+esc(n.ip)+'" target="_blank" style="color:var(--primary);text-decoration:none;font-family:Consolas,monospace;font-size:.9em;">'+esc(n.ip)+'</a>' : '\u2013';
      const td = (c, extra) => '<td style="padding:10px 12px;vertical-align:middle;'+(extra||'')+'">'+c+'</td>';
      html += '<tr style="border-bottom:1px solid var(--border);">';
      html += td(badge+'<br><span style="font-family:Consolas,monospace;font-size:.78em;color:var(--text-muted);">'+esc(n.mac)+'</span>');
      html += td('<b>'+esc(n.name||'\u2013')+'</b>');
      html += td(ipCell);
      html += td('<span style="background:var(--bg-surface3);color:var(--secondary);font-family:Consolas,monospace;font-size:.82em;padding:2px 8px;border-radius:6px;">'+esc(n.version||'\u2013')+'</span>');
      html += td(esc(fmtAgo(n.lastSeen)), 'color:var(--text-dim);font-size:.82em;');
      html += td('<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><select id="sel-'+esc(n.mac)+'" style="background:var(--bg-surface2);border:1px solid var(--border-light);color:var(--text);padding:6px 10px;border-radius:7px;font-size:.82em;max-width:300px;min-width:180px;outline:none;">'+buildOptions(currentSid)+'</select><button onclick="saveNodeConfig(\''+esc(n.mac)+'\')" id="sbtn-'+esc(n.mac)+'" style="background:var(--primary);color:#fff;border:none;padding:6px 14px;border-radius:7px;cursor:pointer;font-size:.82em;font-weight:600;white-space:nowrap;">\uD83D\uDCBE Speichern</button><span id="smsg-'+esc(n.mac)+'"></span></div>'+ackHint);
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    con.innerHTML = html;
  } catch(e) {
    con.innerHTML = '<div class="empty-state"><div class="ico">\u26A0</div><p>Fehler: '+esc(e.message)+'</p></div>';
  }
}

async function saveNodeConfig(mac) {
  const sel = document.getElementById('sel-'+mac);
  const btn = document.getElementById('sbtn-'+mac);
  const msg = document.getElementById('smsg-'+mac);
  if (!sel || !btn || !msg) return;
  const stateId = sel.value;
  const meter   = discoverCache.find(m => m.stateId === stateId);
  btn.disabled = true; msg.textContent = '';
  try {
    const r = await fetch('/api/nodes/'+encodeURIComponent(mac)+'/config', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ sid: stateId, label: meter ? meter.label : '', unit: meter ? meter.unit : '' })
    });
    const d = await r.json();
    if (d.ok) {
      msg.innerHTML = '<span style="color:var(--accent);font-size:.82em;">\u2713 Gespeichert</span>';
      setTimeout(() => { msg.textContent = ''; }, 3000);
    } else {
      msg.innerHTML = '<span style="color:var(--danger);font-size:.82em;">\u2717 '+esc(d.error||'Fehler')+'</span>';
    }
  } catch(e) {
    msg.innerHTML = '<span style="color:var(--danger);font-size:.82em;">\u2717 '+esc(e.message)+'</span>';
  } finally {
    btn.disabled = false;
  }
}


// \u2500\u2500 IMPORT-TAB \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
let importData = null;
let dz = null; // wird in initDropzone() gesetzt

function loadFile(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = e => {
    try { importData = JSON.parse(e.target.result); showPreview(importData, file.name); }
    catch { showResult('err', '\u274C Ung\u00FCltige JSON-Datei'); }
  };
  r.readAsText(file);
}

function showPreview(d, fname) {
  const valid = !!(d.Apartments && d.Meters && d.Readings);
  document.getElementById('preview-content').innerHTML =
    prow('Datei',      esc(fname)) +
    prow('Schema',     d.SchemaVersion||'?') +
    prow('Wohnungen',  (d.Apartments||[]).length) +
    prow('Z\u00E4hler',     (d.Meters||[]).length) +
    prow('Ablesungen', (d.Readings||[]).length) +
    prow('Kompatibel', valid ? '\u2705 Ja' : '\u274C Nein \u2013 Pflichtfelder fehlen');
  document.getElementById('preview-box').style.display = 'block';
  document.getElementById('imp-btn').disabled = !valid;
}
const prow = (l,v) => '<div class="preview-row"><span>'+l+'</span><b>'+v+'</b></div>';

async function doImport() {
  if (!importData) return;
  const house = document.getElementById('imp-house').value.trim() || 'MeinHaus';
  const btn   = document.getElementById('imp-btn');
  btn.disabled = true; btn.textContent = '\u23F3 Importiere\u2026';
  try {
    const r = await fetch('/api/import', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({...importData, HouseName: house})
    });
    const d = await r.json();
    if (d.ok) { showResult('ok',   '\u2705 '+d.summary); fetchData(); fetchStats(); }
    else       { showResult('warn','\u26A0 '+d.summary+(d.errors.length ? '<br>'+d.errors.slice(0,5).map(esc).join('<br>') : '')); }
  } catch(e) { showResult('err', '\u274C Netzwerkfehler: '+esc(e.message)); }
  finally { btn.disabled = false; btn.textContent = '\u2B06 Importieren'; }
}
function showResult(type, msg) {
  const rb = document.getElementById('imp-result');
  rb.className = 'result-box '+type; rb.innerHTML = msg; rb.style.display = 'block';
}
function clearImport() {
  importData = null;
  document.getElementById('file-in').value = '';
  document.getElementById('preview-box').style.display  = 'none';
  document.getElementById('imp-result').style.display   = 'none';
  document.getElementById('imp-btn').disabled = true;
}

// \u2500\u2500 LOG-TAB \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
let newestTs = 0, displayed = [], logTimer;
const lc  = () => document.getElementById('lc');
const gf  = () => ({
  level: document.getElementById('fl').value,
  cat:   document.getElementById('fc').value,
  txt:   document.getElementById('ft').value.toLowerCase()
});
const matchLog = (e,f) => {
  if (f.level && e.level    !== f.level) return false;
  if (f.cat   && e.category !== f.cat)   return false;
  if (f.txt && !(e.message+' '+(e.detail||'')).toLowerCase().includes(f.txt)) return false;
  return true;
};
const lvlCls = l => ({debug:'ld',info:'li',warn:'lw',error:'le2'}[l]||'li');

function renderLog(e, isNew) {
  const f = gf(); if (!matchLog(e,f)) return null;
  const d = document.createElement('div');
  d.className  = 'le'+(isNew?' new':''); d.dataset.ts = e.ts;
  d.innerHTML  =
    '<span class="ts">'+fmtLog(e.ts)+'</span>'+
    '<span class="bdg '+lvlCls(e.level)+'">'+e.level.toUpperCase()+'</span>'+
    '<span class="bdg c'+e.category+'">'+e.category+'</span>'+
    '<span class="msg">'+esc(e.message)+(e.detail?'<br><span class="det">'+esc(e.detail)+'</span>':'')+'</span>';
  return d;
}

async function fetchLogs() {
  try {
    const f   = gf();
    const url = '/api/logs?since='+newestTs+'&limit=100'+(f.level?'&level='+f.level:'')+(f.cat?'&category='+f.cat:'');
    const d   = await fetch(url).then(r => r.json());
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
  lc().querySelectorAll('.le').forEach(e => e.remove());
  document.getElementById('log-empty').style.display = '';
  newestTs = Date.now(); displayed = [];
}
function applyLogFilter() {
  const f = gf();
  lc().querySelectorAll('.le').forEach(el => {
    const e = displayed.find(d => d.ts == el.dataset.ts);
    if (e) el.style.display = matchLog(e,f) ? '' : 'none';
  });
}
function exportLogs() {
  const f = gf();
  const txt = displayed.filter(e=>matchLog(e,f))
    .map(e=>'['+new Date(e.ts).toISOString()+'] ['+e.level.toUpperCase()+'] ['+e.category+'] '+e.message+(e.detail?' \u2014 '+e.detail:'')).join('\\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([txt],{type:'text/plain'}));
  a.download = 'metermaster-log-'+new Date().toISOString().slice(0,19)+'.txt';
  a.click();
}
// Log-Filter EventListener \u2192 werden in initLogFilters() gesetzt

function startLive() {
  clearInterval(logTimer);
  logTimer = setInterval(async () => { await fetchLogs(); await fetchStats(); }, 3000);
}


// \u2500\u2500 SYSTEM-TAB \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function checkVersion() {
  const btn   = document.getElementById('sv-check-btn');
  const spin  = document.getElementById('sv-spin');
  const updBtn = document.getElementById('sv-upd-btn');
  btn.disabled = true; spin.style.display = 'inline';
  try {
    const d = await fetch('/api/version').then(r => r.json());
    document.getElementById('sv-cur').textContent = d.current || '\u2013';
    document.getElementById('sv-lat').textContent = d.latest  || (d.error ? '(Fehler)' : 'Noch kein Release');
    const st = document.getElementById('sv-status');
    if (d.error) {
      st.innerHTML = '<span class="badge-err">\u26A0 GitHub nicht erreichbar</span>';
      updBtn.style.display = 'none';
    } else if (!d.latest) {
      st.innerHTML = '<span class="badge-warn">\u2139 Kein GitHub-Release vorhanden</span>';
      updBtn.style.display = 'none';
    } else if (d.updateAvailable) {
      st.innerHTML = '<span class="badge-new">\uD83C\uDD95 Update verf\u00FCgbar</span>';
      updBtn.style.display = '';
    } else {
      st.innerHTML = '<span class="badge-ok">\u2713 Aktuell</span>';
      updBtn.style.display = 'none';
    }
  } catch(e) {
    document.getElementById('sv-status').innerHTML = '<span class="badge-err">\u26A0 Netzwerkfehler</span>';
  }
  btn.disabled = false; spin.style.display = 'none';
}

async function doUpdate() {
  const btn    = document.getElementById('sv-upd-btn');
  const spin   = document.getElementById('sv-spin');
  const outBox = document.getElementById('sv-out');
  if (!confirm('Update installieren und Adapter neu starten?')) return;
  btn.style.display = 'none'; spin.style.display = 'inline';
  outBox.style.display = 'block'; outBox.textContent = '\u23F3 Update l\u00E4uft\u2026';
  try {
    const r = await fetch('/api/update', { method: 'POST' });
    const d = await r.json();
    if (d.ok) {
      outBox.textContent = '\u2705 Update erfolgreich.' + String.fromCharCode(10) + 'Adapter wird neu gestartet\u2026' + String.fromCharCode(10,10) + (d.output||'');
      document.getElementById('sv-status').innerHTML = '<span class="badge-ok">\u2713 Neu gestartet</span>';
      setTimeout(() => { outBox.textContent += String.fromCharCode(10) + '\u27F3 Seite wird neu geladen\u2026'; location.reload(); }, 8000);
    } else {
      outBox.textContent = '\u274C Fehler:' + String.fromCharCode(10) + (d.error||'') + String.fromCharCode(10,10) + (d.output||'');
      btn.style.display = ''; spin.style.display = 'none';
    }
  } catch(e) {
    outBox.textContent = '\u274C Netzwerkfehler: ' + e.message;
    btn.style.display = ''; spin.style.display = 'none';
  }
}

// \u2500\u2500 Init \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// ── Copy-to-Clipboard ─────────────────────────────────────────────────────────
function copyCmd(btn) {
  const cmd = btn.dataset.cmd;
  if (!cmd) return;
  navigator.clipboard.writeText(cmd).then(() => {
    btn.textContent = '✓';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = '📋'; btn.classList.remove('copied'); }, 1800);
  }).catch(() => {
    // Fallback für ältere Browser / HTTP-Kontext
    const ta = document.createElement('textarea');
    ta.value = cmd; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    btn.textContent = '✓'; btn.classList.add('copied');
    setTimeout(() => { btn.textContent = '📋'; btn.classList.remove('copied'); }, 1800);
  });
}

function initTabs() {
  // Tab-Buttons
  ['data','nodes','import','logs','system'].forEach(name => {
    const el = document.getElementById('tab-' + name);
    if (el) {
      el.addEventListener('click', () => showTab(name));
      el.style.cursor = 'pointer';
      el.style.pointerEvents = 'all';
    }
  });
  // Event Delegation auf nav als Fallback
  const nav = document.querySelector('nav');
  if (nav) {
    nav.addEventListener('click', e => {
      const tab = e.target.closest('[data-tab]');
      if (tab) { e.stopPropagation(); showTab(tab.dataset.tab); }
    });
  }
  // System-Tab Buttons
  const chkBtn = document.getElementById('sv-check-btn');
  if (chkBtn) chkBtn.addEventListener('click', checkVersion);
  const updBtn = document.getElementById('sv-upd-btn');
  if (updBtn) updBtn.addEventListener('click', doUpdate);

  // Verlauf-Toggle via Event Delegation (kein onclick-Attribut nötig)
  document.addEventListener('click', e => {
    const btn = e.target.closest('.mc-hist-toggle');
    if (btn && btn.dataset.hist) toggleHist(btn.dataset.hist);
  });

  // Dropzone
  dz = document.getElementById('drop-zone');
  if (dz) {
    dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag'); });
    dz.addEventListener('dragleave', ()=> dz.classList.remove('drag'));
    dz.addEventListener('drop',      e => { e.preventDefault(); dz.classList.remove('drag'); loadFile(e.dataTransfer.files[0]); });
  }
  const fi = document.getElementById('file-in');
  if (fi) fi.addEventListener('change', e => loadFile(e.target.files[0]));

  // Log-Filter
  ['fl','fc'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', applyLogFilter);
  });
  const ft = document.getElementById('ft');
  if (ft) ft.addEventListener('input', applyLogFilter);
  const ar = document.getElementById('ar');
  if (ar) ar.addEventListener('change', e => { if(e.target.checked) startLive(); else clearInterval(logTimer); });
}

async function init() {
  initTabs();
  try {
    const d = await fetch('/api/logs?limit=500').then(r => r.json());
    if (d.entries.length > 0) {
      document.getElementById('log-empty').style.display = 'none';
      d.entries.forEach(e => { const el = renderLog(e,false); if(el) lc().appendChild(el); });
      displayed = d.entries; newestTs = d.newest;
    }
  } catch {}
  await fetchData();
  await fetchStats();
  startLive();
}
init();
</script>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
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

// adapter-core v3.x startet automatisch bei new utils.Adapter() — kein .start() nötig
if (require.main === module) { }
module.exports = adapter;

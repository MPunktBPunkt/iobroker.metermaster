'use strict';

const utils  = require('@iobroker/adapter-core');
const http   = require('node:http');
const crypto = require('node:crypto');
const https  = require('node:https');
const CURRENT_VERSION = '0.9.6';
const GITHUB_REPO     = 'MPunktBPunkt/ioBroker.metermaster';
const GITHUB_URL      = 'https://github.com/MPunktBPunkt/ioBroker.metermaster';

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
    entry.unit       = unit;
    entry.typeName   = typeName;

    const histIdx = entry.history.findIndex(h => h.ts === ts);
    if (histIdx >= 0) {
        entry.history[histIdx] = { value, readingDate, ts };
    } else {
        entry.history.push({ value, readingDate, ts });
        entry.history.sort((a, b) => a.ts - b.ts);
    }

    // latest = chronologisch neuester Eintrag (Korrektur alter Werte ändert latest nicht)
    const newest = entry.history[entry.history.length - 1];
    entry.latest     = newest.value;
    entry.latestDate = newest.readingDate;
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

// ─── Config validation ─────────────────────────────────────────────────────────
function clampInt(val, min, max, fallback) {
    const n = parseInt(val, 10);
    if (isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function getValidatedConfig() {
    return {
        port:          clampInt(adapter.config?.port,          1024, 65535, 8089),
        logBufferSize: clampInt(adapter.config?.logBufferSize,  50,   5000,  500),
        keepHistory:   clampInt(adapter.config?.keepHistory,    0,    100000, 0),
        verboseLogging: !!adapter.config?.verboseLogging,
        user:     (adapter.config?.user     || '').trim(),
        password: (adapter.config?.password || '').trim(),
    };
}

// ─── ready ────────────────────────────────────────────────────────────────────
adapter.on('ready', async () => {
    const cfg = getValidatedConfig();
    logBufferMaxSize = cfg.logBufferSize;
    log(LVL.INFO, CAT.SYSTEM, `MeterMaster Adapter v${CURRENT_VERSION} started`,
        `Port: ${cfg.port} | Logging: ${cfg.verboseLogging ? 'verbose' : 'standard'} | Buffer: ${logBufferMaxSize}`);

    await adapter.setStateAsync('info.connection', { val: false, ack: true });

    // readingsReceived aus persistentem State wiederherstellen
    const savedRx = await adapter.getStateAsync('info.readingsReceived');
    if (savedRx && typeof savedRx.val === 'number') {
        readingsReceived = savedRx.val;
    }

    // In-Memory-Cache aus gespeicherten ioBroker-States wiederherstellen
    await restoreCacheFromStates();
    await restoreNodesFromStates();
    await migrateStateRoles();

    // ESP32-Node-States beobachten (Heartbeat-Erkennung via simple-api)
    adapter.subscribeStates('nodes.*');

    startHttpServer();
});

adapter.on('unload', (callback) => {
    log(LVL.INFO, CAT.SYSTEM, 'Adapter stopping');
    try { if (server) { server.close(() => callback()); } else { callback(); } }
    catch (e) { callback(); }
});

// ─── State-Change-Handler (ESP32 Heartbeats via simple-api) ──────────────────
adapter.on('stateChange', async (id, state) => {
    // Eigene Writes (ack: true) ignorieren – nur externe Änderungen verarbeiten
    if (!state || state.ack) return;
    if (state.val === null) return;
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
    if (field === 'cmd' && state.val) nodesCache[mac].cmd = String(state.val);

    if (field === 'lastSeen') {
        const n = nodesCache[mac];
        log(LVL.INFO, CAT.NODE, `Heartbeat`, `${mac} | IP: ${n.ip || '?'} | v${n.version || '?'} | ${n.name || 'unnamed'}`);
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
            log(LVL.DEBUG, CAT.SYSTEM, 'Cache restore', 'No stored readings found');
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

        log(LVL.INFO, CAT.SYSTEM, `Cache restored`, `${restored} meters loaded from ioBroker states`);
    } catch (e) {
        log(LVL.WARN, CAT.SYSTEM, 'Cache restore failed', e.message);
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
            if (field === 'cmd' && state.val) nodesCache[mac].cmd = String(state.val);
        }
        if (count > 0) log(LVL.INFO, CAT.NODE, `Nodes restored`, `${count} ESP32 node(s) loaded from states`);
        else           log(LVL.DEBUG, CAT.NODE, 'No registered nodes found');
    } catch (e) {
        log(LVL.WARN, CAT.NODE, 'Node restore failed', e.message);
    }
}

// ─── ESP32 Node States anlegen ────────────────────────────────────────────────
async function ensureNodeStates(mac) {
    const base = `nodes.${mac}`;
    await ensureChannel('nodes',      'ESP32 Nodes');
    await ensureChannel(base,         `ESP32 Node ${mac}`);
    await ensureState(`${base}.ip`,        { name: 'IP address',              type: 'string', role: 'info.ip',       read: true, write: false });
    await ensureState(`${base}.name`,      { name: 'Device name',             type: 'string', role: 'info.name',     read: true, write: false });
    await ensureState(`${base}.version`,   { name: 'Firmware version',        type: 'string', role: 'info.firmware', read: true, write: false });
    await ensureState(`${base}.lastSeen`,  { name: 'Last seen (ms)',          type: 'number', role: 'value.time',    read: true, write: false });
    await ensureState(`${base}.config`,    { name: 'Configuration (JSON)',    type: 'string', role: 'json',          read: true, write: true  });
    await ensureState(`${base}.configAck`, { name: 'Config acknowledgement', type: 'string', role: 'json',          read: true, write: false });
    await ensureState(`${base}.cmd`,       { name: 'Command (JSON)',          type: 'string', role: 'json',          read: true, write: true  });
}

// ─── HTTP-Server ──────────────────────────────────────────────────────────────
function startHttpServer() {
    const cfg      = getValidatedConfig();
    const port     = cfg.port;
    const user     = cfg.user;
    const password = cfg.password;

    server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin',  '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, PUT, GET, OPTIONS');
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

        // ESP32 node registration (no auth – ESP32 has no credentials)
        if (req.method === 'POST' && url === '/api/register') {
            readBody(req, b => handleNodeRegister(b, res, clientIp)); return;
        }
        // ESP32 Config-Poll (kein Auth)
        const configPollMatch = url.match(/^\/api\/nodes\/([A-Fa-f0-9]+)\/config$/);
        if (req.method === 'GET' && configPollMatch) {
            handleNodeConfigPoll(configPollMatch[1].toUpperCase(), res); return;
        }
        // ESP32 ConfigAck (kein Auth)
        const ackMatch = url.match(/^\/api\/nodes\/([A-Fa-f0-9]+)\/configAck$/);
        if (req.method === 'POST' && ackMatch) {
            readBody(req, b => handleNodeAck(ackMatch[1].toUpperCase(), b, res)); return;
        }

        // Favicon ohne Auth durchlassen (Browser ruft das automatisch ab)
        if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }

        // Basic Auth für schreibende Endpunkte
        if (user && password) {
            const authHeader = req.headers['authorization'] || '';
            if (!authHeader.startsWith('Basic ')) {
                log(LVL.WARN, CAT.AUTH, `No auth header`, `IP: ${clientIp} | ${url}`);
                res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="MeterMaster"' });
                res.end(JSON.stringify({ error: 'Authentication required' })); return;
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
                log(LVL.WARN, CAT.AUTH, `Invalid credentials`, `IP: ${clientIp} | User: "${reqUser}"`);
                res.writeHead(403); res.end(JSON.stringify({ error: 'Invalid credentials' })); return;
            }
            log(LVL.DEBUG, CAT.AUTH, `Auth OK`, `IP: ${clientIp} | User: "${reqUser}"`);
        }

        if      (req.method === 'GET'  && url === '/api/ping')     { handlePing(res, clientIp); }
        else if ((req.method === 'POST' || req.method === 'PUT') && url === '/api/reading') {
            readBody(req, b => handleReading(b, res, clientIp));
        }
        else if (req.method === 'POST' && url === '/api/readings') { readBody(req, b => handleReadings(b, res, clientIp)); }
        else if (req.method === 'POST' && url === '/api/import')   { readBody(req, b => handleImport(b, res, clientIp)); }
        else {
            // Node-Config: POST /api/nodes/{MAC}/config
            const nodeMatch = url.match(/^\/api\/nodes\/([A-Fa-f0-9]+)\/config$/);
            if (req.method === 'POST' && nodeMatch) {
                readBody(req, b => handleNodeConfig(nodeMatch[1].toUpperCase(), b, res, clientIp));
            } else {
                // Node-Cmd: POST /api/nodes/{MAC}/cmd
                const cmdMatch = url.match(/^\/api\/nodes\/([A-Fa-f0-9]+)\/cmd$/);
                if (req.method === 'POST' && cmdMatch) {
                    readBody(req, b => handleNodeCmd(cmdMatch[1].toUpperCase(), b, res));
                } else {
                    log(LVL.WARN, CAT.CONNECT, `Unknown URL`, `${req.method} ${url} from ${clientIp}`);
                    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
                }
            }
        }
    });

    server.on('error', err => {
        log(LVL.ERROR, CAT.SYSTEM, `HTTP error: ${err.message}`,
            err.code === 'EADDRINUSE' ? `Port ${port} in use!` : undefined);
    });
    server.listen(port, '0.0.0.0', () => {
        log(LVL.INFO, CAT.SYSTEM, `Listening on port ${port}`, `Web UI: http://IP:${port}/`);
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
    if (!data || typeof data !== 'object') return 'Not an object';
    if (!data.house      || typeof data.house      !== 'string') return 'Required field missing: house';
    if (!data.apartment  || typeof data.apartment  !== 'string') return 'Required field missing: apartment';
    if (!data.meter      || typeof data.meter      !== 'string') return 'Required field missing: meter';
    if (data.value === undefined || data.value === null)         return 'Required field missing: value';
    if (isNaN(parseFloat(data.value)))                           return 'value must be a number';
    if (!data.readingDate)                                       return 'Required field missing: readingDate';
    if (isNaN(new Date(data.readingDate).getTime()))             return 'readingDate: invalid date';
    return null;
}

// ─── Einzelne Ablesung ────────────────────────────────────────────────────────
async function handleReading(body, res, clientIp) {
    let data;
    try { data = JSON.parse(body); } catch {
        log(LVL.WARN, CAT.SYNC, `Invalid JSON`, `IP: ${clientIp}`);
        sendJson(res, 400, { error: 'Invalid JSON' }); return;
    }
    const err = validateReading(data);
    if (err) { log(LVL.WARN, CAT.SYNC, `Validation error`, err); sendJson(res, 422, { error: err }); return; }
    log(LVL.INFO, CAT.SYNC, `Reading received`,
        `${data.house}/${data.apartment}/${data.meter} = ${data.value} ${data.unit||''} (${data.readingDate})`);
    try {
        const result = await storeReading(data);
        sendJson(res, 200, { ok: true, path: result.path, history: result.history });
    } catch (e) {
        log(LVL.ERROR, CAT.SYNC, `Storage error`, e.message);
        sendJson(res, 500, { error: e.message });
    }
}

// ─── Batch ────────────────────────────────────────────────────────────────────
async function handleReadings(body, res, clientIp) {
    let items;
    try { items = JSON.parse(body); if (!Array.isArray(items)) items = [items]; } catch {
        log(LVL.WARN, CAT.SYNC, `Invalid JSON in batch`, `IP: ${clientIp}`);
        sendJson(res, 400, { error: 'Array expected' }); return;
    }
    log(LVL.INFO, CAT.SYNC, `Batch received`, `IP: ${clientIp} | ${items.length} readings`);
    let stored = 0, failed = 0;
    const errors = [];
    for (const data of items) {
        const err = validateReading(data);
        if (err) { failed++; errors.push(`${data.meter||'?'}: ${err}`); continue; }
        try { await storeReading(data); stored++; }
        catch (e) { failed++; errors.push(`${data.meter||'?'}: ${e.message}`); log(LVL.ERROR, CAT.SYNC, `Batch error`, `${data.meter}: ${e.message}`); }
    }
    const summary = `${stored} stored, ${failed} failed`;
    if (failed === 0) log(LVL.INFO, CAT.SYNC, `Batch OK`, summary);
    else              log(LVL.WARN, CAT.SYNC, `Batch with errors`, summary);
    sendJson(res, 200, { ok: failed === 0, stored, failed, errors });
}

// ─── Import (App-Export Schema 2.0) ──────────────────────────────────────────
async function handleImport(body, res, clientIp) {
    let data;
    try { data = JSON.parse(body); } catch {
        log(LVL.WARN, CAT.IMPORT, `Invalid JSON`, `IP: ${clientIp}`);
        sendJson(res, 400, { error: 'Invalid JSON' }); return;
    }

    // Schema validation
    if (!data.Apartments || !data.Meters || !data.Readings) {
        sendJson(res, 422, { error: 'Invalid format: Apartments, Meters and Readings required' }); return;
    }

    const schema  = data.SchemaVersion || '1.0';
    const house   = data.HouseName || 'MyHouse';
    log(LVL.INFO, CAT.IMPORT, `Import started`,
        `Schema: ${schema} | ${data.Apartments.length} apartments | ${data.Meters.length} meters | ${data.Readings.length} readings | IP: ${clientIp}`);

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
            log(LVL.WARN, CAT.IMPORT, `Meter not found`, `MeterId: ${reading.MeterId}`);
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
            log(LVL.WARN, CAT.IMPORT, `Invalid reading skipped`, `${meter.Name}: ${err}`);
            continue;
        }

        try {
            await storeReading(payload);
            stored++;
        } catch (e) {
            failed++;
            errors.push(`${meter.Name}: ${e.message}`);
            log(LVL.ERROR, CAT.IMPORT, `Storage error`, `${meter.Name}: ${e.message}`);
        }
    }

    const summary = `${stored} imported, ${skipped} skipped, ${failed} failed`;
    if (failed === 0) log(LVL.INFO, CAT.IMPORT, `Import completed`, summary);
    else              log(LVL.WARN, CAT.IMPORT, `Import with errors`, summary);

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
    await ensureChannel(`${base}.readings`, 'Readings');

    if (isNew) log(LVL.INFO, CAT.DATAPOINT, `New meter`, `metermaster.0.${base}`);

    const dpNew = await ensureState(`${base}.readings.latest`,     { name: `${data.meter} – latest value`, type: 'number', role: 'value', unit: data.unit||'', read: true, write: false });
    await ensureState(`${base}.readings.latestDate`, { name: 'Reading date',    type: 'string', role: 'date', read: true, write: false });
    await ensureState(`${base}.name`,                { name: 'Meter name',      type: 'string', role: 'text', read: true, write: false });
    await ensureState(`${base}.unit`,                { name: 'Unit',            type: 'string', role: 'text', read: true, write: false });
    await ensureState(`${base}.typeName`,            { name: 'Meter type',      type: 'string', role: 'text', read: true, write: false });
    await ensureState(`${base}.readings.history`,    { name: 'Reading history', type: 'string', role: 'json', read: true, write: false });

    if (dpNew) log(LVL.INFO, CAT.DATAPOINT, `Data points created`, `${base}.readings.{latest,latestDate,history} + name/unit/typeName`);

    await adapter.setStateAsync(`${base}.name`,     { val: data.meter,        ts, ack: true });
    await adapter.setStateAsync(`${base}.unit`,     { val: data.unit||'',     ts, ack: true });
    await adapter.setStateAsync(`${base}.typeName`, { val: data.typeName||'', ts, ack: true });

    const histResult = await updateHistory(base, { value, unit: data.unit||'', readingDate: data.readingDate, ts });
    if (histResult === 'added')     log(LVL.DEBUG, CAT.HISTORY, `History +1`, `${base} @ ${data.readingDate}`);
    if (histResult === 'updated')   log(LVL.INFO,  CAT.HISTORY, `History updated`, `${base} @ ${data.readingDate} → ${value}`);
    if (histResult === 'duplicate') log(LVL.DEBUG, CAT.HISTORY, `Duplicate`,  `${base} @ ${data.readingDate}`);

    // Cache + latest anhand chronologisch neuestem History-Eintrag
    cacheReading(house, apt, meter, value, data.unit||'', data.typeName||'', data.readingDate, ts);
    const cached = receivedData[house][apt][meter];
    const latestTs = new Date(cached.latestDate).getTime();
    await adapter.setStateAsync(`${base}.readings.latest`,     { val: cached.latest,     ts: latestTs, ack: true });
    await adapter.setStateAsync(`${base}.readings.latestDate`, { val: cached.latestDate, ts: latestTs, ack: true });

    log(LVL.DEBUG, CAT.SYNC, `State written`, `metermaster.0.${base} = ${value} ${data.unit||''} | ${data.readingDate} (${histResult})`);

    readingsReceived++;
    await adapter.setStateAsync('info.lastSync',         { val: Date.now(), ack: true });
    await adapter.setStateAsync('info.readingsReceived', { val: readingsReceived,         ack: true });
    return { path: base, history: histResult };
}

// ─── Historie ─────────────────────────────────────────────────────────────────
async function updateHistory(base, entry) {
    const stateId = `${base}.readings.history`;
    const keep    = getValidatedConfig().keepHistory;
    let   history = [];
    try {
        const ex = await adapter.getStateAsync(stateId);
        if (ex && ex.val) { history = JSON.parse(ex.val); if (!Array.isArray(history)) history = []; }
    } catch { history = []; }

    const idx = history.findIndex(h => h.ts === entry.ts);
    if (idx >= 0) {
        if (history[idx].value === entry.value) return 'duplicate';
        history[idx] = entry;
        history.sort((a, b) => a.ts - b.ts);
        await adapter.setStateAsync(stateId, { val: JSON.stringify(history), ts: entry.ts, ack: true });
        return 'updated';
    }

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
    const fullCommon = {
        ...common,
        read:  common.read  !== undefined ? common.read  : true,
        write: common.write !== undefined ? common.write : false,
        def:   common.type  === 'number'  ? 0 : (common.type === 'array' ? '[]' : '')
    };
    const ex = await adapter.getObjectAsync(id).catch(() => null);
    if (ex) {
        const patch = {};
        for (const key of ['role', 'type', 'read', 'write', 'unit']) {
            if (fullCommon[key] !== undefined && ex.common[key] !== fullCommon[key]) {
                patch[key] = fullCommon[key];
            }
        }
        if (Object.keys(patch).length) {
            await adapter.extendObjectAsync(id, { common: patch });
        }
        return false;
    }
    await adapter.setObjectNotExistsAsync(id, {
        type: 'state',
        common: fullCommon,
        native: {}
    });
    return true;
}

// ─── State-Rollen-Migration (deprecated → ioBroker-Rollenkatalog) ───────────────
const DEPRECATED_ROLE_MAP = {
    'value.datetime': 'date',
    'value.unit':     'text',
    'info.type':      'text',
    'info.version':   'info.firmware',
};

function resolveMigratedRole(id, common) {
    if (DEPRECATED_ROLE_MAP[common.role]) {
        return DEPRECATED_ROLE_MAP[common.role];
    }
    if (common.role === 'value' && common.type === 'string') {
        const field = id.split('.').pop();
        if (field === 'config' || field === 'configAck' || field === 'cmd') {
            return 'json';
        }
    }
    return null;
}

async function migrateStateRoles() {
    try {
        const allObjects = await adapter.getAdapterObjectsAsync();
        if (!allObjects) return;
        let fixed = 0;
        for (const [id, obj] of Object.entries(allObjects)) {
            if (obj.type !== 'state') continue;
            const newRole = resolveMigratedRole(id, obj.common || {});
            if (newRole && obj.common.role !== newRole) {
                await adapter.extendObjectAsync(id, { common: { role: newRole } });
                fixed++;
            }
        }
        if (fixed) log(LVL.INFO, CAT.SYSTEM, 'State roles migrated', `${fixed} objects`);
    } catch (e) {
        log(LVL.WARN, CAT.SYSTEM, 'State role migration failed', e.message);
    }
}

// ─── API Endpunkte ────────────────────────────────────────────────────────────
function serveDataJson(res) {
    sendJson(res, 200, {
        data: receivedData,
        receivedTotal: readingsReceived,
        namespace: adapter.namespace,
    });
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
        sendJson(res, 400, { error: 'Invalid JSON' }); return;
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
        log(LVL.INFO, CAT.NODE, `Config set`, `${mac} \u2192 ${sid || '(empty)'} | IP: ${nodesCache[mac]?.ip || '?'}`);
        sendJson(res, 200, { ok: true, mac, config });
    } catch (e) {
        log(LVL.ERROR, CAT.NODE, `Config error`, `${mac}: ${e.message}`);
        sendJson(res, 500, { error: e.message });
    }
}

// ─── Node-Befehl (POST /api/nodes/{MAC}/cmd) ──────────────────────────────────
// Unterstützte Befehle: { "ledOn": true/false }
//                       { "sid": "...", "label": "...", "unit": "..." }  (Zähler wechseln)
async function handleNodeCmd(mac, body, res) {
    let data;
    try { data = JSON.parse(body); } catch {
        sendJson(res, 400, { error: 'Invalid JSON' }); return;
    }
    const cmdStr = JSON.stringify(data);
    try {
        await ensureNodeStates(mac);
        await adapter.setStateAsync(`nodes.${mac}.cmd`, { val: cmdStr, ack: true });
        if (!nodesCache[mac]) nodesCache[mac] = { mac };
        nodesCache[mac].cmd = cmdStr;
        const keys = Object.keys(data).join(', ');
        log(LVL.INFO, CAT.NODE, `Command set`, `${mac} → ${keys}`);
        sendJson(res, 200, { ok: true, mac, cmd: data });
    } catch (e) {
        log(LVL.ERROR, CAT.NODE, `Cmd error`, `${mac}: ${e.message}`);
        sendJson(res, 500, { error: e.message });
    }
}

// ─── Node-Registrierung via HTTP (POST /api/register) ────────────────────────
// ESP32 sendet: { mac, ip, name, version, configAck? }
// Adapter legt States an, aktualisiert Cache, antwortet mit aktuellem Config-JSON
async function handleNodeRegister(body, res, clientIp) {
    let data;
    try { data = JSON.parse(body); } catch {
        sendJson(res, 400, { error: 'Invalid JSON' }); return;
    }
    const mac     = (data.mac     || '').replace(/[^A-Fa-f0-9]/g, '').toUpperCase();
    const ip      = (data.ip      || clientIp || '').trim();
    const name    = (data.name    || 'ESP32 Node').trim();
    const version = (data.version || '').trim();
    const ack     = data.configAck ? String(data.configAck) : null;

    if (!mac) { sendJson(res, 400, { error: 'Field mac missing' }); return; }

    const ts = Date.now();
    if (!nodesCache[mac]) nodesCache[mac] = { mac };
    nodesCache[mac].ip       = ip;
    nodesCache[mac].name     = name;
    nodesCache[mac].version  = version;
    nodesCache[mac].lastSeen = ts;
    if (ack) nodesCache[mac].configAck = ack;

    try {
        await ensureNodeStates(mac);
        await adapter.setStateAsync(`nodes.${mac}.ip`,       { val: ip,      ack: true });
        await adapter.setStateAsync(`nodes.${mac}.name`,     { val: name,    ack: true });
        await adapter.setStateAsync(`nodes.${mac}.version`,  { val: version, ack: true });
        await adapter.setStateAsync(`nodes.${mac}.lastSeen`, { val: ts,      ack: true });
        if (ack) await adapter.setStateAsync(`nodes.${mac}.configAck`, { val: ack, ack: true });

        log(LVL.INFO, CAT.NODE, `Heartbeat`, `${mac} | IP: ${ip} | v${version} | ${name}`);

        // Aktuelle Config zurückgeben (null wenn noch keine gesetzt)
        const config = nodesCache[mac].config || null;
        sendJson(res, 200, { ok: true, mac, config });
    } catch (e) {
        log(LVL.ERROR, CAT.NODE, `Register error`, `${mac}: ${e.message}`);
        sendJson(res, 500, { error: e.message });
    }
}

// ─── Node ConfigAck (POST /api/nodes/{MAC}/configAck) ────────────────────────
// ESP32 meldet zurück dass Config übernommen wurde
async function handleNodeAck(mac, body, res) {
    let data = {};
    try { data = JSON.parse(body); } catch { /* ack-String ist optional */ }
    const ack = data.ack || String(Date.now());

    if (!nodesCache[mac]) nodesCache[mac] = { mac };
    nodesCache[mac].configAck = ack;

    try {
        await ensureNodeStates(mac);
        await adapter.setStateAsync(`nodes.${mac}.configAck`, { val: ack, ack: true });
        log(LVL.INFO, CAT.NODE, `Config acknowledged`, `${mac} | ack: ${ack}`);
        sendJson(res, 200, { ok: true });
    } catch (e) {
        sendJson(res, 500, { error: e.message });
    }
}

// ─── Node Config-Poll (GET /api/nodes/{MAC}/config) ───────────────────────────
// ESP32 fragt alle 15s aktuelle Config ab
async function handleNodeConfigPoll(mac, res) {
    const node = nodesCache[mac];
    if (!node) {
        sendJson(res, 200, { ok: true, config: null, cmd: null });
        return;
    }
    // cmd einmalig ausliefern und danach löschen
    const cmd = node.cmd || null;
    if (cmd) {
        node.cmd = null;
        try { await adapter.setStateAsync(`nodes.${mac}.cmd`, { val: '', ack: true }); } catch(_) {}
    }
    sendJson(res, 200, { ok: true, mac, config: node.config || null, cmd });
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
  Electricity:'\u26A1', Gas:'\uD83D\uDD25', Water:'\uD83D\uDCA7', HotWater:'\uD83C\uDF21',
  TotalWater:'\uD83D\uDCA7', ColdWater:'\u2744', Heat:'\uD83C\uDFE0', HeatMeter:'\uD83C\uDFE0',
  Cooling:'\uD83E\uDDCA', Oil:'\uD83D\uDEE2', Other:'\uD83D\uDCDF'
};

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MeterMaster</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
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
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.print-scope-btn {
  background: transparent; border: 1px solid var(--border); color: var(--text-dim);
  border-radius: 6px; padding: 2px 8px; cursor: pointer; font-size: .78em;
  white-space: nowrap;
}
.print-scope-btn:hover { color: var(--secondary); border-color: var(--secondary); }
.mc-nodes {
  margin-top: 10px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
}
.mc-nodes-label {
  font-size: .72em; color: var(--text-muted); text-transform: uppercase; letter-spacing: .4px;
  margin-right: 2px;
}
.node-chip {
  border: 1px solid var(--border); background: var(--bg-surface2); color: var(--text-dim);
  border-radius: 999px; padding: 3px 10px; font-size: .75em; font-weight: 600;
  cursor: pointer; line-height: 1.3; display: inline-flex; align-items: center; gap: 5px;
}
.node-chip:hover { border-color: var(--secondary); color: var(--secondary); }
.node-chip.active {
  background: rgba(76,175,80,.18); color: #A5D6A7; border-color: rgba(76,175,80,.45);
}
.node-chip.offline { opacity: .7; }
.node-chip .dot {
  width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); display: inline-block;
}
.node-chip.active .dot { background: var(--accent); box-shadow: 0 0 4px var(--accent); }
.meter-card.has-node {
  border-color: rgba(76,175,80,.35);
  box-shadow: inset 0 0 0 1px rgba(76,175,80,.12);
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
.hist-edit-btn {
  background: transparent; border: 1px solid var(--border); color: var(--text-dim);
  border-radius: 6px; padding: 2px 8px; cursor: pointer; font-size: .78em;
}
.hist-edit-btn:hover { color: var(--secondary); border-color: var(--secondary); }
.mc-consume {
  font-size: .76em; color: var(--accent); margin-top: 6px;
  display: flex; align-items: center; gap: 4px;
}
.mc-actions {
  display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap;
}
.mc-chart-btn, .mc-csv-btn {
  font-size: .76em; padding: 4px 10px; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--border-light); background: var(--bg-surface3);
  color: var(--secondary); transition: border-color .15s, background .15s;
}
.mc-chart-btn:hover, .mc-csv-btn:hover {
  border-color: var(--primary); background: var(--primary-deep);
}
.lang-select {
  background: var(--bg-surface2); border: 1px solid var(--border-light);
  color: var(--text-dim); padding: 3px 8px; border-radius: 6px;
  font-size: .75em; font-weight: 600; cursor: pointer; outline: none;
}
.lang-select:hover { border-color: var(--primary); color: var(--text); }

.modal-overlay {
  position: fixed; inset: 0; background: rgba(15,11,26,.88);
  z-index: 9998; display: none; align-items: center; justify-content: center;
  padding: 16px;
}
.chart-modal {
  background: var(--bg-surface); border: 1px solid var(--border-light);
  border-radius: 16px; padding: 22px 24px; width: 100%; max-width: 820px;
  max-height: 92vh; overflow-y: auto;
}
.chart-modal-head {
  display: flex; justify-content: space-between; align-items: flex-start;
  gap: 12px; margin-bottom: 14px;
}
.chart-modal-title { font-size: 1.05em; font-weight: 700; color: var(--secondary); }
.chart-modal-sub   { font-size: .78em; color: var(--text-dim); margin-top: 3px; }
.chart-close {
  background: none; border: none; color: var(--text-dim); font-size: 1.6em;
  cursor: pointer; line-height: 1; padding: 0 4px;
}
.chart-close:hover { color: var(--text); }
.chart-range-btns { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
.chart-range {
  background: var(--bg-surface2); border: 1px solid var(--border);
  color: var(--text-dim); padding: 4px 12px; border-radius: 7px;
  cursor: pointer; font-size: .78em; font-weight: 600;
}
.chart-range.active, .chart-range:hover {
  border-color: var(--primary); color: var(--secondary); background: var(--primary-deep);
}
.chart-yearly { margin-left: auto; }
.chart-kpi {
  font-size: .82em; color: var(--accent); margin-bottom: 12px;
  padding: 8px 12px; background: rgba(76,175,80,.08);
  border-radius: 8px; border: 1px solid rgba(76,175,80,.2);
}
.chart-kpi-yearly {
  margin-top: 6px; color: var(--secondary);
  border-color: rgba(123,84,196,.25); background: rgba(123,84,196,.08);
  padding: 6px 12px; border-radius: 8px; border: 1px solid rgba(123,84,196,.25);
}
.chart-wrap-box {
  background: var(--bg-deep); border: 1px solid var(--border);
  border-radius: 10px; padding: 12px; margin-bottom: 12px; position: relative; height: 260px;
}
.chart-wrap-box.chart-wrap-sm { height: 200px; }
.chart-modal-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.chart-no-data {
  text-align: center; padding: 40px 16px; color: var(--text-dim); font-size: .88em;
}

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
    <div class="hstat"><span id="lbl-rx">Readings</span>: <b id="st-rx">–</b></div>
    <div class="hstat"><span id="lbl-nodes">Nodes</span>: <b id="st-nodes">–</b></div>
    <div class="hstat"><span id="lbl-up">Uptime</span>: <b id="st-up">–</b></div>
    <div class="live-dot" id="st-live">● Live</div>
    <select class="lang-select" id="lang-select" title="Language">
      <option value="de">DE</option>
      <option value="en">EN</option>
    </select>
  </div>
</header>

<!-- ══ NAV ═══════════════════════════════════════════════════════════════════ -->
<nav>
  <button class="tab active" id="tab-data"   data-tab="data"   onclick="showTab('data')"  >📊 Data</button>
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
      <p id="no-data-msg">No readings received yet.<br>Start a sync in the MeterMaster app or upload a backup.</p>
    </div>
  </div>
</div>

<!-- ══ NODES ═════════════════════════════════════════════════════════════════ -->
<div class="page" id="page-nodes">
  <div id="nodes-page-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
    <div>
      <h2 id="nodes-title" style="font-size:1em;color:var(--secondary);margin-bottom:2px;">📡 Registered ESP32 Nodes</h2>
      <div style="font-size:.82em;color:var(--text-dim);"><span id="lbl-nd-total">Total:</span> <b id="nd-total" style="color:var(--text);">0</b> &nbsp;|&nbsp; <span id="lbl-nd-online">Online:</span> <b id="nd-online" style="color:var(--accent);">0</b></div>
    </div>
    <button class="ghost" id="nodes-refresh-btn" onclick="fetchNodes()">↻ Refresh</button>
  </div>
  <div id="nodes-container">
    <div class="empty-state">
      <div class="ico">📡</div>
      <p id="no-nodes-msg">No ESP32 nodes registered yet.<br>When a MeterMaster node starts and sends its heartbeat, it will appear here automatically.</p>
    </div>
  </div>
</div>

<!-- ══ IMPORT ════════════════════════════════════════════════════════════════ -->
<div class="page" id="page-import">
  <div class="import-card">
    <h3 id="import-title">📥 Import app backup</h3>
    <p id="import-desc">Import a backup export from the MeterMaster app directly into the adapter. All readings are stored with their original timestamps — ideal for initial setup or importing historical data.</p>

    <div class="schema-box">{ "SchemaVersion": "2.0", "Source": "MeterMaster",
  "Apartments": [ { "Id": 1, "Name": "Westerheim" } ],
  "Meters":     [ { "Id": 1, "Name": "Warmwasser", "ApartmentId": 1, "Unit": "m³" } ],
  "Readings":   [ { "MeterId": 1, "Value": 128.75, "ReadingDate": "2024-02-12T09:30:00" } ]
}</div>

    <div class="house-row">
      <label id="import-house-label">House name (ioBroker path):</label>
      <input type="text" id="imp-house" value="MyHouse" placeholder="e.g. MyHouse">
    </div>

    <div class="drop-zone" id="drop-zone" onclick="document.getElementById('file-in').click()">
      <div class="dz-ico">📂</div>
      <p id="import-drop-text">Drop JSON file here or click to select</p>
    </div>
    <input type="file" id="file-in" accept=".json">

    <div class="preview-box" id="preview-box">
      <h4 id="import-preview-title">📋 Preview</h4>
      <div id="preview-content"></div>
    </div>

    <div class="btn-row">
      <button class="primary" id="imp-btn" disabled onclick="doImport()">⬆ Import</button>
      <button class="ghost" id="import-reset-btn" onclick="clearImport()">✕ Reset</button>
    </div>
    <div class="result-box" id="imp-result"></div>
  </div>
</div>

<!-- ══ LOGS ═══════════════════════════════════════════════════════════════════ -->
<div class="page" id="page-logs">
  <div class="log-toolbar">
    <select id="fl">
      <option value="" id="fl-all">All levels</option>
      <option value="debug">DEBUG</option>
      <option value="info">INFO</option>
      <option value="warn">WARN</option>
      <option value="error">ERROR</option>
    </select>
    <select id="fc">
      <option value="" id="fc-all">All categories</option>
      <option value="SYSTEM">SYSTEM</option>
      <option value="AUTH">AUTH</option>
      <option value="CONNECT">CONNECT</option>
      <option value="DATAPOINT">DATAPOINT</option>
      <option value="SYNC">SYNC</option>
      <option value="HISTORY">HISTORY</option>
      <option value="IMPORT">IMPORT</option>
      <option value="NODE">NODE</option>
    </select>
    <input class="search" type="text" id="ft" placeholder="Search…">
    <button class="ghost" id="log-clear-btn" onclick="clearLogs()">🗑 Clear</button>
    <button class="ghost" id="log-export-btn" onclick="exportLogs()">⬇ Export</button>
    <label class="lbl"><input type="checkbox" id="as" checked> <span id="lbl-auto-scroll">Auto-scroll</span></label>
    <label class="lbl"><input type="checkbox" id="ar" checked> <span id="lbl-live">Live</span></label>
  </div>
  <div id="lc"><div class="log-empty" id="log-empty">No log entries yet.</div></div>
</div>


<!-- ══ SYSTEM ════════════════════════════════════════════════════════════════ -->
<div class="page" id="page-system">

  <div class="sys-card">
    <h3 id="sys-stats-title">📊 Statistics</h3>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div style="background:var(--bg-deep);border:1px solid var(--border);border-radius:9px;padding:12px 14px;">
        <div style="font-size:1.6em;font-weight:700;color:var(--secondary);" id="sys-rx">–</div>
        <div id="sys-rx-label" style="font-size:.78em;color:var(--text-dim);margin-top:3px;">Total readings</div>
      </div>
      <div style="background:var(--bg-deep);border:1px solid var(--border);border-radius:9px;padding:12px 14px;">
        <div style="font-size:1.6em;font-weight:700;color:var(--secondary);" id="sys-up">–</div>
        <div id="sys-up-label" style="font-size:.78em;color:var(--text-dim);margin-top:3px;">Uptime</div>
      </div>
      <div style="background:var(--bg-deep);border:1px solid var(--border);border-radius:9px;padding:12px 14px;">
        <div style="font-size:1.6em;font-weight:700;color:var(--accent);" id="sys-online">–</div>
        <div id="sys-online-label" style="font-size:.78em;color:var(--text-dim);margin-top:3px;">Nodes online</div>
      </div>
      <div style="background:var(--bg-deep);border:1px solid var(--border);border-radius:9px;padding:12px 14px;">
        <div style="font-size:1.6em;font-weight:700;color:var(--secondary);" id="sys-total">–</div>
        <div id="sys-total-label" style="font-size:.78em;color:var(--text-dim);margin-top:3px;">Total nodes</div>
      </div>
    </div>
  </div>

  <div class="sys-card">
    <h3 id="sys-version-title">🔄 Adapter version</h3>
    <div class="ver-row"><span class="ver-label" id="sys-lbl-installed">Installed</span>  <span class="ver-val" id="sv-cur">–</span></div>
    <div class="ver-row"><span class="ver-label" id="sys-lbl-latest">Latest (GitHub)</span><span class="ver-val" id="sv-lat">–</span></div>
    <div class="ver-row"><span class="ver-label" id="sys-lbl-status">Status</span>        <span id="sv-status"><span class="badge-warn" id="sv-status-text">Not checked yet</span></span></div>
    <div class="sys-btn-row">
      <button class="ghost" id="sv-check-btn">🔍 Check for updates</button>
      <span id="sv-spin" style="display:none;font-size:.84em;color:var(--text-dim)">⏳ Please wait…</span>
    </div>
    <div class="sys-out" id="sv-out"></div>
  </div>

  <div class="sys-card">
    <h3 id="sys-info-title">ℹ️ Adapter info</h3>
    <div class="ver-row"><span class="ver-label" id="sys-lbl-adapter">Adapter</span>      <span class="ver-val">iobroker.metermaster</span></div>
    <div class="ver-row"><span class="ver-label" id="sys-lbl-port">Port</span>         <span class="ver-val">${port}</span></div>
    <div class="ver-row"><span class="ver-label" id="sys-lbl-repo">Repository</span>
      <a href="https://github.com/MPunktBPunkt/ioBroker.metermaster" target="_blank"
         style="color:var(--primary);font-size:.84em">GitHub ↗</a>
    </div>
  </div>

  <div class="sys-card">
    <h3 id="sys-cmds-title">🔄 Update commands</h3>
    <p id="sys-cmds-desc" style="font-size:.82em;color:var(--text-dim);margin:0 0 12px">
      Update the adapter — run these commands in the ioBroker console:
    </p>
    <div class="cmd-row">
      <code class="cmd-code">iobroker upgrade metermaster</code>
      <button class="cmd-copy" onclick="copyCmd(this)" data-cmd="iobroker upgrade metermaster" title="Copy">📋</button>
    </div>
    <div class="cmd-row" style="margin-top:8px">
      <code class="cmd-code">iobroker restart metermaster.0</code>
      <button class="cmd-copy" onclick="copyCmd(this)" data-cmd="iobroker restart metermaster.0" title="Copy">📋</button>
    </div>
    <div class="cmd-row" style="margin-top:8px">
      <code class="cmd-code">sleep 5 &amp;&amp; iobroker status metermaster.0</code>
      <button class="cmd-copy" onclick="copyCmd(this)" data-cmd="sleep 5 && iobroker status metermaster.0" title="Copy">📋</button>
    </div>
    <p id="sys-cmds-tip" style="font-size:.78em;color:var(--text-dim);margin:10px 0 0">
      💡 Tip: Run all three commands in sequence — wait for each to finish.
    </p>
  </div>

</div>

<div id="ni" onclick="scrollLogBottom()">↓ New entries</div>

<!-- ══ CHART-MODAL (vor Script — init() bindet Listener) ═════════════════════ -->
<div id="chart-overlay" class="modal-overlay">
  <div class="chart-modal">
    <div class="chart-modal-head">
      <div>
        <div class="chart-modal-title" id="chart-title">–</div>
        <div class="chart-modal-sub" id="chart-sub"></div>
      </div>
      <button class="chart-close" id="chart-close" title="Close">&times;</button>
    </div>
    <div class="chart-range-btns">
      <button class="chart-range" data-months="3">3M</button>
      <button class="chart-range" data-months="6">6M</button>
      <button class="chart-range" data-months="12">12M</button>
      <button class="chart-range active" data-months="0">All</button>
      <button class="chart-range chart-yearly" id="chart-yearly-toggle" type="button">↗ Pro Jahr</button>
    </div>
    <div class="chart-kpi" id="chart-kpi" style="display:none"></div>
    <div class="chart-kpi-yearly" id="chart-kpi-yearly" style="display:none"></div>
    <div class="chart-wrap-box"><canvas id="chart-line"></canvas></div>
    <div class="chart-wrap-box chart-wrap-sm"><canvas id="chart-bar"></canvas></div>
    <div class="chart-modal-foot">
      <button class="ghost" id="chart-print-btn" title="Print">🖨 Print</button>
      <button class="ghost" id="chart-csv-btn">⬇ CSV</button>
    </div>
  </div>
</div>
<!-- ══ LOGIN-MODAL ═══════════════════════════════════════════════════════════ -->
<div id="login-overlay" style="display:none;position:fixed;inset:0;background:rgba(15,11,26,.85);z-index:9999;align-items:center;justify-content:center;">
  <div style="background:var(--bg-surface);border:1px solid var(--border-light);border-radius:16px;padding:32px 36px;min-width:320px;max-width:420px;width:90%;">
    <div id="login-title" style="font-size:1.1em;font-weight:700;color:var(--secondary);margin-bottom:6px;">🔑 Sign in</div>
    <div id="login-desc" style="font-size:.82em;color:var(--text-dim);margin-bottom:20px;">Credentials for write actions (assign meter, import).</div>
    <div style="margin-bottom:12px;">
      <label id="login-user-label" style="font-size:.82em;color:var(--text-dim);display:block;margin-bottom:4px;">Username</label>
      <input id="login-user" type="text" value="metermaster" style="width:100%;background:var(--bg-surface2);border:1px solid var(--border-light);color:var(--text);padding:8px 12px;border-radius:8px;font-size:.9em;outline:none;" onkeydown="if(event.key===\'Enter\')document.getElementById(\'login-pass\').focus()">
    </div>
    <div style="margin-bottom:18px;">
      <label id="login-pass-label" style="font-size:.82em;color:var(--text-dim);display:block;margin-bottom:4px;">Password</label>
      <div style="position:relative;">
        <input id="login-pass" type="password" style="width:100%;background:var(--bg-surface2);border:1px solid var(--border-light);color:var(--text);padding:8px 36px 8px 12px;border-radius:8px;font-size:.9em;outline:none;" onkeydown="if(event.key===\'Enter\')doLogin()">
        <button onclick="const i=document.getElementById(\'login-pass\');i.type=i.type===\'password\'?\'text\':\'password\';" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--text-dim);">👁</button>
      </div>
    </div>
    <div id="login-msg" style="font-size:.82em;color:var(--danger);min-height:18px;margin-bottom:12px;"></div>
    <div style="display:flex;gap:10px;">
      <button id="login-submit-btn" onclick="doLogin()" style="flex:1;background:var(--primary);color:#fff;border:none;padding:9px;border-radius:9px;cursor:pointer;font-size:.9em;font-weight:600;">✓ Sign in</button>
      <button id="login-cancel-btn" onclick="hideLoginModal()" style="background:transparent;border:1px solid var(--border-light);color:var(--text-dim);padding:9px 16px;border-radius:9px;cursor:pointer;font-size:.9em;">✕</button>
    </div>
  </div>
</div>

<script>

// ── Auth-System ─────────────────────────────────────────────────────────────
let _authHeader = null;
function getAuthHeader() { return _authHeader; }
function setAuth(user, pass) {
  _authHeader = 'Basic ' + btoa(unescape(encodeURIComponent(user + ':' + pass)));
}
function showLoginModal(msg) {
  document.getElementById('login-msg').textContent = msg || '';
  document.getElementById('login-overlay').style.display = 'flex';
  window.setTimeout(() => document.getElementById('login-user').focus(), 50);
}
function hideLoginModal() {
  document.getElementById('login-overlay').style.display = 'none';
}
async function doLogin() {
  const user = document.getElementById('login-user').value.trim();
  const pass = document.getElementById('login-pass').value;
  if (!user) { document.getElementById('login-msg').textContent = t('login_missing_user'); return; }
  setAuth(user, pass);
  try {
    const r = await fetch('/api/ping', { headers: { 'Authorization': _authHeader } });
    if (r.ok) {
      hideLoginModal();
    } else {
      _authHeader = null;
      document.getElementById('login-msg').textContent = '\u274C ' + t('login_wrong');
    }
  } catch(e) {
    document.getElementById('login-msg').textContent = '\u274C ' + t('login_conn_err');
  }
}
async function authFetch(url, opts) {
  if (!_authHeader) { showLoginModal(); return null; }
  const headers = Object.assign({ 'Content-Type': 'application/json', 'Authorization': _authHeader }, opts.headers || {});
  const r = await fetch(url, Object.assign({}, opts, { headers }));
  if (r.status === 401) { _authHeader = null; showLoginModal('\u274C ' + t('login_expired')); return null; }
  return r;
}

const TYPE_ICONS = {
  Electricity:'\u26A1', Gas:'\uD83D\uDD25', Water:'\uD83D\uDCA7', HotWater:'\uD83C\uDF21',
  TotalWater:'\uD83D\uDCA7', ColdWater:'\u2744', Heat:'\uD83C\uDFE0', HeatMeter:'\uD83C\uDFE0',
  Cooling:'\uD83E\uDDCA', Oil:'\uD83D\uDEE2', Other:'\uD83D\uDCDF'
};

const I18N = {
  de: {
    readings:'Ablesungen', nodes:'Nodes', uptime:'Uptime', live:'Live', disconnected:'Getrennt',
    tab_data:'Daten', tab_nodes:'Nodes', tab_import:'Import', tab_logs:'Logs', tab_system:'System',
    no_data:'Noch keine Ablesungen empfangen.<br>Starte einen Sync in der MeterMaster App oder lade ein Backup hoch.',
    no_nodes:'Noch keine ESP32 Nodes registriert.<br>Wenn ein MeterMaster Node startet, erscheint er automatisch hier.',
    history:'Verlauf', history_edit:'Wert bearbeiten', history_edit_prompt:'Neuer Zählerstand:', history_saved:'Gespeichert',
    since_last:'seit letzter Ablesung', days:'Tage', chart_btn:'Chart', csv_btn:'CSV', print_btn:'Drucken',
    print_chart:'Chart drucken', print_apartment:'Wohnung drucken', print_house:'Haus drucken',
    print_latest_title:'Aktuelle Zählerstände', print_meter:'Zähler', print_value:'Stand',
    print_unit:'Einheit', print_date:'Datum', print_generated:'Erstellt',
    node_label:'Node', node_assign:'Diesen Zähler auf dem Node anzeigen',
    node_unassign:'Anzeige auf diesem Node beenden', node_none:'Keine Nodes registriert',
    chart_readings:'Z\u00E4hlerstand', chart_monthly:'Monatsverbrauch', chart_period_all:'Alles',
    chart_yearly:'Pro Jahr', chart_yearly_proj:'Hochrechnung', chart_per_year:'/Jahr',
    chart_yearly_hint:'basierend auf {days} {daysLabel} ({delta} {unit})',
    chart_no_data:'Zu wenig Daten f\u00FCr eine Grafik (mind. 2 Ablesungen n\u00F6tig).',
    chart_close:'Schlie\u00DFen', error:'Fehler', consume:'Verbrauch',
    ago_just:'gerade eben', ago_sec:'vor {s}s', ago_min:'vor {m}min',
    nodes_title:'Registrierte ESP32 Nodes', nodes_total:'Gesamt:', nodes_online:'Online:', nodes_refresh:'Aktualisieren',
    th_status:'Status', th_name:'Name', th_ip:'IP-Adresse', th_fw:'FW-Version', th_last_seen:'Zuletzt gesehen',
    th_assign:'Z\u00E4hler zuweisen', th_led:'LED', node_online:'Online', node_offline:'Offline',
    no_meter:'\u2014 Kein Z\u00E4hler zugewiesen \u2014', save:'Speichern', saved:'Gespeichert',
    led_on:'Ein', led_off:'Aus', led_on_title:'LED ein', led_off_title:'LED aus',
    import_title:'App-Backup importieren',
    import_desc:'Importiere einen Backup-Export aus der MeterMaster App direkt in den Adapter. Alle Ablesungen werden mit ihren originalen Zeitstempeln gespeichert \u2014 ideal f\u00FCr die erstmalige Bef\u00FCllung oder das Nachf\u00FChren historischer Daten.',
    import_house_label:'Hausname (ioBroker-Pfad):', import_house_ph:'z.B. MeinHaus',
    import_drop:'JSON-Datei hier ablegen oder klicken zum Ausw\u00E4hlen',
    import_preview:'Vorschau', import_btn:'Importieren', import_reset:'Zur\u00FCcksetzen', import_importing:'Importiere\u2026',
    prev_file:'Datei', prev_schema:'Schema', prev_apts:'Wohnungen', prev_meters:'Z\u00E4hler',
    prev_readings:'Ablesungen', prev_compat:'Kompatibel', prev_yes:'Ja', prev_no:'Nein \u2013 Pflichtfelder fehlen',
    log_all_levels:'Alle Level', log_all_cats:'Alle Kategorien', log_search_ph:'Suche\u2026',
    log_clear:'Leeren', log_export:'Export', log_auto_scroll:'Auto-Scroll', log_live:'Live',
    log_empty:'Keine Log-Eintr\u00E4ge vorhanden.', new_entries:'Neue Eintr\u00E4ge',
    sys_stats:'Statistiken', sys_readings_total:'Ablesungen gesamt', sys_uptime:'Uptime',
    sys_nodes_online:'Nodes online', sys_nodes_total:'Nodes gesamt',
    sys_version:'Adapter-Version', sys_installed:'Installiert', sys_latest:'Aktuell (GitHub)',
    sys_status:'Status', sys_check:'Auf Updates pr\u00FCfen', sys_waiting:'Bitte warten\u2026',
    sys_not_checked:'Noch nicht gepr\u00FCft', sys_no_release:'Noch kein Release',
    sys_update_avail:'Update verf\u00FCgbar', sys_up_to_date:'Aktuell',
    sys_github_err:'GitHub nicht erreichbar', sys_no_github_release:'Kein GitHub-Release vorhanden',
    sys_net_err:'Netzwerkfehler', sys_info:'Adapter-Info', sys_adapter:'Adapter',
    sys_port:'Port', sys_repo:'Repository',
    sys_cmds:'Update-Befehle',
    sys_cmds_desc:'Adapter aktualisieren \u2014 Befehle in der ioBroker-Konsole ausf\u00FChren:',
    sys_tip:'Tipp: Alle drei Befehle nacheinander ausf\u00FChren \u2014 warten bis jeder abgeschlossen ist.',
    copy:'Kopieren',
    login_title:'Anmelden',
    login_desc:'Zugangsdaten f\u00FCr schreibende Aktionen (Z\u00E4hler zuweisen, Import).',
    login_user:'Benutzername', login_pass:'Passwort', login_submit:'Anmelden',
    login_missing_user:'Benutzername fehlt', login_wrong:'Falsche Zugangsdaten',
    login_conn_err:'Verbindungsfehler', login_expired:'Sitzung abgelaufen \u2013 bitte neu anmelden',
    invalid_json:'Ung\u00FCltige JSON-Datei', network_err:'Netzwerkfehler'
  },
  en: {
    readings:'Readings', nodes:'Nodes', uptime:'Uptime', live:'Live', disconnected:'Disconnected',
    tab_data:'Data', tab_nodes:'Nodes', tab_import:'Import', tab_logs:'Logs', tab_system:'System',
    no_data:'No readings received yet.<br>Start a sync in the MeterMaster app or upload a backup.',
    no_nodes:'No ESP32 nodes registered yet.<br>When a MeterMaster node starts and sends its heartbeat, it will appear here automatically.',
    history:'History', history_edit:'Edit value', history_edit_prompt:'New meter reading:', history_saved:'Saved',
    since_last:'since last reading', days:'days', chart_btn:'Chart', csv_btn:'CSV', print_btn:'Print',
    print_chart:'Print chart', print_apartment:'Print apartment', print_house:'Print house',
    print_latest_title:'Latest meter readings', print_meter:'Meter', print_value:'Reading',
    print_unit:'Unit', print_date:'Date', print_generated:'Generated',
    node_label:'Node', node_assign:'Show this meter on the node',
    node_unassign:'Stop showing on this node', node_none:'No nodes registered',
    chart_readings:'Meter reading', chart_monthly:'Monthly consumption', chart_period_all:'All',
    chart_yearly:'Per year', chart_yearly_proj:'Projected', chart_per_year:'/yr',
    chart_yearly_hint:'based on {days} {daysLabel} ({delta} {unit})',
    chart_no_data:'Not enough data for a chart (at least 2 readings required).',
    chart_close:'Close', error:'Error', consume:'Consumption',
    ago_just:'just now', ago_sec:'{s}s ago', ago_min:'{m}min ago',
    nodes_title:'Registered ESP32 Nodes', nodes_total:'Total:', nodes_online:'Online:', nodes_refresh:'Refresh',
    th_status:'Status', th_name:'Name', th_ip:'IP address', th_fw:'FW version', th_last_seen:'Last seen',
    th_assign:'Assign meter', th_led:'LED', node_online:'Online', node_offline:'Offline',
    no_meter:'\u2014 No meter assigned \u2014', save:'Save', saved:'Saved',
    led_on:'On', led_off:'Off', led_on_title:'LED on', led_off_title:'LED off',
    import_title:'Import app backup',
    import_desc:'Import a backup export from the MeterMaster app directly into the adapter. All readings are stored with their original timestamps \u2014 ideal for initial setup or importing historical data.',
    import_house_label:'House name (ioBroker path):', import_house_ph:'e.g. MyHouse',
    import_drop:'Drop JSON file here or click to select',
    import_preview:'Preview', import_btn:'Import', import_reset:'Reset', import_importing:'Importing\u2026',
    prev_file:'File', prev_schema:'Schema', prev_apts:'Apartments', prev_meters:'Meters',
    prev_readings:'Readings', prev_compat:'Compatible', prev_yes:'Yes', prev_no:'No \u2013 required fields missing',
    log_all_levels:'All levels', log_all_cats:'All categories', log_search_ph:'Search\u2026',
    log_clear:'Clear', log_export:'Export', log_auto_scroll:'Auto-scroll', log_live:'Live',
    log_empty:'No log entries yet.', new_entries:'New entries',
    sys_stats:'Statistics', sys_readings_total:'Total readings', sys_uptime:'Uptime',
    sys_nodes_online:'Nodes online', sys_nodes_total:'Total nodes',
    sys_version:'Adapter version', sys_installed:'Installed', sys_latest:'Latest (GitHub)',
    sys_status:'Status', sys_check:'Check for updates', sys_waiting:'Please wait\u2026',
    sys_not_checked:'Not checked yet', sys_no_release:'No release yet',
    sys_update_avail:'Update available', sys_up_to_date:'Up to date',
    sys_github_err:'GitHub unreachable', sys_no_github_release:'No GitHub release available',
    sys_net_err:'Network error', sys_info:'Adapter info', sys_adapter:'Adapter',
    sys_port:'Port', sys_repo:'Repository',
    sys_cmds:'Update commands',
    sys_cmds_desc:'Update the adapter \u2014 run these commands in the ioBroker console:',
    sys_tip:'Tip: Run all three commands in sequence \u2014 wait for each to finish.',
    copy:'Copy',
    login_title:'Sign in',
    login_desc:'Credentials for write actions (assign meter, import).',
    login_user:'Username', login_pass:'Password', login_submit:'Sign in',
    login_missing_user:'Username required', login_wrong:'Invalid credentials',
    login_conn_err:'Connection error', login_expired:'Session expired \u2013 please sign in again',
    invalid_json:'Invalid JSON file', network_err:'Network error'
  }
};

let currentLang = 'en';
try {
  const saved = localStorage.getItem('mm-lang');
  currentLang = saved || (navigator.language && navigator.language.startsWith('de') ? 'de' : 'en');
} catch { currentLang = 'en'; }

function t(key, vars) {
  let s = (I18N[currentLang] && I18N[currentLang][key]) || (I18N.en[key]) || key;
  if (vars) Object.keys(vars).forEach(k => { s = s.replace('{'+k+'}', vars[k]); });
  return s;
}
function localeTag() { return currentLang === 'de' ? 'de-DE' : 'en-GB'; }

function applyI18n() {
  document.documentElement.lang = currentLang;
  const ls = document.getElementById('lang-select');
  if (ls) ls.value = currentLang;
  const set = (id, key) => { const el = document.getElementById(id); if (el) el.textContent = t(key); };
  const setHtml = (id, key) => { const el = document.getElementById(id); if (el) el.innerHTML = t(key); };
  const setPh = (id, key) => { const el = document.getElementById(id); if (el) el.placeholder = t(key); };
  set('lbl-rx', 'readings');
  set('lbl-nodes', 'nodes');
  set('lbl-up', 'uptime');
  set('lbl-nd-total', 'nodes_total');
  set('lbl-nd-online', 'nodes_online');
  setHtml('no-data-msg', 'no_data');
  setHtml('no-nodes-msg', 'no_nodes');
  set('nodes-title', 'nodes_title');
  set('nodes-refresh-btn', 'nodes_refresh');
  set('import-title', 'import_title');
  set('import-desc', 'import_desc');
  set('import-house-label', 'import_house_label');
  setPh('imp-house', 'import_house_ph');
  set('import-drop-text', 'import_drop');
  set('import-preview-title', 'import_preview');
  set('imp-btn', 'import_btn');
  set('import-reset-btn', 'import_reset');
  set('fl-all', 'log_all_levels');
  set('fc-all', 'log_all_cats');
  setPh('ft', 'log_search_ph');
  set('log-clear-btn', 'log_clear');
  set('log-export-btn', 'log_export');
  set('lbl-auto-scroll', 'log_auto_scroll');
  set('lbl-live', 'log_live');
  set('log-empty', 'log_empty');
  set('ni', 'new_entries');
  set('sys-stats-title', 'sys_stats');
  set('sys-rx-label', 'sys_readings_total');
  set('sys-up-label', 'sys_uptime');
  set('sys-online-label', 'sys_nodes_online');
  set('sys-total-label', 'sys_nodes_total');
  set('sys-version-title', 'sys_version');
  set('sys-lbl-installed', 'sys_installed');
  set('sys-lbl-latest', 'sys_latest');
  set('sys-lbl-status', 'sys_status');
  set('sv-status-text', 'sys_not_checked');
  set('sv-check-btn', 'sys_check');
  set('sv-spin', 'sys_waiting');
  set('sys-info-title', 'sys_info');
  set('sys-lbl-adapter', 'sys_adapter');
  set('sys-lbl-port', 'sys_port');
  set('sys-lbl-repo', 'sys_repo');
  set('sys-cmds-title', 'sys_cmds');
  set('sys-cmds-desc', 'sys_cmds_desc');
  set('sys-cmds-tip', 'sys_tip');
  document.querySelectorAll('.cmd-copy').forEach(btn => { btn.title = t('copy'); });
  set('login-title', 'login_title');
  set('login-desc', 'login_desc');
  set('login-user-label', 'login_user');
  set('login-pass-label', 'login_pass');
  set('login-submit-btn', 'login_submit');
  const tabs = { 'tab-data':'tab_data', 'tab-nodes':'tab_nodes', 'tab-import':'tab_import', 'tab-logs':'tab_logs', 'tab-system':'tab_system' };
  Object.keys(tabs).forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const icons = { 'tab-data':'\uD83D\uDCCA ', 'tab-nodes':'\uD83D\uDCE1 ', 'tab-import':'\uD83D\uDCE5 ', 'tab-logs':'\uD83D\uDCCB ', 'tab-system':'\u2699\uFE0F ' };
    el.textContent = (icons[id] || '') + t(tabs[id]);
  });
  const crAll = document.querySelector('.chart-range[data-months="0"]');
  if (crAll) crAll.textContent = t('chart_period_all');
  const csvBtn = document.getElementById('chart-csv-btn');
  if (csvBtn) csvBtn.textContent = '\u2B07 ' + t('csv_btn');
  const printBtn = document.getElementById('chart-print-btn');
  if (printBtn) {
    printBtn.textContent = '\uD83D\uDDA8 ' + t('print_btn');
    printBtn.title = t('print_chart');
  }
  const cc = document.getElementById('chart-close');
  if (cc) cc.title = t('chart_close');
  const yearlyBtn = document.getElementById('chart-yearly-toggle');
  if (yearlyBtn) yearlyBtn.textContent = '\u2197 ' + t('chart_yearly');
}

function setLang(lang) {
  if (!I18N[lang]) return;
  currentLang = lang;
  try { localStorage.setItem('mm-lang', lang); } catch {}
  applyI18n();
  fetchData();
  fetchStats();
  const nodesPage = document.getElementById('page-nodes');
  if (nodesPage && nodesPage.classList.contains('active')) fetchNodes();
}

let dataCacheList = [];
let chartCtxIdx = -1;
let chartRangeMonths = 0;
let chartShowYearly = false;
try {
  chartShowYearly = localStorage.getItem('mm-chart-yearly') === '1';
} catch {}
let chartInstLine = null;
let chartInstBar = null;

function calcDelta(history) {
  if (!history || history.length < 2) return null;
  const sorted = history.slice().sort((a, b) => a.ts - b.ts);
  const prev = sorted[sorted.length - 2];
  const last = sorted[sorted.length - 1];
  const delta = last.value - prev.value;
  if (delta < 0) return null;
  const days = Math.max(1, Math.round((last.ts - prev.ts) / 86400000));
  return { delta, days, prev, last };
}

function calcYearlyProjection(history) {
  if (!history || history.length < 2) return null;
  const sorted = history.slice().sort((a, b) => a.ts - b.ts);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const delta = last.value - first.value;
  if (delta < 0) return null;
  const days = Math.max(1, (last.ts - first.ts) / 86400000);
  return { delta, days: Math.max(1, Math.round(days)), yearly: delta * (365 / days) };
}

function calcMonthlyConsumption(history) {
  const sorted = history.slice().sort((a, b) => a.ts - b.ts);
  const months = {};
  for (let i = 1; i < sorted.length; i++) {
    const delta = sorted[i].value - sorted[i - 1].value;
    if (delta < 0) continue;
    const d = new Date(sorted[i].ts);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    months[key] = (months[key] || 0) + delta;
  }
  return months;
}

function filterHistoryByMonths(history, months) {
  if (!months || months <= 0) return history.slice();
  const cutoff = Date.now() - months * 30 * 86400000;
  return history.filter(h => h.ts >= cutoff);
}

function fmtNum(n) {
  if (n === undefined || n === null || isNaN(n)) return '\u2013';
  return Number(n).toLocaleString(localeTag(), { maximumFractionDigits: 3 });
}

function exportMeterCsv(idx) {
  const m = dataCacheList[idx];
  if (!m) return;
  const hist = (m.history || []).slice().sort((a, b) => a.ts - b.ts);
  const sep = currentLang === 'de' ? ';' : ',';
  const hdr = currentLang === 'de'
    ? ['Datum', 'Wert', 'Einheit', 'Verbrauch'].join(sep)
    : ['Date', 'Value', 'Unit', 'Consumption'].join(sep);
  let rows = [hdr];
  for (let i = 0; i < hist.length; i++) {
    const cons = (i > 0 && hist[i].value >= hist[i - 1].value) ? (hist[i].value - hist[i - 1].value) : '';
    rows.push([
      new Date(hist[i].ts).toISOString(),
      hist[i].value,
      m.unit || '',
      cons
    ].join(sep));
  }
  const blob = new Blob(['\\uFEFF' + rows.join(String.fromCharCode(10))], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (m.house + '_' + m.apartment + '_' + m.meter + '.csv').replace(/[^a-zA-Z0-9_.\-]/g, '_');
  a.click();
  URL.revokeObjectURL(a.href);
}

function destroyCharts() {
  if (chartInstLine) { chartInstLine.destroy(); chartInstLine = null; }
  if (chartInstBar)  { chartInstBar.destroy();  chartInstBar = null; }
}

function initChartTheme() {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.color = '#9585BB';
  Chart.defaults.borderColor = 'rgba(42,32,80,.8)';
  Chart.defaults.font.family = "'Segoe UI',system-ui,sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.plugins.legend.display = true;
  Chart.defaults.plugins.legend.labels.boxWidth = 12;
  Chart.defaults.elements.point.radius = 3;
  Chart.defaults.elements.point.hoverRadius = 5;
  Chart.defaults.elements.line.borderWidth = 2;
  Chart.defaults.elements.line.tension = 0.2;
}

function renderMeterCharts() {
  destroyCharts();
  const m = dataCacheList[chartCtxIdx];
  const overlay = document.getElementById('chart-overlay');
  const kpiEl = document.getElementById('chart-kpi');
  if (!m || !overlay) return;

  const allHist = (m.history || []).slice().sort((a, b) => a.ts - b.ts);
  const hist = filterHistoryByMonths(allHist, chartRangeMonths);

  if (typeof Chart === 'undefined') {
    kpiEl.style.display = 'block';
    kpiEl.textContent = 'Chart.js not loaded';
    return;
  }
  initChartTheme();

  const delta = calcDelta(allHist);
  const yearlyEl = document.getElementById('chart-kpi-yearly');
  const yearlyBtn = document.getElementById('chart-yearly-toggle');
  if (yearlyBtn) yearlyBtn.classList.toggle('active', chartShowYearly);

  if (delta) {
    kpiEl.style.display = 'block';
    kpiEl.textContent = '\uD83D\uDCCA +' + fmtNum(delta.delta) + ' ' + (m.unit || '') +
      ' ' + t('since_last') + ' (' + delta.days + ' ' + t('days') + ')';
  } else {
    kpiEl.style.display = 'none';
  }

  const projection = chartShowYearly ? calcYearlyProjection(hist) : null;
  if (projection && yearlyEl) {
    yearlyEl.style.display = 'block';
    yearlyEl.textContent = '\u2197 \u2248 ' + fmtNum(projection.yearly) + ' ' + (m.unit || '') +
      t('chart_per_year') + ' (' + t('chart_yearly_proj') + ': ' +
      t('chart_yearly_hint', {
        days: projection.days,
        daysLabel: t('days'),
        delta: fmtNum(projection.delta),
        unit: m.unit || ''
      }) + ')';
  } else if (yearlyEl) {
    yearlyEl.style.display = 'none';
  }

  if (hist.length < 2) {
    destroyCharts();
    return;
  }

  const lineData = hist.map(h => ({ x: h.ts, y: h.value }));
  const unit = m.unit || '';
  const readingLabel = t('chart_readings') + (unit ? ' (' + unit + ')' : '');

  chartInstLine = new Chart(document.getElementById('chart-line'), {
    type: 'line',
    data: {
      datasets: [{
        label: readingLabel,
        data: lineData,
        borderColor: '#7B54C4',
        backgroundColor: 'rgba(123,84,196,.15)',
        fill: true
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#C8B8FF' } },
        tooltip: {
          callbacks: {
            title: items => (items.length ? fmtDt(items[0].parsed.x) : ''),
            label: item => readingLabel + ': ' + fmtNum(item.parsed.y)
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          ticks: {
            maxTicksLimit: 8,
            maxRotation: 45,
            color: '#9585BB',
            callback: val => fmtDt(val)
          },
          grid: { color: 'rgba(42,32,80,.5)' }
        },
        y: { ticks: { color: '#9585BB' }, grid: { color: 'rgba(42,32,80,.5)' } }
      }
    }
  });

  const monthly = calcMonthlyConsumption(hist);
  const monthKeys = Object.keys(monthly).sort();
  const barDatasets = [{
    label: t('chart_monthly') + (unit ? ' (' + unit + ')' : ''),
    data: monthKeys.map(k => monthly[k]),
    backgroundColor: 'rgba(76,175,80,.55)',
    borderColor: '#4CAF50',
    borderWidth: 1
  }];
  if (projection) {
    const monthlyAvg = projection.yearly / 12;
    barDatasets.push({
      label: '\u00D8 ' + fmtNum(monthlyAvg) + ' ' + (unit || '') + ' (' + t('chart_yearly_proj') + ')',
      type: 'line',
      data: monthKeys.map(() => monthlyAvg),
      borderColor: '#C8B8FF',
      backgroundColor: 'transparent',
      borderWidth: 2,
      borderDash: [6, 4],
      pointRadius: 0,
      fill: false,
      order: 0
    });
  }
  chartInstBar = new Chart(document.getElementById('chart-bar'), {
    type: 'bar',
    data: {
      labels: monthKeys,
      datasets: barDatasets
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#C8B8FF' } } },
      scales: {
        x: { ticks: { color: '#9585BB' }, grid: { display: false } },
        y: { ticks: { color: '#9585BB' }, grid: { color: 'rgba(42,32,80,.5)' } }
      }
    }
  });
}

function openChartModal(idx) {
  const m = dataCacheList[idx];
  if (!m) return;
  chartCtxIdx = idx;
  chartRangeMonths = 0;
  document.querySelectorAll('.chart-range[data-months]').forEach(b => {
    b.classList.toggle('active', b.dataset.months === '0');
  });
  document.getElementById('chart-title').textContent = m.meter;
  document.getElementById('chart-sub').textContent = m.house + ' \u203A ' + m.apartment +
    (m.typeName ? ' \u00B7 ' + m.typeName : '');
  document.getElementById('chart-overlay').style.display = 'flex';
  renderMeterCharts();
}

function closeChartModal() {
  document.getElementById('chart-overlay').style.display = 'none';
  destroyCharts();
  chartCtxIdx = -1;
}

function openPrintWindow(title, bodyHtml) {
  const w = window.open('', '_blank', 'noopener,noreferrer');
  if (!w) {
    window.alert(t('error'));
    return;
  }
  const generated = new Date().toLocaleString(localeTag(), { hour12: false });
  w.document.write(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>'+esc(title)+'</title>'+
    '<style>'+
    'body{font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#111;margin:24px;}'+
    'h1{font-size:1.25rem;margin:0 0 4px}h2{font-size:1rem;color:#444;font-weight:600;margin:0 0 16px}'+
    '.meta{font-size:.85rem;color:#666;margin-bottom:18px}'+
    'table{width:100%;border-collapse:collapse;font-size:.95rem}'+
    'th,td{border-bottom:1px solid #ddd;padding:8px 6px;text-align:left}'+
    'th{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:#555}'+
    'td.num{text-align:right;font-variant-numeric:tabular-nums}'+
    'img{max-width:100%;height:auto;margin:12px 0;border:1px solid #eee}'+
    '@media print{body{margin:12mm}button{display:none}}'+
    '</style></head><body>'+
    '<h1>'+esc(title)+'</h1>'+
    '<div class="meta">'+esc(t('print_generated'))+': '+esc(generated)+'</div>'+
    bodyHtml+
    '<script>window.onload=function(){window.focus();window.print();}<\\/script>'+
    '</body></html>'
  );
  w.document.close();
}

window.printChartView = function printChartView() {
  if (chartCtxIdx < 0) return;
  const m = dataCacheList[chartCtxIdx];
  if (!m) return;
  const line = document.getElementById('chart-line');
  const bar  = document.getElementById('chart-bar');
  const kpi  = document.getElementById('chart-kpi');
  const kpiY = document.getElementById('chart-kpi-yearly');
  let html = '<h2>'+esc(m.house + ' \u203A ' + m.apartment)+
    (m.typeName ? ' \u00B7 ' + esc(m.typeName) : '')+'</h2>';
  if (kpi && kpi.style.display !== 'none' && kpi.textContent.trim()) {
    html += '<p>'+esc(kpi.textContent.trim())+'</p>';
  }
  if (kpiY && kpiY.style.display !== 'none' && kpiY.textContent.trim()) {
    html += '<p>'+esc(kpiY.textContent.trim())+'</p>';
  }
  if (line) html += '<img alt="'+esc(t('chart_readings'))+'" src="'+line.toDataURL('image/png')+'">';
  if (bar && bar.offsetParent !== null) {
    html += '<img alt="'+esc(t('chart_monthly'))+'" src="'+bar.toDataURL('image/png')+'">';
  }
  openPrintWindow(m.meter + ' \u2013 ' + t('print_chart'), html);
};

window.printScopeReadings = function printScopeReadings(house, apartment) {
  const rows = dataCacheList.filter(m =>
    m.house === house && (!apartment || m.apartment === apartment)
  );
  if (!rows.length) return;
  const title = apartment
    ? (house + ' \u203A ' + apartment)
    : house;
  let html = '<h2>'+esc(t('print_latest_title'))+'</h2>';
  html += '<table><thead><tr>'+
    (apartment ? '' : '<th>'+esc(t('prev_apts'))+'</th>')+
    '<th>'+esc(t('print_meter'))+'</th>'+
    '<th>'+esc(t('print_value'))+'</th>'+
    '<th>'+esc(t('print_unit'))+'</th>'+
    '<th>'+esc(t('print_date'))+'</th>'+
    '</tr></thead><tbody>';
  for (const m of rows) {
    const dt = m.latestDate ? fmtDt(new Date(m.latestDate).getTime()) : '\u2013';
    html += '<tr>'+
      (apartment ? '' : '<td>'+esc(m.apartment)+'</td>')+
      '<td>'+esc(m.meter)+(m.typeName ? ' <span style="color:#777">('+esc(m.typeName)+')</span>' : '')+'</td>'+
      '<td class="num">'+(m.latest !== undefined && m.latest !== null ? esc(String(m.latest)) : '\u2013')+'</td>'+
      '<td>'+esc(m.unit || '')+'</td>'+
      '<td>'+esc(dt)+'</td>'+
      '</tr>';
  }
  html += '</tbody></table>';
  openPrintWindow(title, html);
};

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
const fmtDt  = ts => new Date(ts).toLocaleString(localeTag(),{hour12:false});
const fmtUp  = s  => Math.floor(s/3600)+'h '+Math.floor(s%3600/60)+'m '+Math.floor(s%60)+'s';
const fmtLog = ts => {
  const d = new Date(ts);
  return d.toLocaleTimeString(localeTag(),{hour12:false})+'.'+String(d.getMilliseconds()).padStart(3,'0');
};
const fmtAgo = ts => {
  if (!ts) return '\u2013';
  const s = Math.floor((Date.now()-ts)/1000);
  if (s < 5)    return t('ago_just');
  if (s < 60)   return t('ago_sec', { s: String(s) });
  if (s < 3600) return t('ago_min', { m: String(Math.floor(s/60)) });
  return new Date(ts).toLocaleString(localeTag(),{hour12:false});
};

// \u2500\u2500 Stats \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function fetchStats() {
  try {
    const d = await fetch('/api/stats').then(r => r.json());
    document.getElementById('st-rx').textContent    = d.readingsReceived;
    document.getElementById('st-nodes').textContent = d.onlineCount+'/'+d.nodeCount;
    document.getElementById('st-up').textContent    = fmtUp(d.uptime);
    document.getElementById('st-live').textContent  = '\u25CF ' + t('live');
    document.getElementById('st-live').style.color  = 'var(--accent)';
  } catch {
    document.getElementById('st-live').textContent = '\u2717 ' + t('disconnected');
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
let nodesCacheForData = [];
let dataNamespace = '';

function meterStateId(house, apt, meter) {
  return dataNamespace ? (dataNamespace + '.' + house + '.' + apt + '.' + meter + '.readings.latest') : '';
}

function nodeSid(n) {
  try { return JSON.parse(n.config || '{}').sid || ''; } catch { return ''; }
}

function buildNodeChipsHtml(stateId, unit, label) {
  if (!nodesCacheForData.length) return '';
  const chips = nodesCacheForData.map(n => {
    const sid = nodeSid(n);
    const active = sid && stateId && sid === stateId;
    const name = n.name || n.mac;
    const cls = 'node-chip' + (active ? ' active' : '') + (n.online ? '' : ' offline');
    const title = active ? t('node_unassign') : t('node_assign');
    return '<button type="button" class="'+cls+'" data-mac="'+esc(n.mac)+'" data-sid="'+esc(stateId)+'" data-unit="'+esc(unit||'')+'" data-label="'+esc(label||'')+'" data-active="'+(active?'1':'0')+'" title="'+esc(title)+'"><span class="dot"></span>'+esc(name)+'</button>';
  }).join('');
  return '<div class="mc-nodes"><span class="mc-nodes-label">'+esc(t('node_label'))+'</span>'+chips+'</div>';
}

async function fetchData() {
  try {
    const [d, nodes] = await Promise.all([
      fetch('/api/data').then(r => r.json()),
      fetch('/api/nodes').then(r => r.json()).catch(() => [])
    ]);
    nodesCacheForData = Array.isArray(nodes) ? nodes : [];
    dataNamespace = d.namespace || '';
    const con = document.getElementById('data-container');
    dataCacheList = [];
    if (!d.data || !Object.keys(d.data).length) {
      con.innerHTML = '<div class="empty-state"><div class="ico">\uD83D\uDCE1</div><p>' + t('no_data') + '</p></div>';
      return;
    }
    let html = '';
    let idx = 0;
    for (const [house, apts] of Object.entries(d.data)) {
      html += '<div class="house-block"><div class="house-title"><span>\uD83C\uDFE0 '+esc(house)+'</span>'+
        '<button type="button" class="print-scope-btn" data-print-house="'+esc(house)+'" title="'+esc(t('print_house'))+'">\uD83D\uDDA8</button></div>';
      for (const [apt, meters] of Object.entries(apts)) {
        html += '<div class="apt-block"><div class="apt-title"><span>\uD83C\uDFD8 '+esc(apt)+'</span>'+
          '<button type="button" class="print-scope-btn" data-print-house="'+esc(house)+'" data-print-apt="'+esc(apt)+'" title="'+esc(t('print_apartment'))+'">\uD83D\uDDA8</button></div><div class="meters-grid">';
        for (const [key, m] of Object.entries(meters)) {
          const cacheIdx = idx++;
          dataCacheList.push({ house, apartment: apt, meter: key, unit: m.unit, typeName: m.typeName, latest: m.latest, latestDate: m.latestDate, history: m.history || [] });
          const icon   = TYPE_ICONS[m.typeName] || '\uD83D\uDCDF';
          const histId = 'h-'+CSS.escape(house+apt+key);
          const hist   = m.history || [];
          const delta  = calcDelta(hist);
          const sid    = meterStateId(house, apt, key);
          const assignedHere = nodesCacheForData.some(n => nodeSid(n) === sid);
          const rows   = hist.slice().reverse().map(h =>
            '<div class="hist-row">'+
              '<span>'+esc(fmtDt(h.ts))+'</span>'+
              '<span style="display:flex;align-items:center;gap:8px;">'+
                '<span class="hist-val">'+h.value+' '+esc(m.unit||'')+'</span>'+
                '<button type="button" class="hist-edit-btn" data-idx="'+cacheIdx+'" data-ts="'+h.ts+'" title="'+esc(t('history_edit'))+'">\u270E</button>'+
              '</span>'+
            '</div>'
          ).join('');
          const consumeHtml = delta
            ? '<div class="mc-consume">\uD83D\uDCCA +'+fmtNum(delta.delta)+' '+esc(m.unit||'')+' '+t('since_last')+' ('+delta.days+' '+t('days')+')</div>'
            : '';
          const actionsHtml = hist.length >= 1
            ? '<div class="mc-actions">'+
                (hist.length >= 2 ? '<button class="mc-chart-btn" data-idx="'+cacheIdx+'" title="'+esc(t('chart_btn'))+'">\uD83D\uDCC8 '+esc(t('chart_btn'))+'</button>' : '')+
                '<button class="mc-csv-btn" data-idx="'+cacheIdx+'" title="'+esc(t('csv_btn'))+'">\u2B07 '+esc(t('csv_btn'))+'</button>'+
              '</div>'
            : '';
          const nodesHtml = buildNodeChipsHtml(sid, m.unit, key);
          html +=
            '<div class="meter-card'+(assignedHere ? ' has-node' : '')+'">'+
              '<div class="mc-head">'+
                '<div class="mc-name">'+icon+' '+esc(key)+'</div>'+
                '<div class="mc-badge">'+esc(m.typeName||'?')+'</div>'+
              '</div>'+
              '<div class="mc-value-row">'+
                '<span class="mc-value">'+(m.latest !== undefined ? m.latest : '\u2013')+'</span>'+
                '<span class="mc-unit">'+esc(m.unit||'')+'</span>'+
              '</div>'+
              '<div class="mc-date">\uD83D\uDCC5 '+esc(m.latestDate ? fmtDt(new Date(m.latestDate).getTime()) : '\u2013')+'</div>'+
              consumeHtml+
              (rows
                ? '<button class="mc-hist-toggle" data-hist="'+histId+'">\uD83D\uDCC8 '+t('history')+' ('+hist.length+')</button>'+
                  '<div class="mc-history" id="'+histId+'">'+rows+'</div>'
                : '')+
              actionsHtml+
              nodesHtml+
            '</div>';
        }
        html += '</div></div>';
      }
      html += '</div>';
    }
    con.innerHTML = html;
  } catch(e) {
    document.getElementById('data-container').innerHTML =
      '<div class="empty-state"><div class="ico">\u26A0</div><p>'+t('error')+': '+esc(e.message)+'</p></div>';
  }
}

window.toggleNodeAssign = async function toggleNodeAssign(mac, sid, label, unit, currentlyActive) {
  const nextSid = currentlyActive ? '' : sid;
  try {
    const r = await authFetch('/api/nodes/'+encodeURIComponent(mac)+'/config', {
      method: 'POST',
      body: JSON.stringify({
        sid: nextSid,
        label: nextSid ? (label || '') : '',
        unit: nextSid ? (unit || '') : ''
      })
    });
    if (!r) return;
    const d = await r.json();
    if (!d.ok) {
      window.alert(t('error') + ': ' + (d.error || r.status));
      return;
    }
    await fetchData();
    if (typeof fetchNodes === 'function' && document.querySelector('.nav-item.active[data-tab="nodes"]')) {
      fetchNodes();
    }
  } catch (e) {
    window.alert(t('error') + ': ' + e.message);
  }
}

function toggleHist(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('open');
}

window.editHistoryValue = async function editHistoryValue(cacheIdx, ts) {
  const m = dataCacheList[cacheIdx];
  if (!m) return;
  const entry = (m.history || []).find(h => h.ts === ts);
  if (!entry) return;
  const raw = window.prompt(t('history_edit_prompt'), String(entry.value));
  if (raw === null) return;
  const normalized = String(raw).trim().replace(',', '.');
  const value = parseFloat(normalized);
  if (!Number.isFinite(value)) {
    window.alert(t('error') + ': value');
    return;
  }
  try {
    const r = await authFetch('/api/reading', {
      method: 'POST',
      body: JSON.stringify({
        house: m.house,
        apartment: m.apartment,
        meter: m.meter,
        value,
        unit: m.unit || '',
        typeName: m.typeName || '',
        readingDate: entry.readingDate
      })
    });
    if (!r) return;
    const d = await r.json();
    if (!d.ok) {
      window.alert(t('error') + ': ' + (d.error || r.status));
      return;
    }
    entry.value = value;
    if (m.history && m.history.length) {
      const newest = m.history.slice().sort((a, b) => a.ts - b.ts).pop();
      m.latest = newest.value;
      m.latestDate = newest.readingDate;
    }
    await fetchData();
  } catch (e) {
    window.alert(t('error') + ': ' + e.message);
  }
}
// \u2500\u2500 NODES-TAB \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
let discoverCache = [];

window.fetchNodes = async function fetchNodes() {
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
      con.innerHTML = '<div class="empty-state"><div class="ico">\uD83D\uDCE1</div><p>' + t('no_nodes') + '</p></div>';
      return;
    }
    const buildOptions = (currentSid) => {
      let opts = '<option value="">' + esc(t('no_meter')) + '</option>';
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
    html += th(t('th_status'))+th(t('th_name'))+th(t('th_ip'))+th(t('th_fw'))+th(t('th_last_seen'))+th(t('th_assign'))+th(t('th_led'));
    html += '</tr></thead><tbody>';
    for (const n of nodes) {
      let currentSid = '';
      try { currentSid = JSON.parse(n.config||'{}').sid || ''; } catch {}
      const onBadge  = '<span style="display:inline-flex;align-items:center;gap:5px;font-size:.8em;font-weight:700;padding:2px 9px;border-radius:20px;background:rgba(76,175,80,.15);color:#A5D6A7;border:1px solid rgba(76,175,80,.3);"><span style="width:7px;height:7px;border-radius:50%;background:var(--accent);display:inline-block;box-shadow:0 0 4px var(--accent);"></span>'+esc(t('node_online'))+'</span>';
      const offBadge = '<span style="display:inline-flex;align-items:center;gap:5px;font-size:.8em;font-weight:700;padding:2px 9px;border-radius:20px;background:rgba(244,67,54,.12);color:#EF9A9A;border:1px solid rgba(244,67,54,.3);"><span style="width:7px;height:7px;border-radius:50%;background:var(--danger);display:inline-block;"></span>'+esc(t('node_offline'))+'</span>';
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
      html += td('<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><select id="sel-'+esc(n.mac)+'" style="background:var(--bg-surface2);border:1px solid var(--border-light);color:var(--text);padding:6px 10px;border-radius:7px;font-size:.82em;max-width:300px;min-width:180px;outline:none;">'+buildOptions(currentSid)+'</select><button  id="sbtn-'+esc(n.mac)+'" style="background:var(--primary);color:#fff;border:none;padding:6px 14px;border-radius:7px;cursor:pointer;font-size:.82em;font-weight:600;white-space:nowrap;">\uD83D\uDCBE '+esc(t('save'))+'</button><span id="smsg-'+esc(n.mac)+'"></span></div>'+ackHint);
      // LED column
      html += td('<div style="display:flex;flex-direction:column;gap:5px;align-items:center;">'
        +'<button class="ledBtn" data-mac="'+esc(n.mac)+'" data-led="1" title="'+esc(t('led_on_title'))+'" style="background:rgba(239,68,68,.2);color:#F87171;border:1px solid rgba(239,68,68,.4);padding:4px 10px;border-radius:6px;cursor:pointer;font-size:.8em;white-space:nowrap;">\uD83D\uDD34 '+esc(t('led_on'))+'</button>'
        +'<button class="ledBtn" data-mac="'+esc(n.mac)+'" data-led="0" title="'+esc(t('led_off_title'))+'" style="background:var(--bg-surface2);color:var(--text-dim);border:1px solid var(--border);padding:4px 10px;border-radius:6px;cursor:pointer;font-size:.8em;white-space:nowrap;">\u26AB '+esc(t('led_off'))+'</button>'
        +'<span id="ledmsg-'+esc(n.mac)+'" style="font-size:.75em;min-height:14px;"></span>'
        +'</div>');
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    con.innerHTML = html;
  } catch(e) {
    con.innerHTML = '<div class="empty-state"><div class="ico">\u26A0</div><p>'+t('error')+': '+esc(e.message)+'</p></div>';
  }
}

window.saveNodeConfig = async function saveNodeConfig(mac) {
  const sel = document.getElementById('sel-'+mac);
  const btn = document.getElementById('sbtn-'+mac);
  const msg = document.getElementById('smsg-'+mac);
  if (!sel || !btn || !msg) return;
  const stateId = sel.value;
  const meter   = discoverCache.find(m => m.stateId === stateId);
  btn.disabled = true; msg.textContent = '';
  try {
    const r = await authFetch('/api/nodes/'+encodeURIComponent(mac)+'/config', {
      method: 'POST',
      body: JSON.stringify({ sid: stateId, label: meter ? meter.label : '', unit: meter ? meter.unit : '' })
    });
    if (!r) { btn.disabled = false; return; }
    const d = await r.json();
    if (d.ok) {
      msg.innerHTML = '<span style="color:var(--accent);font-size:.82em;">\u2713 '+esc(t('saved'))+'</span>';
      window.setTimeout(() => { msg.textContent = ''; }, 3000);
    } else {
      msg.innerHTML = '<span style="color:var(--danger);font-size:.82em;">\u2717 '+esc(d.error||t('error'))+'</span>';
    }
  } catch(e) {
    msg.innerHTML = '<span style="color:var(--danger);font-size:.82em;">\u2717 '+esc(e.message)+'</span>';
  } finally {
    btn.disabled = false;
  }
}

window.sendNodeCmd = async function sendNodeCmd(mac, cmd) {
  const msgEl = document.getElementById('ledmsg-'+mac);
  if (msgEl) msgEl.textContent = '…';
  try {
    const r = await fetch('/api/nodes/'+encodeURIComponent(mac)+'/cmd', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(cmd)
    });
    const d = await r.json();
    if (msgEl) {
      msgEl.innerHTML = d.ok
        ? '<span style="color:var(--accent);">✓</span>'
        : '<span style="color:var(--danger);">✗</span>';
      window.setTimeout(() => { if (msgEl) msgEl.textContent = ''; }, 3000);
    }
  } catch(e) {
    if (msgEl) msgEl.innerHTML = '<span style="color:var(--danger);">✗</span>';
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
    catch { showResult('err', '\u274C ' + t('invalid_json')); }
  };
  r.readAsText(file);
}

function showPreview(d, fname) {
  const valid = !!(d.Apartments && d.Meters && d.Readings);
  document.getElementById('preview-content').innerHTML =
    prow(t('prev_file'),      esc(fname)) +
    prow(t('prev_schema'),     d.SchemaVersion||'?') +
    prow(t('prev_apts'),  (d.Apartments||[]).length) +
    prow(t('prev_meters'),     (d.Meters||[]).length) +
    prow(t('prev_readings'), (d.Readings||[]).length) +
    prow(t('prev_compat'), valid ? '\u2705 ' + t('prev_yes') : '\u274C ' + t('prev_no'));
  document.getElementById('preview-box').style.display = 'block';
  document.getElementById('imp-btn').disabled = !valid;
}
const prow = (l,v) => '<div class="preview-row"><span>'+l+'</span><b>'+v+'</b></div>';

window.doImport = async function doImport() {
  if (!importData) return;
  const house = document.getElementById('imp-house').value.trim() || 'MyHouse';
  const btn   = document.getElementById('imp-btn');
  btn.disabled = true; btn.textContent = '\u23F3 ' + t('import_importing');
  try {
    const r = await authFetch('/api/import', {
      method: 'POST',
      body: JSON.stringify({...importData, HouseName: house})
    });
    if (!r) { btn.disabled = false; btn.textContent = '\u2B06 ' + t('import_btn'); return; }
    const d = await r.json();
    if (d.ok) { showResult('ok',   '\u2705 '+d.summary); fetchData(); fetchStats(); }
    else       { showResult('warn','\u26A0 '+d.summary+(d.errors.length ? '<br>'+d.errors.slice(0,5).map(esc).join('<br>') : '')); }
  } catch(e) { showResult('err', '\u274C ' + t('network_err') + ': '+esc(e.message)); }
  finally { btn.disabled = false; btn.textContent = '\u2B06 ' + t('import_btn'); }
}
function showResult(type, msg) {
  const rb = document.getElementById('imp-result');
  rb.className = 'result-box '+type; rb.innerHTML = msg; rb.style.display = 'block';
}
window.clearImport = function clearImport() {
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
      d.entries.forEach(e => { const el = renderLog(e,true); if(el) c.insertBefore(el, c.firstChild); displayed.unshift(e); });
      newestTs = d.newest;
      const rows = c.querySelectorAll('.le');
      if (rows.length > 1000) for (let i=0;i<rows.length-1000;i++) rows[i].remove();
      if (document.getElementById('as').checked && atB) scrollLogBottom();
      else if (!atB) document.getElementById('ni').style.display = 'block';
    }
    document.getElementById('st-lg').textContent = d.total;
  } catch {}
}

window.scrollLogBottom = function scrollLogBottom() {
  const c = lc(); c.scrollTop = c.scrollHeight;
  document.getElementById('ni').style.display = 'none';
}
window.clearLogs = function clearLogs() {
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
window.exportLogs = function exportLogs() {
  const f = gf();
  const txt = displayed.filter(e=>matchLog(e,f))
    .map(e=>'['+new Date(e.ts).toISOString()+'] ['+e.level.toUpperCase()+'] ['+e.category+'] '+e.message+(e.detail?' \\u2014 '+e.detail:'')).join(String.fromCharCode(10));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([txt],{type:'text/plain'}));
  a.download = 'metermaster-log-'+new Date().toISOString().slice(0,19)+'.txt';
  a.click();
}
// Log-Filter EventListener \u2192 werden in initLogFilters() gesetzt

function startLive() {
  window.clearInterval(logTimer);
  logTimer = window.setInterval(async () => { await fetchLogs(); await fetchStats(); }, 3000);
}


// \u2500\u2500 SYSTEM-TAB \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function checkVersion() {
  const btn   = document.getElementById('sv-check-btn');
  const spin  = document.getElementById('sv-spin');
  btn.disabled = true; spin.style.display = 'inline';
  try {
    const d = await fetch('/api/version').then(r => r.json());
    document.getElementById('sv-cur').textContent = d.current || '\u2013';
    document.getElementById('sv-lat').textContent = d.latest  || (d.error ? '(' + t('error') + ')' : t('sys_no_release'));
    const st = document.getElementById('sv-status');
    if (d.error) {
      st.innerHTML = '<span class="badge-err">\u26A0 ' + t('sys_github_err') + '</span>';
    } else if (!d.latest) {
      st.innerHTML = '<span class="badge-warn">\u2139 ' + t('sys_no_github_release') + '</span>';
    } else if (d.updateAvailable) {
      st.innerHTML = '<span class="badge-new">\uD83C\uDD95 ' + t('sys_update_avail') + '</span>';
    } else {
      st.innerHTML = '<span class="badge-ok">\u2713 ' + t('sys_up_to_date') + '</span>';
    }
  } catch(e) {
    document.getElementById('sv-status').innerHTML = '<span class="badge-err">\u26A0 ' + t('sys_net_err') + '</span>';
  }
  btn.disabled = false; spin.style.display = 'none';
}

// \u2500\u2500 Init \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// ── Copy-to-Clipboard ─────────────────────────────────────────────────────────
window.copyCmd = function copyCmd(btn) {
  const cmd = btn.dataset.cmd;
  if (!cmd) return;
  navigator.clipboard.writeText(cmd).then(() => {
    btn.textContent = '\u2713';
    btn.classList.add('copied');
    window.setTimeout(() => { btn.textContent = '\uD83D\uDCCB'; btn.classList.remove('copied'); }, 1800);
  }).catch(() => {
    // Fallback für ältere Browser / HTTP-Kontext
    const ta = document.createElement('textarea');
    ta.value = cmd; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    btn.textContent = '\u2713'; btn.classList.add('copied');
    window.setTimeout(() => { btn.textContent = '\uD83D\uDCCB'; btn.classList.remove('copied'); }, 1800);
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

  // History toggle via event delegation
  document.addEventListener('click', e => {
    const btn = e.target.closest('.mc-hist-toggle');
    if (btn && btn.dataset.hist) toggleHist(btn.dataset.hist);
  });

  // History value edit
  document.addEventListener('click', e => {
    const editBtn = e.target.closest('.hist-edit-btn');
    if (!editBtn) return;
    const idx = parseInt(editBtn.dataset.idx, 10);
    const ts  = parseInt(editBtn.dataset.ts, 10);
    editHistoryValue(idx, ts);
  });

  // Node chips on meter cards: assign / unassign
  document.addEventListener('click', e => {
    const chip = e.target.closest('.node-chip');
    if (!chip) return;
    toggleNodeAssign(
      chip.dataset.mac,
      chip.dataset.sid,
      chip.dataset.label || '',
      chip.dataset.unit || '',
      chip.dataset.active === '1'
    );
  });

  // Chart + CSV + Chart-Modal via Event Delegation
  document.addEventListener('click', e => {
    const chartBtn = e.target.closest('.mc-chart-btn');
    if (chartBtn) { openChartModal(parseInt(chartBtn.dataset.idx, 10)); return; }
    const csvBtn = e.target.closest('.mc-csv-btn');
    if (csvBtn) { exportMeterCsv(parseInt(csvBtn.dataset.idx, 10)); return; }
    if (e.target.closest('.chart-close')) { closeChartModal(); return; }
    if (e.target.id === 'chart-overlay') { closeChartModal(); return; }
    if (e.target.closest('#chart-csv-btn')) { if (chartCtxIdx >= 0) exportMeterCsv(chartCtxIdx); return; }
    if (e.target.closest('#chart-print-btn')) { printChartView(); return; }
    const scopeBtn = e.target.closest('.print-scope-btn');
    if (scopeBtn) {
      printScopeReadings(scopeBtn.dataset.printHouse, scopeBtn.dataset.printApt || null);
      return;
    }
    const rangeBtn = e.target.closest('.chart-range[data-months]');
    if (rangeBtn) {
      chartRangeMonths = parseInt(rangeBtn.dataset.months, 10) || 0;
      document.querySelectorAll('.chart-range[data-months]').forEach(b => b.classList.toggle('active', b === rangeBtn));
      renderMeterCharts();
      return;
    }
    const yearlyBtn = e.target.closest('#chart-yearly-toggle');
    if (yearlyBtn) {
      chartShowYearly = !chartShowYearly;
      try { localStorage.setItem('mm-chart-yearly', chartShowYearly ? '1' : '0'); } catch {}
      renderMeterCharts();
    }
  });

  // Sprache
  const langSel = document.getElementById('lang-select');
  if (langSel) langSel.addEventListener('change', e => setLang(e.target.value));

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeChartModal();
  });

  // Nodes-Speichern via Event Delegation (kein onclick-Attribut mit Escaping-Problemen)
  document.addEventListener('click', e => {
    const btn2 = e.target.closest('[id^="sbtn-"]');
    if (btn2) saveNodeConfig(btn2.id.slice(5));
  });

  // LED-Buttons via Event Delegation (kein onclick-Attribut)
  document.addEventListener('click', e => {
    const btn = e.target.closest('.ledBtn');
    if (!btn) return;
    window.sendNodeCmd(btn.dataset.mac, { ledOn: btn.dataset.led === '1' });
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
  if (ar) ar.addEventListener('change', e => { if(e.target.checked) startLive(); else window.clearInterval(logTimer); });
}

async function init() {
  initTabs();
  applyI18n();
  try {
    const d = await fetch('/api/logs?limit=500').then(r => r.json());
    if (d.entries.length > 0) {
      document.getElementById('log-empty').style.display = 'none';
      d.entries.slice().reverse().forEach(e => { const el = renderLog(e,false); if(el) lc().appendChild(el); });
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

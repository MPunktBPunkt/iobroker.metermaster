'use strict';

/**
 * Generates metermaster.0.json for ioBroker repository review.
 */

const os = require('node:os');
const path = require('path');
const http = require('node:http');
const fs = require('node:fs');
const { getAdapterName, getAppName } = require('@iobroker/testing/build/lib/adapterTools');
const { ControllerSetup } = require('@iobroker/testing/build/tests/integration/lib/controllerSetup');
const { AdapterSetup } = require('@iobroker/testing/build/tests/integration/lib/adapterSetup');
const { DBConnection } = require('@iobroker/testing/build/tests/integration/lib/dbConnection');
const { TestHarness } = require('@iobroker/testing/build/tests/integration/lib/harness');
const { createLogger } = require('@iobroker/testing/build/tests/integration/lib/logger');

const ADAPTER_DIR = path.join(__dirname, '..');
const APP_NAME = getAppName(ADAPTER_DIR);
const ADAPTER_NAME = getAdapterName(ADAPTER_DIR);
const TEST_DIR = path.join(os.tmpdir(), `test-${APP_NAME}.${ADAPTER_NAME}`);
const OUT_FILE = path.join(ADAPTER_DIR, 'metermaster.0.json');

function httpPost(port, urlPath, body, auth) {
    return new Promise((resolve, reject) => {
        const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
        if (auth) headers.Authorization = auth;
        const req = http.request(
            { hostname: '127.0.0.1', port, path: urlPath, method: 'POST', headers },
            (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => resolve({ status: res.statusCode, body: data }));
            }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function setupEnvironment() {
    const controllerSetup = new ControllerSetup(ADAPTER_DIR, TEST_DIR);
    const adapterSetup = new AdapterSetup(ADAPTER_DIR, TEST_DIR);
    const logger = createLogger('info');

    if (await controllerSetup.isJsControllerRunning()) {
        throw new Error('JS-Controller already running');
    }

    await controllerSetup.prepareTestDir('6.0.11');
    await adapterSetup.installAdapterInTestDir();

    const dbConnection = new DBConnection(APP_NAME, TEST_DIR, logger);
    await dbConnection.start();
    controllerSetup.setupSystemConfig(dbConnection);
    await controllerSetup.disableAdminInstances(dbConnection);
    await adapterSetup.deleteOldInstances(dbConnection);
    await adapterSetup.addAdapterInstance();
    await dbConnection.stop();

    return { dbConnection, logger };
}

async function main() {
    const instanceId = `${ADAPTER_NAME}.0`;
    const { dbConnection, logger } = await setupEnvironment();
    const harness = new TestHarness(ADAPTER_DIR, TEST_DIR, dbConnection);

    await dbConnection.start();
    await harness.changeAdapterConfig(ADAPTER_NAME, {
        common: { enabled: true, loglevel: 'info' },
        native: { user: '', password: '' },
    });
    await harness.enableSendTo();

    const started = new Promise((resolve, reject) => {
        harness.on('stateChange', async (id, state) => {
            if (id === `system.adapter.${instanceId}.alive` && state?.val === true) {
                await wait(1500);
                resolve();
            }
        });
        harness.on('failed', (code) => reject(new Error(`Adapter failed: ${code}`)));
        void harness.startAdapter();
    });

    try {
        await started;

        const cfg = await harness.objects.getObjectAsync(`system.adapter.${instanceId}`);
        const port = cfg?.native?.port || 8089;
        const user = (cfg?.native?.user || '').trim();
        const password = (cfg?.native?.password || '').trim();
        const auth = user && password
            ? 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64')
            : null;

        const reading = {
            house: 'SampleHouse',
            apartment: 'West',
            meter: 'HotWater',
            value: 128.75,
            unit: 'm³',
            typeName: 'HotWater',
            readingDate: '2024-02-12T09:30:00.000Z',
        };

        const readingRes = await httpPost(port, '/api/reading', JSON.stringify(reading), auth);
        if (readingRes.status !== 200) {
            throw new Error(`POST /api/reading failed: ${readingRes.status} ${readingRes.body}`);
        }

        const regRes = await httpPost(port, '/api/register', JSON.stringify({
            mac: 'C8C9A3CB7B08',
            ip: '192.168.178.110',
            name: 'MeterMaster Node',
            version: '2.8.1',
        }));
        if (regRes.status !== 200) {
            throw new Error(`POST /api/register failed: ${regRes.status} ${regRes.body}`);
        }

        await wait(500);

        const dump = {};
        const now = Date.now();
        const types = ['channel', 'state'];

        for (const type of types) {
            const view = await harness.objects.getObjectViewAsync('system', type, {
                startkey: instanceId,
                endkey: `${instanceId}\uFFFF`,
            });

            for (const row of view.rows || []) {
                const obj = row.value;
                if (!obj?._id || !obj._id.startsWith(`${instanceId}.`)) continue;

                const entry = {
                    _id: obj._id,
                    type: obj.type,
                    common: obj.common,
                    native: obj.native || {},
                    from: obj.from || `system.adapter.${instanceId}`,
                    ts: obj.ts || now,
                };
                if (obj.acl) entry.acl = obj.acl;
                if (obj.user) entry.user = obj.user;

                if (obj.type === 'state') {
                    const st = await harness.states.getStateAsync(obj._id);
                    if (st) {
                        entry.val = st.val;
                        entry.ack = st.ack;
                        if (st.ts) entry.ts = st.ts;
                    }
                }

                dump[obj._id] = entry;
            }
        }

        fs.writeFileSync(OUT_FILE, JSON.stringify(dump, null, 2) + '\n');
        console.log(`Wrote ${Object.keys(dump).length} objects to ${OUT_FILE}`);
    } finally {
        await harness.stopAdapter();
        await dbConnection.stop();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

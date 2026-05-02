const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3001;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

// ── Keep-Alive Endpoint ──────────────────────────────────────────────────────
app.get('/api/ping', (req, res) => res.json({ status: 'alive', time: new Date().toISOString() }));

// ── Persistent Local Database ────────────────────────────────────────────────
const dbPath = path.join(__dirname, 'db.json');
if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify({ charts: [], setlists: [] }));
}

function getDB() { return JSON.parse(fs.readFileSync(dbPath, 'utf-8')); }
function saveDB(data) { fs.writeFileSync(dbPath, JSON.stringify(data, null, 2)); }

// ── Chart API ────────────────────────────────────────────────────────────────
app.get('/api/charts', (req, res) => res.json(getDB().charts));

app.post('/api/charts', (req, res) => {
    const db = getDB();
    const incoming = req.body;
    if (incoming.id) {
        const idx = db.charts.findIndex(c => c.id === incoming.id);
        if (idx !== -1) {
            db.charts[idx] = { ...db.charts[idx], ...incoming, updatedAt: new Date().toISOString() };
            saveDB(db);
            return res.json(db.charts[idx]);
        }
    }
    const newChart = { id: Date.now().toString(), createdAt: new Date().toISOString(), ...incoming };
    db.charts.push(newChart);
    saveDB(db);
    res.json(newChart);
});

app.delete('/api/charts/:id', (req, res) => {
    const db = getDB();
    db.charts = db.charts.filter(c => c.id !== req.params.id);
    saveDB(db);
    res.json({ ok: true });
});

// ── Setlist API ──────────────────────────────────────────────────────────────
app.get('/api/setlists', (req, res) => res.json(getDB().setlists || []));

app.post('/api/setlists', (req, res) => {
    const db = getDB();
    if (!db.setlists) db.setlists = [];
    const incoming = req.body;
    if (incoming.id) {
        const idx = db.setlists.findIndex(s => s.id === incoming.id);
        if (idx !== -1) {
            db.setlists[idx] = { ...db.setlists[idx], ...incoming, updatedAt: new Date().toISOString() };
            saveDB(db);
            return res.json(db.setlists[idx]);
        }
    }
    const newSetlist = { id: 'sl_' + Date.now(), createdAt: new Date().toISOString(), items: [], ...incoming };
    db.setlists.push(newSetlist);
    saveDB(db);
    res.json(newSetlist);
});

app.delete('/api/setlists/:id', (req, res) => {
    const db = getDB();
    db.setlists = (db.setlists || []).filter(s => s.id !== req.params.id);
    saveDB(db);
    res.json({ ok: true });
});

// ── Socket.io Show Sync Engine ───────────────────────────────────────────────
let showState = {
    mode: 'stopped',         // 'stopped' | 'playing' | 'paused' | 'break' | 'filler'
    activeSetlistId: null,
    activeItemIndex: 0,      // index in setlist.items
    activeChartId: null,
    scrollPosition: 0,
    speed: 50,
    isPlaying: false,
    fillerUrl: null,
    fillerTitle: null,
    connectedViewers: 0,
};

let hostSocketId = null;

io.on('connection', (socket) => {
    showState.connectedViewers = io.engine.clientsCount;
    io.emit('viewerCount', showState.connectedViewers);
    socket.emit('syncState', showState);
    console.log(`[STAGE] Connected: ${socket.id} | Total: ${showState.connectedViewers}`);

    // ── Host takes control ──
    socket.on('becomeHost', () => {
        hostSocketId = socket.id;
        socket.emit('hostAck', true);
        console.log(`[STAGE] Host: ${socket.id}`);
    });

    // ── Chart change ──
    socket.on('hostChangeChart', ({ chartId, setlistId, itemIndex }) => {
        showState.activeChartId = chartId;
        showState.activeSetlistId = setlistId || null;
        showState.activeItemIndex = itemIndex ?? 0;
        showState.scrollPosition = 0;
        showState.isPlaying = false;
        io.emit('syncState', showState);
    });

    // ── Scroll sync ──
    socket.on('hostUpdateScroll', (pos) => {
        showState.scrollPosition = pos;
        socket.broadcast.emit('viewerUpdateScroll', pos);
    });

    // ── Play/pause ──
    socket.on('hostTogglePlayback', (isPlaying) => {
        showState.isPlaying = isPlaying;
        showState.mode = isPlaying ? 'playing' : 'paused';
        io.emit('syncState', showState);
    });

    // ── Speed ──
    socket.on('hostChangeSpeed', (speed) => {
        showState.speed = speed;
        io.emit('syncState', showState);
    });

    // ── Show advance (next/prev chart in setlist) ──
    socket.on('hostAdvanceShow', ({ chartId, itemIndex, mode }) => {
        showState.activeChartId = chartId;
        showState.activeItemIndex = itemIndex;
        showState.mode = mode || 'playing';
        showState.scrollPosition = 0;
        showState.isPlaying = false;
        io.emit('syncState', showState);
    });

    // ── Filler / break mode ──
    socket.on('hostStartFiller', ({ url, title, durationSec }) => {
        showState.mode = 'filler';
        showState.fillerUrl = url;
        showState.fillerTitle = title;
        showState.isPlaying = false;
        io.emit('syncState', showState);
        // Auto end filler after duration if set
        if (durationSec && durationSec > 0) {
            setTimeout(() => {
                if (showState.mode === 'filler') {
                    showState.mode = 'paused';
                    io.emit('syncState', showState);
                }
            }, durationSec * 1000);
        }
    });

    socket.on('hostEndFiller', () => {
        showState.mode = 'paused';
        showState.fillerUrl = null;
        io.emit('syncState', showState);
    });

    // ── Viewer prefs (stored per-socket, not broadcast) ──
    socket.on('saveViewerPrefs', (prefs) => {
        socket.viewerPrefs = prefs;
    });

    socket.on('disconnect', () => {
        showState.connectedViewers = Math.max(0, io.engine.clientsCount);
        io.emit('viewerCount', showState.connectedViewers);
        console.log(`[STAGE] Disconnected: ${socket.id} | Total: ${showState.connectedViewers}`);
    });
});

server.listen(PORT, () => {
    console.log(`\n🎸 STAGE by Rocket Tree Labs`);
    console.log(`   Running at: http://localhost:${PORT}`);
    console.log(`   Viewer URL: http://[YOUR-IP]:${PORT}?mode=viewer\n`);
});

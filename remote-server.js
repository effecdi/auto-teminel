// Remote Control API — Express + WebSocket server for external access
// Runs inside Electron main process, binds to 127.0.0.1 only

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const url = require('url');

const MAX_WS_CONNECTIONS = 10;
const MAX_TEXT_LENGTH = 50 * 1024; // 50KB
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_REQUESTS = 100;
const OUTPUT_BUFFER_MS = 50;

let server = null;
let wss = null;
let app = null;

// Rate limiter state
const rateLimiter = new Map(); // ip → { count, resetAt }

/**
 * Start the remote control server.
 * @param {Object} opts
 * @param {string}   opts.apiKey    - required API key
 * @param {number}   opts.port      - port to listen on (default 3100)
 * @param {Map}      opts.ptyPool   - the PTY pool from main process
 * @param {Object}   opts.taskQueue - TaskQueue instance
 * @param {Object}   opts.store     - electron-store instance
 * @param {Function} opts.spawnPtyForProject - spawn function
 * @param {Function} opts.destroyPty - kill function
 */
function startRemoteServer(opts) {
    const {
        apiKey,
        port = 3100,
        ptyPool,
        taskQueue,
        store,
        spawnPtyForProject,
        destroyPty
    } = opts;

    if (!apiKey) {
        console.log('[RemoteServer] No REMOTE_API_KEY set, remote server disabled.');
        return;
    }

    app = express();
    app.use(express.json({ limit: '50kb' }));

    // --- Auth middleware ---
    function authMiddleware(req, res, next) {
        const key = req.headers['x-api-key'];
        if (key !== apiKey) {
            return res.status(401).json({ error: 'Invalid API key' });
        }
        next();
    }

    // --- Rate limiter middleware ---
    function rateLimitMiddleware(req, res, next) {
        const ip = req.ip || req.connection.remoteAddress;
        const now = Date.now();
        let entry = rateLimiter.get(ip);
        if (!entry || now > entry.resetAt) {
            entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
            rateLimiter.set(ip, entry);
        }
        entry.count++;
        if (entry.count > RATE_MAX_REQUESTS) {
            return res.status(429).json({ error: 'Rate limit exceeded' });
        }
        next();
    }

    const router = express.Router();
    router.use(authMiddleware);
    router.use(rateLimitMiddleware);

    // --- GET /projects ---
    router.get('/projects', (req, res) => {
        const projects = store.get('projects', []);
        const result = projects.map(p => {
            const entry = ptyPool.get(p.id);
            return {
                id: p.id,
                name: p.name,
                path: p.path,
                terminalAlive: !!(entry && entry.alive)
            };
        });
        res.json({ projects: result });
    });

    // --- GET /projects/:id ---
    router.get('/projects/:id', (req, res) => {
        const projects = store.get('projects', []);
        const project = projects.find(p => p.id === req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        const entry = ptyPool.get(project.id);
        res.json({
            ...project,
            terminalAlive: !!(entry && entry.alive),
            pid: entry && entry.process ? entry.process.pid : null
        });
    });

    // --- POST /terminal/:id/spawn ---
    router.post('/terminal/:id/spawn', (req, res) => {
        const projectId = req.params.id;
        const projects = store.get('projects', []);
        const project = projects.find(p => p.id === projectId);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        const { cols, rows } = req.body || {};
        const result = spawnPtyForProject(
            projectId,
            project.path,
            project.claudeArgs || '',
            cols || 120,
            rows || 30
        );
        if (result.success) {
            res.json({ success: true, pid: result.pid, alreadyRunning: result.alreadyRunning });
        } else {
            res.status(500).json({ success: false, error: result.error });
        }
    });

    // --- POST /terminal/:id/write ---
    router.post('/terminal/:id/write', (req, res) => {
        const { text } = req.body || {};
        if (!text || typeof text !== 'string') {
            return res.status(400).json({ error: 'Missing text field' });
        }
        if (text.length > MAX_TEXT_LENGTH) {
            return res.status(400).json({ error: 'Text exceeds 50KB limit' });
        }
        const entry = ptyPool.get(req.params.id);
        if (!entry || !entry.alive || !entry.process) {
            return res.status(404).json({ error: 'Terminal not running' });
        }
        // Use bracketed paste mode
        const PASTE_START = '\x1b[200~';
        const PASTE_END   = '\x1b[201~';
        entry.process.write(PASTE_START + text + PASTE_END);
        setTimeout(() => {
            if (entry.alive && entry.process) {
                entry.process.write('\r');
            }
        }, 500);
        res.json({ success: true });
    });

    // --- POST /terminal/:id/kill ---
    router.post('/terminal/:id/kill', (req, res) => {
        destroyPty(req.params.id);
        res.json({ success: true });
    });

    // --- GET /terminals ---
    router.get('/terminals', (req, res) => {
        const terminals = [];
        for (const [projectId, entry] of ptyPool) {
            if (entry.alive) {
                terminals.push({
                    projectId,
                    pid: entry.process ? entry.process.pid : null,
                    projectPath: entry.projectPath
                });
            }
        }
        res.json({ terminals });
    });

    // --- GET /queue ---
    router.get('/queue', (req, res) => {
        res.json(taskQueue.getState());
    });

    // --- POST /queue/enqueue ---
    router.post('/queue/enqueue', (req, res) => {
        const { projectId, text } = req.body || {};
        if (!projectId || !text) {
            return res.status(400).json({ error: 'Missing projectId or text' });
        }
        if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) {
            return res.status(400).json({ error: 'Invalid or oversized text' });
        }
        const projects = store.get('projects', []);
        const project = projects.find(p => p.id === projectId);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        const task = taskQueue.enqueue(projectId, project.name, text);
        res.json({ success: true, task });
    });

    // --- DELETE /queue/task/:taskId ---
    router.delete('/queue/task/:taskId', (req, res) => {
        const taskId = parseInt(req.params.taskId, 10);
        const removed = taskQueue.remove(taskId);
        if (!removed) {
            return res.status(400).json({ error: 'Task not found or not pending' });
        }
        res.json({ success: true });
    });

    // --- POST /queue/pause ---
    router.post('/queue/pause', (req, res) => {
        taskQueue.pause();
        res.json({ success: true, paused: true });
    });

    // --- POST /queue/resume ---
    router.post('/queue/resume', (req, res) => {
        taskQueue.resume();
        res.json({ success: true, paused: false });
    });

    // --- POST /queue/clear ---
    router.post('/queue/clear', (req, res) => {
        taskQueue.clearAll();
        res.json({ success: true });
    });

    app.use('/api/v1', router);

    // --- HTTP Server ---
    server = http.createServer(app);

    // --- WebSocket Server ---
    wss = new WebSocketServer({
        server,
        path: '/ws',
        verifyClient: (info, cb) => {
            const parsed = url.parse(info.req.url, true);
            const key = parsed.query.apiKey;
            if (key !== apiKey) {
                cb(false, 401, 'Invalid API key');
                return;
            }
            // Connection limit
            if (wss.clients.size >= MAX_WS_CONNECTIONS) {
                cb(false, 503, 'Max connections reached');
                return;
            }
            cb(true);
        }
    });

    wss.on('connection', (ws) => {
        ws._subscriptions = new Set(); // projectIds
        ws._subscribeQueue = false;
        ws._outputBuffers = new Map(); // projectId → { data, timer }

        ws.on('message', (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw);
            } catch {
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
                return;
            }

            switch (msg.type) {
                case 'subscribe':
                    if (msg.payload && msg.payload.projectId) {
                        ws._subscriptions.add(msg.payload.projectId);
                        ws.send(JSON.stringify({ type: 'subscribed', projectId: msg.payload.projectId }));
                    }
                    break;
                case 'unsubscribe':
                    if (msg.payload && msg.payload.projectId) {
                        ws._subscriptions.delete(msg.payload.projectId);
                    } else {
                        ws._subscriptions.clear();
                    }
                    ws.send(JSON.stringify({ type: 'unsubscribed' }));
                    break;
                case 'subscribe_queue':
                    ws._subscribeQueue = true;
                    ws.send(JSON.stringify({ type: 'subscribed_queue' }));
                    break;
                case 'ping':
                    ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                    break;
                default:
                    ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
            }
        });

        ws.on('close', () => {
            // Clean up buffers
            if (ws._outputBuffers) {
                for (const buf of ws._outputBuffers.values()) {
                    if (buf.timer) clearTimeout(buf.timer);
                }
                ws._outputBuffers.clear();
            }
        });
    });

    server.listen(port, '127.0.0.1', () => {
        console.log(`[RemoteServer] Listening on http://127.0.0.1:${port}`);
        console.log(`[RemoteServer] REST: http://127.0.0.1:${port}/api/v1`);
        console.log(`[RemoteServer] WS:   ws://127.0.0.1:${port}/ws?apiKey=YOUR_KEY`);
    });

    server.on('error', (err) => {
        console.error('[RemoteServer] Server error:', err.message);
    });
}

/** Broadcast terminal output to subscribed WebSocket clients (buffered 50ms). */
function broadcastOutput(projectId, data) {
    if (!wss) return;
    for (const ws of wss.clients) {
        if (ws.readyState !== 1) continue; // WebSocket.OPEN = 1
        if (!ws._subscriptions || !ws._subscriptions.has(projectId)) continue;

        // Buffer output to avoid flooding
        if (!ws._outputBuffers) ws._outputBuffers = new Map();
        let buf = ws._outputBuffers.get(projectId);
        if (!buf) {
            buf = { data: '', timer: null };
            ws._outputBuffers.set(projectId, buf);
        }
        buf.data += data;

        if (!buf.timer) {
            buf.timer = setTimeout(() => {
                const payload = buf.data;
                buf.data = '';
                buf.timer = null;
                try {
                    ws.send(JSON.stringify({
                        type: 'terminal.output',
                        projectId,
                        data: payload,
                        timestamp: Date.now()
                    }));
                } catch (_) {}
            }, OUTPUT_BUFFER_MS);
        }
    }
}

/** Broadcast an event (terminal.exit, terminal.idle, etc.) to subscribed clients. */
function broadcastEvent(eventType, projectId, payload = {}) {
    if (!wss) return;
    const msg = JSON.stringify({
        type: eventType,
        projectId,
        ...payload,
        timestamp: Date.now()
    });
    for (const ws of wss.clients) {
        if (ws.readyState !== 1) continue;
        if (!ws._subscriptions || !ws._subscriptions.has(projectId)) continue;
        try { ws.send(msg); } catch (_) {}
    }
}

/** Broadcast queue state to clients that subscribed to queue updates. */
function broadcastQueueUpdate(state) {
    if (!wss) return;
    const msg = JSON.stringify({
        type: 'queue.updated',
        ...state,
        timestamp: Date.now()
    });
    for (const ws of wss.clients) {
        if (ws.readyState !== 1) continue;
        if (!ws._subscribeQueue) continue;
        try { ws.send(msg); } catch (_) {}
    }
}

/** Stop the remote server gracefully. */
function stopRemoteServer() {
    if (wss) {
        for (const ws of wss.clients) {
            try { ws.close(1001, 'Server shutting down'); } catch (_) {}
        }
        wss.close();
        wss = null;
    }
    if (server) {
        server.close();
        server = null;
    }
    app = null;
    console.log('[RemoteServer] Stopped.');
}

module.exports = {
    startRemoteServer,
    stopRemoteServer,
    broadcastOutput,
    broadcastEvent,
    broadcastQueueUpdate
};

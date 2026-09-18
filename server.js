const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('./store.js');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 10 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readRawBody(req);
  if (raw.length === 0) {
    throw Object.assign(new Error('请求体为空'), { status: 400 });
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('JSON 解析失败'), { status: 400 });
  }
}

function parseJsonLoose(raw) {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function isLoopback(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function serveStatic(res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { error: '路径解码失败' });
    return;
  }
  if (decoded.includes('\0')) {
    sendJson(res, 400, { error: '非法路径' });
    return;
  }

  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  const rootWithSep = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : PUBLIC_DIR + path.sep;
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(rootWithSep)) {
    sendJson(res, 403, { error: '禁止访问' });
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      sendJson(res, 404, { error: '文件不存在' });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': content.length,
      'cache-control': 'no-cache',
    });
    res.end(content);
  });
}

const OWNER_GRACE_MS = Number(process.env.OWNER_GRACE_MS) > 0
  ? Number(process.env.OWNER_GRACE_MS)
  : 60_000;
const CHECK_INTERVAL_MS = Math.min(15_000, Math.max(500, Math.floor(OWNER_GRACE_MS / 2)));

function createApp({ store, enableAutoExit = false }) {
  const activity = {
    lastActive: Date.now(),
    ownerGoneAt: null,
    exiting: false,
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;

      // 静态资源
      if (req.method === 'GET' && (pathname === '/' || pathname.startsWith('/styles') || pathname === '/app.js' || pathname === '/favicon.ico')) {
        return serveStatic(res, pathname);
      }

      // API
      if (pathname === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, app: 'daily-planner' });
      }

      if (pathname === '/api/heartbeat' && req.method === 'POST') {
        const body = parseJsonLoose(await readRawBody(req));
        const active = body.active !== false;
        if (active) activity.lastActive = Date.now();
        if (body.owner === true) {
          activity.ownerGoneAt = active ? null : Date.now();
        }
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/bye' && req.method === 'POST') {
        const body = parseJsonLoose(await readRawBody(req));
        if (body.owner === true) {
          activity.ownerGoneAt = Date.now();
        }
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/quit' && req.method === 'POST') {
        if (!isLoopback(req)) {
          return sendJson(res, 403, { error: '只有本机可以停止服务' });
        }
        sendJson(res, 200, { ok: true, shutdown: enableAutoExit });
        if (enableAutoExit) {
          setTimeout(() => shutdown('收到本机退出请求'), 300);
        }
        return;
      }

      if (pathname === '/api/state' && req.method === 'GET') {
        activity.lastActive = Date.now();
        return sendJson(res, 200, await store.exportData());
      }

      if (pathname === '/api/day' && req.method === 'GET') {
        activity.lastActive = Date.now();
        const date = url.searchParams.get('date');
        if (!date) return sendJson(res, 400, { error: '缺少 date 参数' });
        try {
          return sendJson(res, 200, await store.getDay(date));
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      if (pathname === '/api/day' && (req.method === 'PUT' || req.method === 'POST')) {
        activity.lastActive = Date.now();
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, err.status || 400, { error: err.message });
        }
        if (!body || typeof body.date !== 'string' || !body.day || typeof body.day !== 'object') {
          return sendJson(res, 400, { error: '需要 { date, day }' });
        }
        try {
          const saved = await store.setDay(body.date, body.day);
          return sendJson(res, 200, { ok: true, day: saved });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      if (pathname === '/api/import' && req.method === 'POST') {
        activity.lastActive = Date.now();
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, err.status || 400, { error: err.message });
        }
        try {
          const count = await store.importData(body);
          return sendJson(res, 200, { ok: true, days: count });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      return sendJson(res, 404, { error: '未找到该接口' });
    } catch (err) {
      return sendJson(res, 500, { error: err.message || '服务器内部错误' });
    }
  });

  let timer = null;
  function shutdown(reason) {
    if (activity.exiting) return;
    activity.exiting = true;
    if (timer) clearInterval(timer);
    console.log(`[每日计划] 正在停止：${reason}`);
    setTimeout(() => process.exit(0), 400);
  }

  if (enableAutoExit) {
    timer = setInterval(() => {
      if (activity.exiting || activity.ownerGoneAt === null) return;
      const now = Date.now();
      if (
        now - activity.ownerGoneAt >= OWNER_GRACE_MS &&
        now - activity.lastActive >= OWNER_GRACE_MS
      ) {
        shutdown('窗口已关闭且没有其他设备在使用');
      }
    }, CHECK_INTERVAL_MS);
    timer.unref();
    server.on('close', () => timer && clearInterval(timer));
  }

  return server;
}

function lanAddresses() {
  const addresses = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) addresses.push(item.address);
    }
  }
  return addresses;
}

async function main() {
  const port = Number(process.env.PORT) || 3210;
  const dataFile = process.env.DATA_FILE
    ? path.resolve(process.env.DATA_FILE)
    : path.join(__dirname, 'data', 'planner-data.json');

  let store;
  try {
    store = await createStore(dataFile);
  } catch (err) {
    console.error(`[每日计划] 启动失败: ${err.message}`);
    process.exit(1);
  }

  const server = createApp({ store, enableAutoExit: true });
  server.listen(port, '0.0.0.0', () => {
    console.log('');
    console.log('每日计划已启动');
    console.log(`  本机访问:  http://127.0.0.1:${port}`);
    for (const ip of lanAddresses()) {
      console.log(`  手机访问:  http://${ip}:${port}  （需连接同一 WiFi）`);
    }
    console.log('');
    console.log('提示: 关闭本窗口即停止服务。数据保存在:');
    console.log('  ' + dataFile);
    console.log('');
  });
}

if (require.main === module) {
  main();
}

module.exports = { createApp };

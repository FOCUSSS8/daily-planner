const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../store.js');
const { createApp } = require('../server.js');

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-api-'));
  const store = await createStore(path.join(dir, 'data.json'));
  const server = createApp({ store }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, store);
  } finally {
    server.close();
  }
}

const sampleDay = {
  goals: { morning: '晨跑', afternoon: '', evening: '' },
  groups: {
    study: [],
    work: [],
    health: [{ id: '1', text: '跑 3 公里', done: true }],
    other: [],
  },
  review: { completed: '', wasted: '', improve: '' },
};

test('GET /api/state 返回空数据', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/state`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.days, {});
  });
});

test('PUT /api/day 后 GET /api/day 能读回', async () => {
  await withServer(async (base) => {
    const put = await fetch(`${base}/api/day`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-09-08', day: sampleDay }),
    });
    assert.equal(put.status, 200);
    const got = await (await fetch(`${base}/api/day?date=2026-09-08`)).json();
    assert.equal(got.groups.health[0].done, true);
    assert.equal(got.goals.morning, '晨跑');
  });
});

test('非法日期返回 400', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/day?date=2026/09/08`);
    assert.equal(res.status, 400);
  });
});

test('缺少 day 字段的 PUT 返回 400', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/day`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-09-08' }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /api/import 替换数据', async () => {
  await withServer(async (base, store) => {
    await store.setDay('2026-09-08', store.emptyDay());
    const res = await fetch(`${base}/api/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, days: {} }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await store.listDays(), []);
  });
});

test('GET / 返回 index.html', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /每日计划/);
  });
});

test('GET /api/health 返回应用标识', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.app, 'daily-planner');
  });
});

test('POST /api/heartbeat 接受心跳', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: true, active: true }),
    });
    assert.equal(res.status, 200);
  });
});

test('非自动退出模式下 /api/quit 只应答不退出进程', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/quit`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).shutdown, false);
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
  });
});

test('POST /api/day 与 PUT 等价（供关闭页面时补发保存）', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/day`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-09-10', day: sampleDay }),
    });
    assert.equal(res.status, 200);
    const got = await (await fetch(`${base}/api/day?date=2026-09-10`)).json();
    assert.equal(got.goals.morning, '晨跑');
  });
});

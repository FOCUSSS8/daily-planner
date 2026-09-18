const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../store.js');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-'));
  return path.join(dir, 'data.json');
}

test('getDay 返回规范的空白日', async () => {
  const store = await createStore(tmpFile());
  const day = await store.getDay('2026-09-08');
  assert.deepEqual(day.goals, { morning: '', afternoon: '', evening: '' });
  assert.deepEqual(day.groups.study, []);
  assert.deepEqual(Object.keys(day.groups), ['study', 'work', 'health', 'other']);
});

test('setDay 后文件持久化，重开 store 仍可读到', async () => {
  const file = tmpFile();
  const s1 = await createStore(file);
  const day = {
    goals: { morning: '写方案', afternoon: '', evening: '运动' },
    groups: { study: [], work: [], health: [{ id: 'x', text: '跑步', done: false }], other: [] },
    review: { completed: '完成', wasted: '', improve: '' },
  };
  await s1.setDay('2026-09-08', day);
  const s2 = await createStore(file);
  const loaded = await s2.getDay('2026-09-08');
  assert.equal(loaded.goals.morning, '写方案');
  assert.equal(loaded.groups.health[0].text, '跑步');
});

test('listDays 返回已存在的日期升序', async () => {
  const store = await createStore(tmpFile());
  await store.setDay('2026-09-10', store.emptyDay());
  await store.setDay('2026-09-08', store.emptyDay());
  assert.deepEqual(await store.listDays(), ['2026-09-08', '2026-09-10']);
});

test('importData 整体替换旧数据', async () => {
  const store = await createStore(tmpFile());
  await store.setDay('2026-09-08', store.emptyDay());
  const incoming = { version: 1, days: { '2026-09-09': store.emptyDay() } };
  await store.importData(incoming);
  assert.deepEqual(await store.listDays(), ['2026-09-09']);
});

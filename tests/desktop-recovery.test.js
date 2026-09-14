const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createDesktopRecovery } = require('../desktop-recovery');

function fixture({ load, timeoutMs = 1000 } = {}) {
  const window = new EventEmitter();
  const contents = new EventEmitter();
  const events = [];
  const dialogs = [];
  let destroyed = false;
  window.webContents = contents;
  window.isDestroyed = () => destroyed;
  window.close = () => { destroyed = true; window.emit('closed'); };
  contents.session = {
    async setProxy(options) { events.push(['proxy', options.mode]); },
    async closeAllConnections() { events.push(['connections-closed']); }
  };
  window.loadURL = async url => { events.push(['load', url]); await load?.(); };
  const recovery = createDesktopRecovery({ window, url: 'http://127.0.0.1:5555', timeoutMs,
    log: message => events.push(['log', message]), logPath: 'debug.log',
    dialog: { showMessageBox: async (_parent, options) => new Promise(resolve => dialogs.push({ options, resolve })) },
    shell: { openPath: async file => { events.push(['open', file]); return ''; } }
  });
  return { window, contents, recovery, events, dialogs };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('local desktop uses a direct session before loading and only renderer readiness confirms startup', async () => {
  const f = fixture();
  await f.recovery.start();
  assert.deepEqual(f.events.slice(0, 3), [['proxy', 'direct'], ['connections-closed'], ['load', 'http://127.0.0.1:5555']]);
  f.contents.emit('did-finish-load');
  assert.equal(f.recovery.isReady(), false);
  f.recovery.markReady();
  assert.equal(f.recovery.isReady(), true);
  f.window.close();
});

test('failed main navigation produces one actionable prompt and user retry can recover', async () => {
  let blocked = true;
  const f = fixture({ load: () => { if (blocked) throw new Error('ERR_PROXY_CONNECTION_FAILED'); } });
  await f.recovery.start();
  f.contents.emit('did-fail-load', {}, -130, 'ERR_PROXY_CONNECTION_FAILED', 'http://127.0.0.1:5555', true);
  await settle();
  assert.equal(f.dialogs.length, 1);
  assert.match(f.dialogs[0].options.detail, /debug\.log/);
  blocked = false;
  f.dialogs[0].resolve({ response: 0 });
  await settle();
  f.recovery.markReady();
  assert.equal(f.recovery.isReady(), true);
  assert.equal(f.events.filter(e => e[0] === 'load').length, 2);
  f.window.close();
});

test('renderer crash records its reason and offers recovery without silently restarting a conversion', async () => {
  const f = fixture();
  await f.recovery.start();
  f.recovery.markReady();
  f.contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 2 });
  await settle();
  assert.equal(f.recovery.isReady(), false);
  assert.equal(f.dialogs.length, 1);
  assert.match(JSON.stringify(f.events), /crashed.*2/);
  assert.equal(f.events.filter(e => e[0] === 'load').length, 1);
  f.window.close();
  f.dialogs[0].resolve({ response: 0 });
  await settle();
  assert.equal(f.events.filter(e => e[0] === 'load').length, 1);
});

test('missing renderer script times out even after did-finish-load; subframe failures do not interrupt startup', async () => {
  const f = fixture({ timeoutMs: 20 });
  await f.recovery.start();
  f.contents.emit('did-finish-load');
  f.contents.emit('did-fail-load', {}, -20, 'blocked', 'about:blank', false);
  assert.equal(f.dialogs.length, 0);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.dialogs.length, 1);
  assert.match(f.dialogs[0].options.detail, /renderer-ready-timeout/);
  f.window.close();
});

test('late readiness avoids reloading recovered work after a timeout prompt', async () => {
  const f = fixture({ timeoutMs: 10 });
  await f.recovery.start();
  await new Promise(resolve => setTimeout(resolve, 30));
  f.recovery.markReady();
  f.dialogs[0].resolve({ response: 0 });
  await settle();
  assert.equal(f.events.filter(e => e[0] === 'load').length, 1);
  f.window.close();
});

test('a second failure while an obsolete prompt is open still gets a recovery prompt', async () => {
  const f = fixture();
  await f.recovery.start();
  f.contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 2 });
  f.recovery.markReady();
  f.contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 2 });
  f.dialogs[0].resolve({ response: 0 });
  await settle();
  assert.equal(f.dialogs.length, 2);
  assert.equal(f.events.filter(e => e[0] === 'load').length, 1);
  f.window.close();
});

test('a responsive event preserves a recovered interface without reloading', async () => {
  const f = fixture();
  await f.recovery.start();
  f.recovery.markReady();
  f.window.emit('unresponsive');
  f.window.emit('responsive');
  f.dialogs[0].resolve({ response: 0 });
  await settle();
  assert.equal(f.recovery.isReady(), true);
  assert.equal(f.events.filter(e => e[0] === 'load').length, 1);
  f.window.close();
});

test('a manual reload arms readiness detection again for missing app scripts', async () => {
  const f = fixture({ timeoutMs: 10 });
  await f.recovery.start();
  f.recovery.markReady();
  f.contents.emit('did-start-navigation', {}, 'http://127.0.0.1:5555/', false, true);
  f.contents.emit('did-finish-load');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.dialogs.length, 1);
  f.window.close();
});

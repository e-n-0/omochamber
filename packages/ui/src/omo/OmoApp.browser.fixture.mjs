// Disposable browser fixture for the shell's wire contracts. It never prompts a provider.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const projects = [
  { id: 'a', path: '/workspace/project-a', name: 'Native workspace', worktreePaths: ['/workspace/worktree-a'] },
  { id: 'b', path: '/workspace/project-b', name: 'Second workspace' },
];
const sessions = [
  { sessionKey: 'offline-a', durableSessionId: 'offline-a', directory: projects[0].path, name: 'Reopen fixture', ownership: 'offline', connection: 'unavailable' },
  { sessionKey: 'terminal-a', durableSessionId: 'terminal-a', directory: projects[0].path, name: 'Terminal fixture', ownership: 'terminal', connection: 'connected' },
];
const streams = new Map();
const snapshots = new Map();
const requests = [];
let settings = { schemaVersion: 1, theme: 'openchamber-dark' };
let authenticated = false;
let failProjects = false;
let revision = 1;
const snapshot = (session) => {
  if (snapshots.has(session.sessionKey)) return snapshots.get(session.sessionKey);
  const value = {
    schemaVersion: 1, sessionKey: session.sessionKey, durableSessionId: session.durableSessionId,
    connectionEpoch: 1, revision, ownership: session.ownership === 'offline' ? 'hosted' : session.ownership,
    connection: 'connected',
    state: {
      directory: session.directory, name: session.name, isStreaming: false, isCompacting: false, isBashRunning: false,
      isRetrying: false, retryAttempt: 0, projectTrusted: true, model: null, thinkingLevel: null,
      availableModels: [], availableThinkingLevels: [], commands: [],
    },
    activeBranch: { leafId: null, entries: [] },
    goal: { status: 'ready', value: null }, todo: { status: 'ready', value: null },
    tasks: { status: 'ready', value: [] }, dags: { status: 'ready', value: [] }, pendingInteractions: [],
  };
  snapshots.set(session.sessionKey, value);
  return value;
};
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><div id="root"></div><script type="module" src="/@vite/client"></script><script type="module" src="/__shell-fixture.tsx"></script></body></html>`;
const source = `import React from 'react'; import {createRoot} from 'react-dom/client';
import {I18nProvider} from '/packages/ui/src/lib/i18n'; import {OmoApp} from '/packages/ui/src/omo/OmoApp';
import '/packages/ui/src/index.css'; createRoot(document.getElementById('root')).render(<I18nProvider><OmoApp/></I18nProvider>);`;
const server = await createServer({
  root, configFile: false, appType: 'custom',
  resolve: { alias: { '@': path.join(root, 'packages/ui/src') } },
  optimizeDeps: { entries: [] },
  plugins: [react(), {
    name: 'native-shell-fixture',
    resolveId(id) { if (id === '/__shell-fixture.tsx') return id; },
    load(id) { if (id === '/__shell-fixture.tsx') return source; },
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url === '/') {
          res.setHeader('Content-Type', 'text/html');
          res.end(await vite.transformIndexHtml('/', html));
          return;
        }
        const route = req.url.split('?')[0];
        if (!route.startsWith('/api/') && !route.startsWith('/auth/')) return next();
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const input = raw ? JSON.parse(raw) : {};
        requests.push({ route, method: req.method, input: route.startsWith('/auth/') ? null : input });
        let value;
        if (route === '/auth/session') {
          if (req.method === 'POST' && input.password === 'fixture-unlock') authenticated = true;
          if (!authenticated) res.statusCode = 401;
          value = { authenticated, locked: !authenticated };
        } else if (!authenticated) {
          res.statusCode = 401;
          value = { authenticated: false };
        } else if (route === '/api/omo/settings') {
          if (req.method === 'PATCH') settings = { ...settings, ...input };
          value = settings;
        } else if (route === '/api/omo/status') {
          value = { available: true, protocolVersion: 1, capabilities: ['multi_session', 'extension_events'] };
        } else if (route === '/api/omo/projects') {
          if (req.method === 'POST') {
            const added = { id: crypto.randomUUID(), ...input };
            projects.push(added);
            value = added;
          } else if (failProjects) { res.statusCode = 503; value = { code: 'fixture_read_failure' }; }
          else value = projects;
        } else if (route.startsWith('/api/omo/projects/')) {
          const project = projects.find((item) => item.id === route.split('/').at(-1));
          Object.assign(project, input);
          value = project;
        } else if (route === '/api/omo/sessions') {
          if (req.method === 'POST') {
            const project = projects.find((item) => item.id === input.projectId);
            const added = { sessionKey: crypto.randomUUID(), durableSessionId: crypto.randomUUID(),
              directory: input.worktreePath ?? project.path, name: null, ownership: 'hosted', connection: 'connected' };
            sessions.push(added);
            value = added;
          } else value = sessions;
        } else if (route.endsWith('/events')) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.write(': connected\n\n');
          const key = route.split('/')[4];
          streams.set(key, res);
          res.on('close', () => { if (streams.get(key) === res) streams.delete(key); });
          return;
        } else if (route.endsWith('/snapshot') || route.endsWith('/attach')) {
          value = snapshot(sessions.find((item) => item.sessionKey === route.split('/')[4]));
        } else if (route.endsWith('/commands') || route.endsWith('/ui-responses')) {
          const key = route.split('/')[4];
          value = { requestId: input.requestId, connectionEpoch: input.connectionEpoch, accepted: true };
          const current = snapshot(sessions.find((item) => item.sessionKey === key));
          if (input.command?.type === 'rename') {
            current.state.name = input.command.name;
            sessions.find((item) => item.sessionKey === key).name = input.command.name;
          }
          if (input.uiRequestId) current.pendingInteractions = current.pendingInteractions.filter((item) => item.id !== input.uiRequestId);
          const stream = streams.get(key);
          current.revision = ++revision;
          stream?.write(`data: ${JSON.stringify({ type: 'commandResult', sessionKey: key, connectionEpoch: 1, revision,
            result: { requestId: input.requestId, success: true } })}\n\n`);
          current.revision = ++revision;
          stream?.write(`data: ${JSON.stringify({ type: 'snapshot', sessionKey: key, connectionEpoch: 1, revision, snapshot: current })}\n\n`);
        } else if (route === '/api/fs/list') value = [];
        else if (route === '/api/git/check') value = { isGitRepo: false };
        else { res.statusCode = 503; value = { code: 'fixture_unavailable' }; }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(value));
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
});
let browser;
let profile;
const evidence = path.resolve(root, '.tmp/omochamber-evidence/web/shell');
try {
  await server.listen();
  assert(process.env.OMOWRIGHT_ENTRY);
  const omowright = await import(process.env.OMOWRIGHT_ENTRY);
  profile = await fs.mkdtemp(path.join(os.tmpdir(), 'omochamber-shell-'));
  browser = await omowright.connectPipe({
    browserPath: process.env.OMO_BROWSER_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    browserArgs: ['--headless=new', '--no-first-run', `--user-data-dir=${profile}`], storageRoot: profile,
    dialogPolicy: { accept: true },
  });
  const page = await browser.newTab(server.resolvedUrls.local[0]);
  await omowright.emulate(page, 'desktop-1440');
  await fs.mkdir(evidence, { recursive: true });
  const capture = async (name) => {
    await fs.writeFile(path.join(evidence, `${name}.png`), await page.screenshot());
    console.log(`CAPTURE ${name}`);
  };
  await page.locator('[data-testid="omo-auth-password"]').waitFor({ state: 'visible', timeoutMs: 30_000 });
  await capture('desktop-auth');
  await page.locator('[data-testid="omo-auth-password"]').fill('rejected-fixture');
  await page.locator('[data-testid="omo-auth-unlock"]').click();
  await page.locator('[data-testid="omo-auth-gate"] [role="alert"]').waitFor({ state: 'visible' });
  await capture('desktop-auth-rejected');
  await page.locator('[data-testid="omo-auth-password"]').fill('fixture-unlock');
  await page.locator('[data-testid="omo-auth-unlock"]').click();
  await page.locator('[data-testid="omo-new-session"]:not([disabled])').waitFor({ state: 'visible', timeoutMs: 15_000 });
  await capture('desktop-empty');
  console.log(omowright.compactSnapshot(await page.snapshot()));
  await page.locator('[data-testid="omo-add-project"]').click();
  await page.locator('[data-testid="omo-project-path"]').fill('/workspace/added-project');
  await page.locator('[data-testid="omo-project-name"]').fill('Added fixture');
  await capture('desktop-project-add');
  await page.locator('[data-testid="omo-project-save"]').click();
  await page.locator('[data-testid="omo-project-form"]').waitFor({ state: 'hidden' });
  const addedProject = projects.at(-1);
  await page.locator(`[data-project-id="${addedProject.id}"]`).waitFor({ state: 'visible' });
  await page.locator(`[data-project-rename="${addedProject.id}"]`).click();
  await page.locator('[data-testid="omo-project-name"]').fill('Renamed project fixture');
  await capture('desktop-project-rename');
  await page.locator('[data-testid="omo-project-save"]').click();
  await page.locator('[data-testid="omo-project-form"]').waitFor({ state: 'hidden' });
  assert.equal(addedProject.name, 'Renamed project fixture');
  await page.locator('[data-project-id="a"]').click();
  await page.locator('[data-session-key="offline-a"]').click();
  await page.locator('[data-testid="omo-composer"]:not([disabled])').waitFor({ state: 'visible' });
  await capture('desktop-reopened');
  await page.locator('[data-testid="omo-session-rename"]').click();
  await page.locator('[data-testid="omo-session-name"]').fill('RENAMED_FIXTURE');
  await page.locator('[data-testid="omo-session-save"]').click();
  await page.locator('[data-rename-status="succeeded"]').waitFor({ state: 'visible' });
  await page.locator('[data-testid="omo-tab-files"]').click();
  const current = snapshot(sessions[0]);
  current.pendingInteractions = [{ id: 'fixture-question', method: 'input', title: 'Fixture native input' }];
  current.revision = ++revision;
  streams.get('offline-a').write(`data: ${JSON.stringify({ type: 'snapshot', sessionKey: 'offline-a', connectionEpoch: 1, revision, snapshot: current })}\n\n`);
  await page.locator('[data-testid="omo-dialog-input"]').waitFor({ state: 'visible' });
  await capture('desktop-dialog-files');
  await page.locator('[data-testid="omo-dialog-input"]').fill('ANSWER_FIXTURE');
  await page.locator('[data-testid="omo-dialog-submit"]').click();
  await page.locator('[data-testid="omo-pending-dialog"]').waitFor({ state: 'hidden' });
  await page.locator('[data-worktree-path="/workspace/worktree-a"]').click();
  await page.locator('[data-testid="omo-new-session"]').click();
  await page.locator('[data-testid="omo-composer"]:not([disabled])').waitFor({ state: 'visible' });
  assert.equal(requests.filter((item) => item.route === '/api/omo/sessions' && item.method === 'POST').length, 1);
  assert.equal(requests.find((item) => item.route === '/api/omo/sessions' && item.method === 'POST').input.worktreePath, '/workspace/worktree-a');
  await page.locator('[data-testid="omo-panels-toggle"]').click();
  await capture('desktop-panels');
  await omowright.emulate(page, { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, hasTouch: true });
  await capture('mobile-panels');
  await page.locator('[data-testid="omo-panels-toggle"]').click();
  await capture('mobile-chat');
  await page.locator('[data-testid="omo-navigation-toggle"]').click();
  await capture('mobile-navigation');
  await page.locator('[data-testid="omo-theme-light"]').click();
  await page.locator('html[data-theme="light"]').waitFor({ state: 'visible' });
  await capture('mobile-navigation-light');
  await page.locator('[data-project-id="a"]').click();
  await page.locator('[data-session-key="terminal-a"]').click();
  await capture('mobile-terminal-readonly');
  await page.locator('[data-testid="omo-tab-changes"]').click();
  await capture('mobile-changes');
  await page.locator('[data-testid="omo-tab-terminal"]').click();
  await capture('mobile-terminal-unavailable');
  await page.locator('[data-testid="omo-navigation-toggle"]').click();
  failProjects = true;
  await page.locator('[data-testid="omo-project-sidebar"] button').first().click();
  await page.locator('[data-testid="omo-project-sidebar"] [role="alert"]').waitFor({ state: 'visible' });
  await capture('mobile-project-read-error-retained');
  assert.equal(await page.locator('[data-project-id]').count(), 3);
  failProjects = false;
  await page.locator('[data-testid="omo-project-sidebar"] button').first().click();
  await page.locator('[data-testid="omo-project-sidebar"] [role="alert"]').waitFor({ state: 'hidden' });
  await page.locator('[data-session-key="offline-a"]').click();
  const mobileSnapshot = snapshot(sessions[0]);
  mobileSnapshot.pendingInteractions = [{ id: 'mobile-request', method: 'confirm', title: 'Native confirm fixture', message: 'CONFIRM_FIXTURE' }];
  mobileSnapshot.revision = ++revision;
  streams.get('offline-a').write(`data: ${JSON.stringify({ type: 'snapshot', sessionKey: 'offline-a', connectionEpoch: 1, revision, snapshot: mobileSnapshot })}\n\n`);
  await page.locator('[data-testid="omo-pending-dialog"]').waitFor({ state: 'visible' });
  await capture('mobile-native-dialog');
  await page.locator('[data-testid="omo-dialog-deny"]').click();
  await page.locator('[data-testid="omo-pending-dialog"]').waitFor({ state: 'hidden' });
  authenticated = false;
  await page.locator('[data-testid="omo-status-refresh"]').click();
  await page.locator('[data-testid="omo-auth-password"]').waitFor({ state: 'visible' });
  await capture('mobile-auth-expired');
  await page.locator('[data-testid="omo-auth-password"]').fill('fixture-unlock');
  await page.locator('[data-testid="omo-auth-unlock"]').click();
  await page.locator('[data-testid="omo-app"]').waitFor({ state: 'visible' });
  await page.locator('[data-testid="omo-navigation-toggle"]').click();
  await page.locator('[data-testid="omo-theme-dark"]').click();
  await page.locator('html[data-theme="dark"]').waitFor({ state: 'visible' });
  await capture('mobile-navigation-dark-restored');
  const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.equal(layout.scrollWidth, layout.width);
  await fs.writeFile(path.join(evidence, 'requests.json'), JSON.stringify(requests, null, 2));
  console.log('SHELL_BROWSER_PASS');
} finally {
  await browser?.close();
  for (const stream of streams.values()) stream.end();
  server.httpServer?.closeAllConnections();
  await server.close();
  if (profile) await fs.rm(profile, { recursive: true, force: true });
  await fs.mkdir(evidence, { recursive: true });
  await fs.writeFile(path.join(evidence, 'cleanup.json'), JSON.stringify({
    browserClosed: true, serverClosed: true, profileRemoved: profile ? await fs.stat(profile).then(() => false, () => true) : true,
    fixtureOnly: true, providerPrompts: 0,
  }, null, 2));
}

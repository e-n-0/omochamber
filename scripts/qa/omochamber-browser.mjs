#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const help = `OmoChamber browser QA
  --scenario startup|layout|chat|controls|workspace|reconnect
  --base-url <url>           Existing loopback native UI, HMR or built
  --omowright-entry <path>   Staged omowright index.js; or OMOWRIGHT_ENTRY
  --browser-path <path>      Chromium executable; or OMO_BROWSER_PATH
  --evidence-dir <path>      Captures, DOM, action log and cleanup receipt
  --width <pixels> --height <pixels>
  --session-key <key>        Select a parent-owned native session
  --actions-file <path>      JSON actions for controls/workspace/reconnect
  --allow-provider-prompts   Required for chat and custom mutation scenarios

Actions: {op:"click",selector}, {op:"fill",selector,value},
{op:"type",selector,value},
{op:"press",selector,key}, {op:"wait",selector,state?},
{op:"wheel",selector,deltaY},
{op:"text",selector,value,count?}, {op:"scroll",selector},
{op:"capture",name}, {op:"reload"}.
Only startup/layout are run without mutation authorization. Custom scenarios
operate on parent-provisioned native fixtures, never a replacement UI or backend.
OMO_BROWSER_PASSWORD unlocks a password-protected QA server and is never logged.
`;
const actionSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('click'), selector: z.string().min(1) }).strict(),
  z.object({ op: z.literal('fill'), selector: z.string().min(1), value: z.string() }).strict(),
  z.object({ op: z.literal('type'), selector: z.string().min(1), value: z.string() }).strict(),
  z.object({ op: z.literal('press'), selector: z.string().min(1), key: z.string().min(1) }).strict(),
  z.object({ op: z.literal('wheel'), selector: z.string().min(1), deltaY: z.number().finite() }).strict(),
  z.object({ op: z.literal('wait'), selector: z.string().min(1), state: z.enum(['visible', 'hidden']).default('visible') }).strict(),
  z.object({ op: z.literal('text'), selector: z.string().min(1), value: z.string(), count: z.number().int().positive().default(1) }).strict(),
  z.object({ op: z.literal('scroll'), selector: z.string().min(1) }).strict(),
  z.object({ op: z.literal('capture'), name: z.string().regex(/^[a-z0-9-]+$/) }).strict(),
  z.object({ op: z.literal('reload') }).strict(),
]);

/** Return only after the observer is armed, before the action being checked. */
async function armTextWait(page, selector, value, count = 1, excludeDetails = false) {
  const key = `__omochamberQaText_${crypto.randomUUID()}`;
  const initialCount = await page.evaluate(`(() => {
    let initialCount;
    globalThis[${JSON.stringify(key)}] = new Promise(resolve => {
    const selector = ${JSON.stringify(selector)}, value = ${JSON.stringify(value)}, count = ${count};
    const excludeDetails = ${excludeDetails};
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => finish('Expected native DOM text did not arrive'), 120000);
    function finish(error = null) { clearTimeout(timer); observer.disconnect(); resolve(error); }
    function check() {
      const matches = [...document.querySelectorAll(selector)].filter(node =>
        (!excludeDetails || !node.closest('details')) && node.textContent.includes(value));
      initialCount ??= matches.length;
      if (matches.length === count) finish();
      else if (matches.length > count) finish('Duplicate native DOM content');
    }
    observer.observe(document, {childList:true, subtree:true, characterData:true});
    check();
    });
    return initialCount;
  })()`);
  return {
    initialCount,
    async wait() {
      const error = await page.evaluate(`(async () => {
        const error = await globalThis[${JSON.stringify(key)}];
        delete globalThis[${JSON.stringify(key)}];
        return error;
      })()`);
      assert.equal(error, null);
    },
  };
}

async function waitForText(page, selector, value, count = 1, excludeDetails = false) {
  const signal = await armTextWait(page, selector, value, count, excludeDetails);
  await signal.wait();
}

export async function runBrowserQa(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv, strict: true,
    options: {
      help: { type: 'boolean' }, scenario: { type: 'string', default: 'startup' },
      'base-url': { type: 'string' }, 'omowright-entry': { type: 'string' },
      'browser-path': { type: 'string' }, 'evidence-dir': { type: 'string', default: '.tmp/omochamber-evidence/web/startup' },
      width: { type: 'string', default: '1440' }, height: { type: 'string', default: '900' },
      'session-key': { type: 'string' }, 'actions-file': { type: 'string' },
      'allow-provider-prompts': { type: 'boolean', default: false },
    },
  });
  if (values.help) { process.stdout.write(help); return; }
  const scenario = z.enum(['startup', 'layout', 'chat', 'controls', 'workspace', 'reconnect']).parse(values.scenario);
  const url = new URL(z.string().min(1).parse(values['base-url']));
  assert(['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'QA requires a loopback UI');
  assert(!url.username && !url.password && !url.search && !url.hash, 'QA URL must not contain credentials or query parameters');
  const width = z.number().int().min(320).max(3840).parse(Number(values.width));
  const height = z.number().int().min(320).max(2160).parse(Number(values.height));
  const entry = z.string().min(1).parse(values['omowright-entry'] ?? process.env.OMOWRIGHT_ENTRY);
  const browserPath = z.string().min(1).parse(values['browser-path'] ?? process.env.OMO_BROWSER_PATH);
  const actions = values['actions-file']
    ? z.array(actionSchema).min(1).parse(JSON.parse(await fs.readFile(path.resolve(values['actions-file']), 'utf8'))) : [];
  if (!['startup', 'layout'].includes(scenario) || actions.length) assert(values['allow-provider-prompts'], 'Parent mutation authorization requires --allow-provider-prompts');
  if (['controls', 'workspace', 'reconnect'].includes(scenario)) assert(actions.length, 'This scenario requires a parent-owned --actions-file');
  const evidenceDir = path.resolve(repository, values['evidence-dir']);
  const evidence = { scenario, url: url.href, width, height, startedAt: new Date().toISOString(), sourceDigests: {},
    actions: [], captures: [], requests: [], resources: [], cleanup: [], status: 'FAIL' };
  await fs.mkdir(evidenceDir, { recursive: true });
  for (const source of ['packages/web/index.html', 'packages/web/src/omo-main.tsx', 'packages/web/src/omo-runtime.ts',
    'packages/web/server/index.js', 'packages/ui/src/omo/OmoApp.tsx', 'scripts/qa/omochamber-browser.mjs']) {
    evidence.sourceDigests[source] = createHash('sha256').update(await fs.readFile(path.join(repository, source))).digest('hex');
  }
  let profile;
  let browser;
  let snoop;
  let page;
  let failure;
  const capture = async (name) => {
    await page.evaluate(() => document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    await fs.writeFile(path.join(evidenceDir, `${name}.png`), await page.screenshot());
    const dom = await page.evaluate(() => ({
      title: document.title, width: innerWidth, height: innerHeight,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      font: getComputedStyle(document.body).fontFamily,
      background: getComputedStyle(document.body).backgroundColor,
      buttons: [...document.querySelectorAll('button')].filter(node => node.getClientRects().length).map(node => ({
        testId: node.dataset.testid ?? null, disabled: node.disabled, text: node.textContent,
      })),
    }));
    await fs.writeFile(path.join(evidenceDir, `${name}.dom.json`), JSON.stringify(dom, null, 2));
    await fs.writeFile(path.join(evidenceDir, `${name}.dom.txt`), (await page.snapshot()).tree);
    evidence.captures.push({ name, file: `${name}.png`, dom });
    assert.equal(dom.width, width);
    assert.equal(dom.height, height);
    assert.equal(dom.horizontalOverflow, false, 'Native page overflows the viewport');
  };
  const step = async (name, action, fn) => {
    const record = { name, ...action, status: 'FAIL' };
    evidence.actions.push(record);
    await fn();
    record.status = 'PASS';
  };
  const click = (selector) => step(`click ${selector}`, { op: 'click', selector }, () => page.locator(selector).click());
  const navigation = async () => {
    if (width <= 1024) await click('[data-testid="omo-navigation-toggle"]');
  };
  const chooseSession = async () => {
    assert(values['session-key'], 'A parent-provisioned --session-key is required');
    await navigation();
    await click(`[data-session-key=${JSON.stringify(values['session-key'])}]`);
    await page.locator('[data-testid="omo-composer"] .cm-content[contenteditable="true"]').waitFor({ state: 'visible', timeout: 30_000 });
  };
  try {
    const omowright = await import(pathToFileURL(path.resolve(entry)).href);
    profile = await fs.mkdtemp(path.join(os.tmpdir(), 'omochamber-browser-'));
    evidence.resources.push({ kind: 'browser-profile', path: profile, owned: true });
    browser = await omowright.connectPipe({
      browserPath, browserArgs: ['--headless=new', '--no-first-run', `--user-data-dir=${profile}`],
      storageRoot: profile, dialogPolicy: { accept: false },
    });
    evidence.resources.push({ kind: 'browser-process', owned: true });
    const tabs = omowright.createAgentTabs(browser, { viewport: { width, height } });
    page = (await tabs.create('about:blank')).page;
    await omowright.emulate(page, { width, height, deviceScaleFactor: 1, mobile: width <= 1024, hasTouch: width <= 1024 });
    snoop = omowright.createNetworkSnoop(page, { bodies: false, maxEntries: 1000 });
    const authenticated = snoop.waitFor({ url: /\/auth\/session$/, method: 'GET' }, { timeoutMs: 30_000 });
    await step('open actual native entry', { op: 'navigate' }, () => page.goto(url.href));
    const authResponse = await authenticated;
    if (authResponse.status === 401) {
      await capture('auth-locked');
      const password = process.env.OMO_BROWSER_PASSWORD;
      assert(password, 'Password-protected QA requires OMO_BROWSER_PASSWORD');
      await page.locator('[data-testid="omo-auth-password"]').fill(password);
      await click('[data-testid="omo-auth-unlock"]');
    } else assert.equal(authResponse.status, 200);
    await page.locator('[data-testid="omo-app"]').waitFor({ state: 'visible', timeout: 30_000 });
    await navigation();
    await page.locator('[data-testid="omo-theme-light"]:not([disabled])').waitFor({ state: 'visible', timeout: 30_000 });
    if (width <= 1024) await click('[data-testid="omo-navigation-toggle"]');
    await capture('initial');
    if (scenario === 'layout') {
      if (values['session-key']) await chooseSession();
      for (const theme of ['light', 'dark']) {
        await navigation();
        await click(`[data-testid="omo-theme-${theme}"]`);
        await page.locator(`[data-testid="omo-theme-${theme}"][aria-pressed="true"]:not([disabled])`).waitFor({ state: 'visible' });
        await capture(`${theme}-navigation`);
        if (width <= 1024) await click('[data-testid="omo-navigation-toggle"]');
        for (const tab of ['files', 'changes', 'terminal']) {
          await click(`[data-testid="omo-tab-${tab}"]`);
          await page.locator(`[data-testid="omo-tab-${tab}"][aria-pressed="true"]`).waitFor({ state: 'visible' });
          await page.locator('[data-testid="omo-chat-column"]').waitFor({ state: 'visible' });
          await capture(`${theme}-${tab}`);
        }
        await click('[data-testid="omo-context-close"]');
        await page.locator('#omo-context-pane').waitFor({ state: 'hidden' });
        if (await page.locator('[data-testid="omo-panels-toggle"]').getAttribute('aria-pressed') === 'true') {
          await click('[data-testid="omo-panels-toggle"]');
        }
        await page.locator('#omo-panels aside[aria-hidden="false"]').waitFor({ state: 'hidden' });
        await click('[data-testid="omo-panels-toggle"]');
        await page.locator('#omo-panels aside[aria-hidden="false"]').waitFor({ state: 'visible' });
        await capture(`${theme}-panels`);
        await click('[data-testid="omo-panels-toggle"]');
      }
    }
    if (scenario === 'chat') {
      await chooseSession();
      const assistantText = '[data-message-role="assistant"] .markdown-content';
      for (const marker of ['OMOCHAMBER_QA_OK', 'OMOCHAMBER_CONTINUE_OK']) {
        await step(`send ${marker}`, { op: 'sentinel', marker }, async () => {
          const reply = await armTextWait(page, assistantText, marker, 1, true);
          assert.equal(reply.initialCount, 0, 'QA sentinel already exists; use a fresh owned session');
          await page.locator('[data-testid="omo-composer"] .cm-content[contenteditable="true"]').fill(`Reply with exactly ${marker}.`);
          await page.locator('[data-testid="omo-send"]').click();
          await reply.wait();
          await page.locator('[data-testid="omo-abort"]').waitFor({ state: 'hidden', timeout: 120_000 });
          await waitForText(page, assistantText, marker, 1, true);
        });
        await step(`show ${marker}`, { op: 'scroll', marker }, () => page.evaluate(`(() => {
          const response = [...document.querySelectorAll(${JSON.stringify(assistantText)})]
            .find(node => !node.closest('details') && node.textContent.includes(${JSON.stringify(marker)}));
          if (!response) throw new Error('Settled assistant response is missing');
          response.scrollIntoView({block:'center'});
        })()`));
        await capture(marker.toLowerCase().replaceAll('_', '-'));
        await step('reload and reattach native history', { op: 'reload' }, () => page.goto(url.href));
        await page.locator('[data-testid="omo-app"]').waitFor({ state: 'visible', timeout: 30_000 });
        await chooseSession();
        await waitForText(page, assistantText, marker, 1, true);
      }
      for (const marker of ['OMOCHAMBER_QA_OK', 'OMOCHAMBER_CONTINUE_OK']) {
        await waitForText(page, assistantText, marker, 1, true);
      }
      await capture('chat-reloaded');
    }
    if (values['session-key'] && scenario !== 'chat') await chooseSession();
    for (const action of actions) {
      const loggedAction = { ...action };
      if (loggedAction.op === 'fill' || loggedAction.op === 'type') loggedAction.value = '[redacted]';
      await step(`custom ${action.op}`, loggedAction, async () => {
        switch (action.op) {
          case 'click': await page.locator(action.selector).click(); break;
          case 'fill': await page.locator(action.selector).fill(action.value); break;
          case 'type':
            await page.evaluate(`(() => {
              const node = document.querySelector(${JSON.stringify(action.selector)});
              if (!node) throw new Error('QA typing target is missing');
              node.focus();
            })()`);
            for (const [index, line] of action.value.split('\n').entries()) {
              if (index > 0) await page.keyboard.press('Enter');
              if (line) await page.keyboard.type(line);
            }
            break;
            case 'press': await page.locator(action.selector).press(action.key); break;
            case 'wheel':
              await page.locator(action.selector).hover();
              {
                const target = await page.evaluate(`(() => {
                  const rect = document.querySelector(${JSON.stringify(action.selector)}).getBoundingClientRect();
                  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                })()`);
                await page.mouse.move(target.x, target.y);
              }
              await page.mouse.wheel(0, action.deltaY);
              break;
          case 'wait': await page.locator(action.selector).waitFor({ state: action.state, timeout: 120_000 }); break;
          case 'text': await waitForText(page, action.selector, action.value, action.count); break;
          case 'scroll': await page.evaluate(`(() => {
            const node = document.querySelector(${JSON.stringify(action.selector)});
            if (!node) throw new Error('QA scroll target is missing');
            node.scrollIntoView({block:'center'});
          })()`); break;
          case 'capture': await capture(action.name); break;
          case 'reload': await page.goto(url.href); break;
          default: throw new Error('Unsupported QA action');
        }
      });
    }
    await capture('final');
    const requests = snoop.peek();
    assert(!requests.some(request => /\/api\/(?:opencode|session-goal|message-stream|global\/event)(?:\/|$)/.test(new URL(request.url).pathname)),
      'Legacy runtime request during native startup');
    evidence.status = 'PASS';
  } catch (error) {
    failure = error;
    evidence.error = error.message;
    if (page) {
      try { await capture('failure'); } catch (captureError) { evidence.captureError = captureError.message; }
    }
  } finally {
    if (snoop) {
      evidence.requests = snoop.peek().map(request => ({ path: new URL(request.url).pathname,
        method: request.method, status: request.status, failed: request.failed }));
      snoop.dispose();
    }
    if (browser) {
      try { await browser.close(); evidence.cleanup.push({ kind: 'browser-process', closed: true }); }
      catch (error) { failure ??= error; evidence.cleanup.push({ kind: 'browser-process', closed: false, error: error.message }); }
    }
    if (profile) {
      try {
        await fs.rm(profile, { recursive: true, force: true });
        const removed = await fs.stat(profile).then(() => false, error => {
          if (error.code !== 'ENOENT') throw error;
          return true;
        });
        assert(removed, 'Owned browser profile survived cleanup');
        evidence.cleanup.push({ kind: 'browser-profile', removed });
      } catch (error) { failure ??= error; evidence.cleanup.push({ kind: 'browser-profile', removed: false, error: error.message }); }
    }
    evidence.status = failure ? 'FAIL' : evidence.status;
    evidence.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(evidenceDir, 'result.json'), JSON.stringify(evidence, null, 2));
    await fs.writeFile(path.join(evidenceDir, 'actions.jsonl'), evidence.actions.map(action => JSON.stringify(action)).join('\n') + '\n');
    process.stdout.write(`${evidence.status} ${scenario} ${evidenceDir}\n`);
  }
  if (failure) throw failure;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runBrowserQa();
}

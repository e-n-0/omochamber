import { expect, test } from 'bun:test';
import { act, StrictMode } from 'react';
import { click, mount, nativeHarness, nativeSnapshot, type } from './chatTestFixture';
import type { InteractionAnswer, PendingInteraction } from '../contracts';
import { createNativeDesktopCapabilities, type NativeDesktopBridge } from '../desktop/adapter';
import { NativeDesktopContext } from '../desktop/context';
import { useI18nStore } from '@/lib/i18n';
import { dict as en } from '@/lib/i18n/messages/en';
import { dict as fr } from '@/lib/i18n/messages/fr';

const { NativeDialogs } = await import('./NativeDialogs');

const cases: readonly { readonly interaction: PendingInteraction; readonly answer: InteractionAnswer; readonly field?: string; readonly value?: string }[] = [
  { interaction: { id: 'select', method: 'select', title: 'SELECT_SENTINEL', options: ['A', 'B'] }, answer: { value: 'B' } },
  { interaction: { id: 'input', method: 'input', title: 'INPUT_SENTINEL', placeholder: 'INPUT_PLACEHOLDER' },
    field: '[data-testid="omo-dialog-input"]', value: 'INPUT_ANSWER', answer: { value: 'INPUT_ANSWER' } },
  { interaction: { id: 'editor', method: 'editor', title: 'EDITOR_SENTINEL', prefill: 'INITIAL_SENTINEL' },
    field: '[data-testid="omo-dialog-editor"]', value: 'EDITED_SENTINEL\nNEXT_LINE', answer: { value: 'EDITED_SENTINEL\nNEXT_LINE' } },
  { interaction: { id: 'confirm', method: 'confirm', title: 'CONFIRM_SENTINEL', message: 'PERMISSION_SENTINEL' }, answer: { confirmed: true } },
];

for (const scenario of cases) {
  test(`${scenario.interaction.method} answers once through native state and waits for authoritative resolution outside chat`, async () => {
    const snapshot = nativeSnapshot();
    snapshot.pendingInteractions = [scenario.interaction];
    const h = nativeHarness(snapshot);
    await h.select();
    // This is deliberately the global dialog root without any Chat mount.
    const view = await mount(<NativeDialogs store={h.store} sessionKey="chat-a" />);
    try {
      expect(document.querySelector('[data-testid="omo-pending-dialog"]')).not.toBeNull();
      if (scenario.interaction.method === 'select') await click('[data-native-option="B"]');
      if (scenario.field && scenario.value) await type(scenario.field, scenario.value);
      if (scenario.interaction.method === 'editor') expect(document.querySelector('textarea')?.value).toBe(scenario.value);
      await click('[data-testid="omo-dialog-submit"]');
      await click('[data-testid="omo-dialog-submit"]');
      expect(h.responses).toHaveLength(1);
      expect(h.responses[0].uiRequestId).toBe(scenario.interaction.id);
      expect(h.responses[0].response).toEqual(scenario.answer);
      expect(document.querySelector('[data-response-status="accepted"]')).not.toBeNull();
      await h.result(h.responses[0].requestId);
      expect(document.querySelector('[data-testid="omo-pending-dialog"]')).not.toBeNull();
      await h.native({ type: 'interaction_resolved', id: scenario.interaction.id });
      expect(document.querySelector('[data-testid="omo-pending-dialog"]')).toBeNull();
    } finally { await view.cleanup(); await h.cleanup(); }
  });
}

test('structured questions preserve multi-choice, free text, and comments in the native answer shape', async () => {
  const snapshot = nativeSnapshot();
  snapshot.pendingInteractions = [{ id: 'question', method: 'question', requestId: 'ask', waitForAnswer: true, questions: [
    { id: 'multi', header: 'MULTI', question: 'MULTI_SENTINEL', multiSelect: true,
      options: [{ label: 'A', description: 'FIRST' }, { label: 'B', description: 'SECOND' }] },
    { id: 'text', header: 'TEXT', question: 'TEXT_SENTINEL', options: [{ label: 'Preset', description: 'PRESET' }] },
  ] }];
  const h = nativeHarness(snapshot);
  await h.select();
  const view = await mount(<NativeDialogs store={h.store} sessionKey="chat-a" />);
  try {
    expect(document.querySelector('[data-testid="omo-dialog-submit"]')?.getAttribute('disabled')).not.toBeNull();
    await click('[data-question-id="multi"] [data-question-option="A"]');
    await click('[data-question-id="multi"] [data-question-option="B"]');
    await type('[data-question-text="text"]', 'FREE_TEXT_SENTINEL');
    await type('[data-testid="omo-question-comment"]', 'COMMENT_SENTINEL');
    await click('[data-testid="omo-dialog-submit"]');
    expect(h.responses[0].response).toEqual({
      answers: { multi: { selected: ['A', 'B'] }, text: { selected: [], text: 'FREE_TEXT_SENTINEL' } },
      comment: 'COMMENT_SENTINEL',
    });
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('single-choice changes replace the prior native option and free text replaces a single choice', async () => {
  const snapshot = nativeSnapshot();
  snapshot.pendingInteractions = [{ id: 'question', method: 'question', requestId: 'ask', waitForAnswer: false,
    questions: [{ id: 'one', header: 'ONE', question: 'ONE_SENTINEL',
      options: [{ label: 'A', description: 'FIRST' }, { label: 'B', description: 'SECOND' }] }] }];
  const h = nativeHarness(snapshot);
  await h.select();
  const view = await mount(<NativeDialogs store={h.store} sessionKey="chat-a" />);
  try {
    await click('[data-question-option="A"]');
    await click('[data-question-option="B"]');
    expect(document.querySelector('[data-question-option="A"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('[data-question-option="B"]')?.getAttribute('aria-pressed')).toBe('true');
    await type('[data-question-text="one"]', 'OTHER_SENTINEL');
    await click('[data-testid="omo-dialog-submit"]');
    expect(h.responses[0].response).toEqual({ answers: { one: { selected: [], text: 'OTHER_SENTINEL' } } });
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('comment-only submission does not invent empty native answers', async () => {
  const snapshot = nativeSnapshot();
  snapshot.pendingInteractions = [{ id: 'question', method: 'question', requestId: 'ask', waitForAnswer: false,
    questions: [{ id: 'one', header: 'ONE', question: 'ONE_SENTINEL', options: [] }] }];
  const h = nativeHarness(snapshot);
  await h.select();
  const view = await mount(<NativeDialogs store={h.store} sessionKey="chat-a" />);
  try {
    await type('[data-testid="omo-question-comment"]', 'COMMENT_ONLY');
    await click('[data-testid="omo-dialog-submit"]');
    expect(h.responses[0].response).toEqual({ answers: {}, comment: 'COMMENT_ONLY' });
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('confirmation denial and cancellation are distinct native responses', async () => {
  for (const [selector, response] of [
    ['[data-testid="omo-dialog-deny"]', { confirmed: false }],
    ['[data-testid="omo-dialog-cancel"]', { cancelled: true }],
  ] as const) {
    const snapshot = nativeSnapshot();
    snapshot.pendingInteractions = [{ id: 'confirm', method: 'confirm', title: 'CONFIRM', message: 'CONFIRM_SENTINEL' }];
    const h = nativeHarness(snapshot);
    await h.select();
    const view = await mount(<NativeDialogs store={h.store} sessionKey="chat-a" />);
    try {
      await click(selector);
      expect(h.responses[0].response).toEqual(response);
    } finally { await view.cleanup(); await h.cleanup(); }
  }
});

test('failed responses are visible and can be retried while uncertain responses cannot replay', async () => {
  for (const status of [400, 503]) {
    const snapshot = nativeSnapshot();
    snapshot.pendingInteractions = [{ id: 'input', method: 'input', title: 'INPUT' }];
    const h = nativeHarness(snapshot);
    await h.select();
    h.responseStatus(status);
    const view = await mount(<NativeDialogs store={h.store} sessionKey="chat-a" />);
    try {
      await type('[data-testid="omo-dialog-input"]', 'ANSWER_SENTINEL');
      await click('[data-testid="omo-dialog-submit"]');
      const resultStatus = status === 400 ? 'failed' : 'uncertain';
      expect(document.querySelector(`[data-response-status="${resultStatus}"]`)).not.toBeNull();
      await click('[data-testid="omo-dialog-submit"]');
      expect(h.responses).toHaveLength(status === 400 ? 2 : 1);
    } finally { await view.cleanup(); await h.cleanup(); }
  }
});

test('terminal, reconnecting, and expired native dialogs disable all response actions', async () => {
  for (const condition of ['terminal', 'reconnecting', 'expired'] as const) {
    const snapshot = nativeSnapshot();
    snapshot.pendingInteractions = [{ id: 'confirm', method: 'confirm', title: 'CONFIRM', message: 'CONFIRM_SENTINEL' }];
    if (condition === 'expired') snapshot.pendingInteractions[0].deadlineAtMs = 1;
    if (condition === 'terminal') snapshot.ownership = 'terminal';
    if (condition === 'reconnecting') snapshot.connection = 'reconnecting';
    const h = nativeHarness(snapshot);
    await h.select();
    const view = await mount(<NativeDialogs store={h.store} sessionKey="chat-a" />);
    try {
      expect(document.querySelector('[data-testid="omo-dialog-submit"]')?.getAttribute('disabled')).not.toBeNull();
      await click('[data-testid="omo-dialog-submit"]');
      await click('[data-testid="omo-dialog-cancel"]');
      expect(h.responses).toHaveLength(0);
    } finally { await view.cleanup(); await h.cleanup(); }
  }
});

test('the next pending request resets dialog fields and stale resolved requests cannot send', async () => {
  const snapshot = nativeSnapshot();
  snapshot.pendingInteractions = [
    { id: 'first', method: 'input', title: 'FIRST' }, { id: 'second', method: 'editor', title: 'SECOND', prefill: 'SECOND_PREFILL' },
  ];
  const h = nativeHarness(snapshot);
  await h.select();
  const view = await mount(<NativeDialogs store={h.store} sessionKey="chat-a" />);
  try {
    await type('[data-testid="omo-dialog-input"]', 'FIRST_DRAFT');
    await h.native({ type: 'interaction_resolved', id: 'first' });
    expect(document.querySelector('textarea')?.value).toBe('SECOND_PREFILL');
    await h.native({ type: 'interaction_resolved', id: 'second' });
    expect(document.querySelector('[data-testid="omo-pending-dialog"]')).toBeNull();
    expect(h.responses).toHaveLength(0);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(h.responses).toHaveLength(0);
  } finally { await view.cleanup(); await h.cleanup(); }
});

function notificationCapability(notify: NativeDesktopBridge['notify']) {
  return createNativeDesktopCapabilities({
    selectFolder: async () => null, selectFile: async () => null,
    openPath: async () => null, revealPath: async () => null, notify,
  });
}

test('a request that becomes writable retains its notification ledger across root rerenders', async () => {
  const snapshot = nativeSnapshot();
  snapshot.connection = 'reconnecting';
  snapshot.pendingInteractions = [{ id: 'waiting', method: 'input', title: 'NATIVE_TITLE' }];
  const h = nativeHarness(snapshot);
  await h.select();
  let calls = 0;
  const desktop = notificationCapability(async () => { calls++; return { supported: true }; });
  const render = () => <NativeDesktopContext.Provider value={desktop}>
    <NativeDialogs store={h.store} sessionKey="chat-a" />
  </NativeDesktopContext.Provider>;
  const view = await mount(render());
  try {
    expect(calls).toBe(0);
    snapshot.connection = 'connected';
    await act(async () => h.store.reconnect());
    expect(calls).toBe(1);
    await view.render(render());
    expect(calls).toBe(1);
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('StrictMode replay, drafts, locale changes and session revisits notify once per pending request', async () => {
  const snapshot = nativeSnapshot();
  snapshot.pendingInteractions = [{ id: 'first', method: 'input', title: 'NATIVE_TITLE_SENTINEL' }];
  const h = nativeHarness(snapshot);
  await h.select();
  const calls: { readonly title: string; readonly body?: string }[] = [];
  const desktop = notificationCapability(async (input) => { calls.push(input); return { supported: true }; });
  const initialLocale = useI18nStore.getState();
  await act(async () => useI18nStore.setState({ locale: 'en', dictionary: en, loadingLocale: null }));
  const render = (sessionKey: string | null = 'chat-a') => <StrictMode><NativeDesktopContext.Provider value={desktop}>
    <NativeDialogs store={h.store} sessionKey={sessionKey} />
  </NativeDesktopContext.Provider></StrictMode>;
  const view = await mount(render());
  try {
    await type('[data-testid="omo-dialog-input"]', 'ANSWER_DRAFT');
    await view.render(render());
    await act(async () => useI18nStore.setState({ locale: 'fr', dictionary: fr, loadingLocale: null }));
    expect(document.querySelector<HTMLInputElement>('[data-testid="omo-dialog-input"]')?.value).toBe('ANSWER_DRAFT');
    await view.render(render(null));
    await view.render(render());
    expect(calls).toEqual([{ title: 'OmoChamber', body: en['omo.dialogs.nativeRequest'] }]);
    await h.native({ type: 'interaction_resolved', id: 'first' });
    await h.native({ type: 'interaction_pending', interaction: { id: 'second', method: 'input', title: 'NEXT_NATIVE_TITLE' } });
    expect(calls).toEqual([
      { title: 'OmoChamber', body: en['omo.dialogs.nativeRequest'] },
      { title: 'OmoChamber', body: fr['omo.dialogs.nativeRequest'] },
    ]);
  } finally {
    await view.cleanup(); await h.cleanup();
    await act(async () => useI18nStore.setState({
      locale: initialLocale.locale, dictionary: initialLocale.dictionary, loadingLocale: initialLocale.loadingLocale,
    }));
  }
});

for (const failure of ['unsupported', 'rejected'] as const) {
  for (const action of ['answer', 'cancel'] as const) {
    test(`${failure} notification never blocks a native question ${action}`, async () => {
      const snapshot = nativeSnapshot();
      snapshot.pendingInteractions = [{ id: 'question', method: 'question', requestId: 'ask', waitForAnswer: true,
        questions: [{ id: 'choice', header: 'NATIVE_HEADER', question: 'NATIVE_QUESTION',
          options: [{ label: 'A', description: 'NATIVE_DESCRIPTION' }] }] }];
      const h = nativeHarness(snapshot);
      await h.select();
      let calls = 0;
      const desktop = notificationCapability(async () => {
        calls++;
        if (failure === 'rejected') throw new Error('OS_NOTIFICATION_REFUSED');
        return { supported: false };
      });
      const view = await mount(<StrictMode><NativeDesktopContext.Provider value={desktop}>
        <NativeDialogs store={h.store} sessionKey="chat-a" />
      </NativeDesktopContext.Provider></StrictMode>);
      try {
        expect(document.querySelector('[data-testid="omo-dialog-notification-error"]')?.getAttribute('role')).toBe('alert');
        if (action === 'answer') {
          await click('[data-question-option="A"]');
          await click('[data-testid="omo-dialog-submit"]');
        } else await click('[data-testid="omo-dialog-cancel"]');
        expect(calls).toBe(1);
        expect(h.responses).toHaveLength(1);
        expect(h.responses[0].response).toEqual(action === 'answer' ? { answers: { choice: { selected: ['A'] } } } : { cancelled: true });
        expect(document.querySelector('[data-response-status="accepted"]')).not.toBeNull();
      } finally { await view.cleanup(); await h.cleanup(); }
    });
  }
}

test('notification failure copy reacts to locale changes without resending or dropping the answer draft', async () => {
  const snapshot = nativeSnapshot();
  snapshot.pendingInteractions = [{ id: 'input', method: 'input', title: 'NATIVE_TITLE' }];
  const h = nativeHarness(snapshot);
  await h.select();
  const initialLocale = useI18nStore.getState();
  await act(async () => useI18nStore.setState({ locale: 'en', dictionary: en, loadingLocale: null }));
  let calls = 0;
  const desktop = notificationCapability(async () => { calls++; return { supported: false }; });
  const view = await mount(<NativeDesktopContext.Provider value={desktop}>
    <NativeDialogs store={h.store} sessionKey="chat-a" />
  </NativeDesktopContext.Provider>);
  try {
    await type('[data-testid="omo-dialog-input"]', 'ANSWER_DRAFT');
    const before = document.querySelector('[data-testid="omo-dialog-notification-error"]')?.textContent;
    await act(async () => useI18nStore.setState({ locale: 'fr', dictionary: fr, loadingLocale: null }));
    expect(document.querySelector('[data-testid="omo-dialog-notification-error"]')?.textContent).not.toBe(before);
    expect(document.querySelector<HTMLInputElement>('[data-testid="omo-dialog-input"]')?.value).toBe('ANSWER_DRAFT');
    await click('[data-testid="omo-dialog-submit"]');
    expect(h.responses[0].response).toEqual({ value: 'ANSWER_DRAFT' });
    expect(calls).toBe(1);
  } finally {
    await view.cleanup(); await h.cleanup();
    await act(async () => useI18nStore.setState({
      locale: initialLocale.locale, dictionary: initialLocale.dictionary, loadingLocale: initialLocale.loadingLocale,
    }));
  }
});

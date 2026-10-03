import { afterAll, expect, test } from 'bun:test';
import { act } from 'react';
import { createPortal } from 'react-dom';
import { browser, mount } from '../../omo/chat/chatTestFixture';
import { ContextPanelFrame, ContextPanelHeader } from './ContextPanelFrame';
import { ContextPanelRailItemView, ContextPanelRailView } from './ContextPanelRailView';

const clientWidth = Object.getOwnPropertyDescriptor(browser.HTMLElement.prototype, 'clientWidth');
Object.defineProperty(browser.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1400 });
afterAll(() => {
  if (clientWidth) Object.defineProperty(browser.HTMLElement.prototype, 'clientWidth', clientWidth);
  else Reflect.deleteProperty(browser.HTMLElement.prototype, 'clientWidth');
});

test('retains content when closed and gives Escape to editor, terminal and portal owners', async () => {
  // Given a mounted original frame with each Escape-owning surface.
  let closes = 0;
  const portal = document.createElement('div');
  document.body.append(portal);
  const render = (open: boolean, expanded = false) => (
    <ContextPanelFrame scopeKey="/project:files" open={open} expanded={expanded} widthFraction={0.5}
      onWidthChange={() => {}} onClose={() => { closes += 1; }}
      header={<ContextPanelHeader expanded={expanded} onExpandedChange={() => {}} onClose={() => { closes += 1; }}><span>Title</span></ContextPanelHeader>}>
      <input data-testid="retained" />
      <div className="cm-editor"><textarea data-testid="editor" /></div>
      <div data-oc-escape-owner="terminal"><textarea data-testid="terminal" /></div>
      <div data-terminal-owner="main"><textarea data-testid="original-terminal" /></div>
      {createPortal(<button data-testid="portal">Menu</button>, portal)}
    </ContextPanelFrame>
  );
  const view = await mount(render(true));
  const retained = view.host.querySelector('[data-testid="retained"]');
  expect(retained).toBeInstanceOf(HTMLInputElement);
  if (!(retained instanceof HTMLInputElement)) throw new Error('Missing retained input');
  retained.value = 'DRAFT';
  try {
    // When the panel expands, closes and reopens without changing its owner.
    await view.render(render(true, true));
    await view.render(render(false));
    expect(view.host.querySelector('[data-context-panel]')?.hasAttribute('inert')).toBe(true);
    await view.render(render(true));
    await act(async () => {
      for (const id of ['editor', 'terminal', 'original-terminal', 'portal']) {
        document.querySelector(`[data-testid="${id}"]`)?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
    });
    // Then the same draft remains and owned Escape events never close it.
    expect(view.host.querySelector('[data-testid="retained"]')).toBe(retained);
    expect(retained.value).toBe('DRAFT');
    expect(closes).toBe(0);
    await act(async () => retained.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(closes).toBe(1);
  } finally {
    await view.cleanup();
    portal.remove();
  }
});

test('commits bounded measured width on pointer release and cancels a changed owner', async () => {
  // Given measured geometry and a controlled width callback.
  const widths: Array<{ width: number; available: number | null }> = [];
  const render = (scopeKey: string) => (
    <ContextPanelFrame scopeKey={scopeKey} open expanded={false} widthFraction={0.5} header={null}
      onClose={() => {}} onWidthChange={(width, available) => widths.push({ width, available })}>
      <div />
    </ContextPanelFrame>
  );
  const view = await mount(render('/a:files'));
  try {
    const aside = view.host.querySelector('[data-context-panel]');
    if (!(aside instanceof HTMLElement)) throw new Error('Missing context aside');
    Object.defineProperty(aside, 'getBoundingClientRect', {
      configurable: true, value: () => new browser.DOMRect(0, 0, 700, 600),
    });
    if (aside.parentElement) Object.defineProperty(aside.parentElement, 'getBoundingClientRect', {
      configurable: true, value: () => new browser.DOMRect(0, 0, 1400, 600),
    });
    // When a drag moves far beyond the transcript boundary and releases.
    await act(async () => view.host.querySelector('[role="separator"]')?.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: 700, bubbles: true })));
    await act(async () => window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 0 })));
    await act(async () => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 })));
    // Then the committed width leaves the original 400px transcript allowance.
    expect(widths).toEqual([{ width: 1000, available: 1400 }]);
    expect(document.documentElement.style.cursor).toBe('');
    await act(async () => view.host.querySelector('[role="separator"]')?.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 2, clientX: 700, bubbles: true })));
    await view.render(render('/b:files'));
    await act(async () => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 })));
    expect(widths).toHaveLength(1);
  } finally { await view.cleanup(); }
});

test('selects controlled tools through the original rail button list', async () => {
  // Given two supported tools and the original clean rail.
  const selections: string[] = [];
  const view = await mount(<ContextPanelRailView ariaLabel="Tools" items={['files', 'terminal']}
    renderItem={(id) => <ContextPanelRailItemView key={id} label={id} description={id}
      icon={<span />} isActive={id === 'files'} onSelect={() => selections.push(id)} />} />);
  try {
    // When the second original rail button is pressed.
    await act(async () => view.host.querySelector<HTMLButtonElement>('[aria-label="terminal"]')?.click());
    // Then selection is emitted and the caller's active state remains authoritative.
    expect(selections).toEqual(['terminal']);
    expect(view.host.querySelector('[aria-label="files"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(view.host.querySelectorAll('nav button')).toHaveLength(2);
  } finally { await view.cleanup(); }
});

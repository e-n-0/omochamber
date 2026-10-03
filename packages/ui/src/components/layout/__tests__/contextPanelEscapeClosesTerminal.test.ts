/**
 * Regression guard for https://github.com/openchamber/openchamber/issues/2644
 *
 * Escape while focus is inside the terminal must reach the PTY (e.g. Vim
 * Normal mode). The context panel still closes on Escape when focus is on
 * non-terminal panel chrome.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, createElement } from 'react';
import { mount } from '../../../omo/chat/chatTestFixture';
import { ContextPanelFrame } from '../ContextPanelFrame';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mobileWorkspaceDrawerSource = readFileSync(
  join(__dirname, '..', '..', '..', 'apps', 'MobileWorkspaceDrawer.tsx'),
  'utf-8',
);

describe('issue #2644: Escape in terminal must not close the context panel', () => {
  for (const [owner, marker, value] of [
    ['original', 'data-terminal-owner', 'main'],
    ['native', 'data-oc-escape-owner', 'terminal'],
  ] as const) {
    test(`Escape in the ${owner} terminal reaches its bubble listener without being prevented`, async () => {
      // Given the real shared frame and a nested terminal input.
      let closes = 0;
      const bubbles: Array<{ key: string; defaultPrevented: boolean }> = [];
      const view = await mount(createElement(ContextPanelFrame, {
        scopeKey: '/project:terminal', open: true, expanded: false, widthFraction: 0.5,
        onWidthChange: () => {}, onClose: () => { closes += 1; }, header: null,
        children: createElement('div', { [marker]: value, 'data-testid': 'terminal' },
          createElement('textarea')),
      }));
      try {
        const terminal = view.host.querySelector('[data-testid="terminal"]');
        const input = view.host.querySelector('textarea');
        if (!(terminal instanceof HTMLElement) || !(input instanceof HTMLTextAreaElement)) {
          throw new Error('Missing terminal fixture');
        }
        terminal.addEventListener('keydown', (event) => {
          bubbles.push({ key: event.key, defaultPrevented: event.defaultPrevented });
        });

        // When a cancelable Escape travels through the frame's capture handler.
        const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        await act(async () => { input.dispatchEvent(event); });

        // Then terminal bubble delivery and the original default state are preserved.
        expect(bubbles).toEqual([{ key: 'Escape', defaultPrevented: false }]);
        expect(event.defaultPrevented).toBe(false);
        expect(closes).toBe(0);
      } finally {
        await view.cleanup();
      }
    });
  }

  test('Escape on non-terminal chrome closes once in capture before bubble delivery', async () => {
    // Given the real shared frame with a non-terminal header button.
    const calls: string[] = [];
    const view = await mount(createElement(ContextPanelFrame, {
      scopeKey: '/project:files', open: true, expanded: false, widthFraction: 0.5,
      onWidthChange: () => {}, onClose: () => { calls.push('closed'); },
      header: createElement('button', { type: 'button' }, 'Files'), children: null,
    }));
    try {
      const button = view.host.querySelector('button');
      if (!(button instanceof HTMLButtonElement)) throw new Error('Missing panel chrome fixture');
      button.addEventListener('keydown', () => { calls.push('chrome-bubble'); });
      view.host.addEventListener('keydown', () => { calls.push('ancestor-bubble'); });

      // When Escape is dispatched from chrome below the panel capture boundary.
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      await act(async () => { button.dispatchEvent(event); });

      // Then capture closes exactly once and consumes Escape before any bubble listener.
      expect(calls).toEqual(['closed']);
      expect(event.defaultPrevented).toBe(true);
    } finally {
      await view.cleanup();
    }
  });

  test('mobile drawer keeps its terminal Escape exception', () => {
    const handlerStart = mobileWorkspaceDrawerSource.indexOf("if (event.key !== 'Escape'");
    expect(handlerStart).toBeGreaterThan(-1);
    const handler = mobileWorkspaceDrawerSource.slice(handlerStart, handlerStart + 300);
    // The terminal tab returns before the drawer closes on Escape.
    expect(handler).toContain("tabRef.current === 'terminal') return");
    expect(handler).toContain('onCloseRef.current()');
  });
});

type Listener = { capture: boolean; onEvent: (event: SimulatedEvent) => void };
type SimulatedEvent = {
  type: string;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  target: SimNode;
  preventDefault(): void;
  stopPropagation(): void;
};

class SimNode {
  readonly children: SimNode[] = [];
  private listeners: Listener[] = [];
  private parent: SimNode | null = null;

  addListener(listener: Listener): void {
    this.listeners.push(listener);
  }

  attach(child: SimNode): void {
    child.parent = this;
    this.children.push(child);
  }

  dispatch(type: string): SimulatedEvent {
    const buildPath = (target: SimNode): SimNode[] => {
      const ancestors: SimNode[] = [];
      let cursor: SimNode | null = target;
      while (cursor !== null) {
        ancestors.push(cursor);
        cursor = cursor.parent;
      }
      ancestors.reverse();
      return ancestors;
    };
    const path = buildPath(this);

    const event: SimulatedEvent = {
      type,
      defaultPrevented: false,
      propagationStopped: false,
      target: this,
      preventDefault() {
        event.defaultPrevented = true;
      },
      stopPropagation() {
        event.propagationStopped = true;
      },
    };

    for (let i = 0; i < path.length; i += 1) {
      if (event.propagationStopped) return event;
      for (const listener of path[i].listeners) {
        if (!listener.capture) continue;
        listener.onEvent(event);
        if (event.propagationStopped) return event;
      }
    }
    for (let i = path.length - 1; i >= 0; i -= 1) {
      if (event.propagationStopped) return event;
      for (const listener of path[i].listeners) {
        if (listener.capture) continue;
        listener.onEvent(event);
        if (event.propagationStopped) return event;
      }
    }
    return event;
  }
}

describe('issue #2644: fixed Escape propagation to the terminal', () => {
  test('when the panel skips terminal Escape, the terminal bubble handler receives it', () => {
    const panel = new SimNode();
    const terminalContainer = new SimNode();
    panel.attach(terminalContainer);

    const calls: string[] = [];
    const panelEscapeHandler = (event: SimulatedEvent) => {
      // Fixed behavior: do not close / stop when the target is the terminal.
      if (event.target === terminalContainer) {
        calls.push('panel-capture-skipped');
        return;
      }
      calls.push('panel-capture-closed');
      event.preventDefault();
      event.stopPropagation();
    };
    const terminalKeydownHandler = () => {
      calls.push('terminal-bubble');
    };

    panel.addListener({ capture: true, onEvent: panelEscapeHandler });
    terminalContainer.addListener({ capture: false, onEvent: terminalKeydownHandler });

    const event = terminalContainer.dispatch('keydown');

    expect(calls).toEqual(['panel-capture-skipped', 'terminal-bubble']);
    expect(event.propagationStopped).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  test('Escape outside the terminal still closes via the capture handler', () => {
    const panel = new SimNode();
    const headerButton = new SimNode();
    const terminalContainer = new SimNode();
    panel.attach(headerButton);
    panel.attach(terminalContainer);

    const calls: string[] = [];
    panel.addListener({
      capture: true,
      onEvent: (event) => {
        if (event.target === terminalContainer) return;
        calls.push('panel-capture-closed');
        event.preventDefault();
        event.stopPropagation();
      },
    });
    terminalContainer.addListener({
      capture: false,
      onEvent: () => calls.push('terminal-bubble'),
    });

    const event = headerButton.dispatch('keydown');
    expect(calls).toEqual(['panel-capture-closed']);
    expect(event.propagationStopped).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });
});

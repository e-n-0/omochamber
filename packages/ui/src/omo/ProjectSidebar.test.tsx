import { expect, test } from 'bun:test';
import { act } from 'react';
import { click, mount, type } from './chat/chatTestFixture';
import { createNativeDesktopCapabilities, type NativeDesktopBridge } from './desktop/adapter';
import { NativeDesktopContext } from './desktop/context';
import type { ProjectInput } from './contracts';

const { ProjectSidebar } = await import('./ProjectSidebar');

function fixture(selectFolder?: NativeDesktopBridge['selectFolder']) {
  const added: ProjectInput[] = [];
  const desktop = selectFolder ? createNativeDesktopCapabilities({
    selectFolder, selectFile: async () => null, openPath: async () => null,
    revealPath: async () => null, notify: async () => ({ supported: true }),
  }) : undefined;
  const element = <NativeDesktopContext.Provider value={desktop}>
    <ProjectSidebar projects={[]} projectId={null} directory="/canonical/project" loading={false} error={null}
      onSelect={() => {}} onAdd={async (input) => { added.push(input); }}
      onRename={async () => {}} onRefresh={() => {}} />
  </NativeDesktopContext.Provider>;
  return { element, added };
}

test('browser flow has no folder control and typed project registration still works', async () => {
  const h = fixture();
  const view = await mount(h.element);
  try {
    await click('[data-testid="omo-add-project"]');
    expect(view.host.querySelector('[data-testid="omo-project-choose-folder"]')).toBeNull();
    await type('[data-testid="omo-project-path"]', '/typed');
    await type('[data-testid="omo-project-name"]', 'TYPED_NAME');
    await click('[data-testid="omo-project-save"]');
    expect(h.added).toEqual([{ path: '/typed', name: 'TYPED_NAME' }]);
  } finally { await view.cleanup(); }
});

test('folder picker cancel preserves the current add form and both drafts', async () => {
  const options: { readonly defaultPath?: string }[] = [];
  const h = fixture(async (input = {}) => { options.push(input); return null; });
  const view = await mount(h.element);
  try {
    await click('[data-testid="omo-add-project"]');
    await type('[data-testid="omo-project-path"]', '/typed');
    await type('[data-testid="omo-project-name"]', 'NAME_DRAFT');
    await click('[data-testid="omo-project-choose-folder"]');
    expect(options).toEqual([{ defaultPath: '/typed' }]);
    expect(document.querySelector<HTMLInputElement>('[data-testid="omo-project-path"]')?.value).toBe('/typed');
    expect(document.querySelector<HTMLInputElement>('[data-testid="omo-project-name"]')?.value).toBe('NAME_DRAFT');
    expect(h.added).toHaveLength(0);
    expect(view.host.querySelector('[data-testid="omo-project-form"]')).not.toBeNull();
  } finally { await view.cleanup(); }
});

test('canonical folder selection populates only the path until explicit submission', async () => {
  const options: { readonly defaultPath?: string }[] = [];
  const h = fixture(async (input = {}) => { options.push(input); return '/canonical/chosen'; });
  const view = await mount(h.element);
  try {
    await click('[data-testid="omo-add-project"]');
    await type('[data-testid="omo-project-name"]', 'NAME_DRAFT');
    await click('[data-testid="omo-project-choose-folder"]');
    expect(options).toEqual([{ defaultPath: '/canonical/project' }]);
    expect(document.querySelector<HTMLInputElement>('[data-testid="omo-project-path"]')?.value).toBe('/canonical/chosen');
    expect(document.querySelector<HTMLInputElement>('[data-testid="omo-project-name"]')?.value).toBe('NAME_DRAFT');
    expect(h.added).toHaveLength(0);
    await click('[data-testid="omo-project-save"]');
    expect(h.added).toEqual([{ path: '/canonical/chosen', name: 'NAME_DRAFT' }]);
  } finally { await view.cleanup(); }
});

test('picker refusal preserves editable drafts and exposes a recoverable error', async () => {
  const h = fixture(async () => { throw new Error('PICKER_REFUSED_SENTINEL'); });
  const view = await mount(h.element);
  try {
    await click('[data-testid="omo-add-project"]');
    await type('[data-testid="omo-project-path"]', '/typed');
    await type('[data-testid="omo-project-name"]', 'NAME_DRAFT');
    await click('[data-testid="omo-project-choose-folder"]');
    expect(view.host.querySelector('[data-testid="omo-project-picker-error"]')?.getAttribute('role')).toBe('alert');
    expect(document.querySelector<HTMLInputElement>('[data-testid="omo-project-path"]')?.value).toBe('/typed');
    expect(document.querySelector<HTMLInputElement>('[data-testid="omo-project-name"]')?.value).toBe('NAME_DRAFT');
    expect(document.querySelector('[data-testid="omo-project-save"]')?.getAttribute('disabled')).toBeNull();
    await click('[data-testid="omo-project-save"]');
    expect(h.added).toEqual([{ path: '/typed', name: 'NAME_DRAFT' }]);
  } finally { await view.cleanup(); }
});

test('an outstanding folder selection cannot submit or discard the form', async () => {
  let resolve: (path: string | null) => void = () => { throw new Error('Picker not started'); };
  let calls = 0;
  const h = fixture(() => {
    calls++;
    return new Promise((yes) => { resolve = yes; });
  });
  const view = await mount(h.element);
  try {
    await click('[data-testid="omo-add-project"]');
    await type('[data-testid="omo-project-path"]', '/typed');
    await type('[data-testid="omo-project-name"]', 'NAME_DRAFT');
    await click('[data-testid="omo-project-choose-folder"]');
    await click('[data-testid="omo-project-choose-folder"]');
    await click('[data-testid="omo-project-save"]');
    expect(calls).toBe(1);
    expect(h.added).toHaveLength(0);
    await act(async () => resolve(null));
    expect(document.querySelector<HTMLInputElement>('[data-testid="omo-project-name"]')?.value).toBe('NAME_DRAFT');
    expect(document.querySelector('[data-testid="omo-project-save"]')?.getAttribute('disabled')).toBeNull();
  } finally { await view.cleanup(); }
});

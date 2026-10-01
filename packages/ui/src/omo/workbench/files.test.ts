import { describe, expect, test } from 'bun:test';
import { createFileWorkspace } from './files';
import { createWorkspaceClient } from './workspace';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const stat = () => Response.json({ path: '/project/qa.txt', isFile: true, size: 3, mtimeMs: 1 });

describe('native file drafts', () => {
  test('a save acknowledges only its captured bytes and preserves newer edits', async () => {
    const write = deferred<Response>();
    const bodies: string[] = [];
    const workspace = createFileWorkspace(createWorkspaceClient('/project', async (path, options) => {
      if (path.endsWith('/stat')) return stat();
      if (path.endsWith('/read')) return new Response('old');
      bodies.push(String(options?.body));
      return write.promise;
    }));
    await workspace.open('/project/qa.txt');
    workspace.edit('/project/qa.txt', 'first');
    const saving = workspace.save('/project/qa.txt');
    expect(workspace.save('/project/qa.txt')).toBe(saving);
    workspace.edit('/project/qa.txt', 'second');
    write.resolve(Response.json({ success: true }));
    await saving;
    expect(bodies).toEqual([JSON.stringify({ path: '/project/qa.txt', content: 'first' })]);
    expect(workspace.getDocument('/project/qa.txt')?.saved).toBe('first');
    expect(workspace.getDocument('/project/qa.txt')?.content).toBe('second');
    expect(workspace.isDirty()).toBe(true);
  });

  test('failed writes leave the draft intact and can be explicitly retried', async () => {
    let fail = true;
    const workspace = createFileWorkspace(createWorkspaceClient('/project', async (path) => {
      if (path.endsWith('/stat')) return stat();
      if (path.endsWith('/read')) return new Response('old');
      return fail ? Response.json({ error: 'denied' }, { status: 403 }) : Response.json({ success: true });
    }));
    await workspace.open('/project/qa.txt');
    workspace.edit('/project/qa.txt', 'draft');
    await expect(workspace.save('/project/qa.txt')).rejects.toThrow();
    expect(workspace.getDocument('/project/qa.txt')).toMatchObject({ content: 'draft', saved: 'old', status: 'ready' });
    fail = false;
    await workspace.save('/project/qa.txt');
    expect(workspace.isDirty()).toBe(false);
  });

  test('slow listing cannot replace newer navigation and failure is not empty success', async () => {
    const old = deferred<Response>();
    let failure = false;
    const workspace = createFileWorkspace(createWorkspaceClient('/project', async (_path, options) => {
      const path = options?.query instanceof URLSearchParams ? options.query.get('path') : options?.query?.path;
      if (path === '/project') return old.promise;
      return failure ? Response.json({ error: 'unavailable' }, { status: 503 })
        : Response.json({ path, entries: [{ name: 'qa.txt', path: `${path}/qa.txt`, isDirectory: false, isFile: true, isSymbolicLink: false }] });
    }));
    const first = workspace.list();
    await workspace.list('/project/src');
    const latest = workspace.getListing();
    old.resolve(Response.json({ path: '/project', entries: [] }));
    await first;
    expect(workspace.getListing()).toBe(latest);
    failure = true;
    await workspace.list();
    expect(workspace.getListing()).toBe(latest);
    expect(workspace.getListingError()).toBeInstanceOf(Error);
  });

  test('opening a second file never transfers a late read or discards the first draft', async () => {
    const late = deferred<Response>();
    const workspace = createFileWorkspace(createWorkspaceClient('/project', async (path, options) => {
      if (path.endsWith('/stat')) return stat();
      const file = options?.query instanceof URLSearchParams ? options.query.get('path') : options?.query?.path;
      return file === '/project/a.txt' ? late.promise : new Response('B');
    }));
    const opening = workspace.open('/project/a.txt');
    await workspace.open('/project/b.txt');
    workspace.edit('/project/b.txt', 'draft B');
    late.resolve(new Response('A'));
    await opening;
    expect(workspace.getSelected()).toBe('/project/b.txt');
    expect(workspace.getDocument('/project/b.txt')?.content).toBe('draft B');
    await workspace.open('/project/a.txt');
    await workspace.open('/project/b.txt');
    expect(workspace.getDocument('/project/b.txt')?.content).toBe('draft B');
  });
});

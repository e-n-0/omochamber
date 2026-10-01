import type { DirectoryListing, WorkspaceClient } from './workspace';

export type FileDocument = {
  path: string;
  content: string;
  saved: string;
  status: 'loading' | 'ready' | 'saving';
  error: Error | null;
};
const errorOf = (cause: unknown) => cause instanceof Error ? cause : new Error('Workspace operation failed', { cause });

/** Owns drafts until the workbench closes, including directory and tab switches. */
export function createFileWorkspace(client: WorkspaceClient) {
  const listeners = new Set<() => void>();
  let listing: DirectoryListing | null = null;
  let listingError: Error | null = null;
  let browsing = client.directory;
  let listingRevision = 0;
  let selected: string | null = null;
  let documents = new Map<string, FileDocument>();
  const loading = new Map<string, Promise<void>>();
  const saves = new Map<string, Promise<void>>();
  const notify = () => listeners.forEach((listener) => listener());
  const update = (document: FileDocument) => {
    documents = new Map(documents).set(document.path, document);
    notify();
  };
  async function list(path = browsing) {
    const revision = ++listingRevision;
    browsing = path;
    try {
      const next = await client.list(path);
      if (revision !== listingRevision) return;
      listing = next;
      listingError = null;
    } catch (cause) {
      if (revision !== listingRevision) return;
      listingError = errorOf(cause);
    }
    notify();
  }
  async function open(path: string) {
    selected = path;
    notify();
    if (documents.get(path)?.status !== 'loading' && documents.has(path)) return;
    if (loading.has(path)) return loading.get(path);
    update({ path, content: '', saved: '', status: 'loading', error: null });
    const pending = (async () => {
      try {
        const content = await client.read(path);
        update({ path, content, saved: content, status: 'ready', error: null });
      } catch (cause) {
        documents = new Map(documents);
        documents.delete(path);
        listingError = errorOf(cause);
        notify();
      } finally { loading.delete(path); }
    })();
    loading.set(path, pending);
    return pending;
  }
  function edit(path: string, content: string) {
    const document = documents.get(path);
    if (!document || document.status === 'loading' || document.content === content) return;
    update({ ...document, content });
  }
  function save(path: string): Promise<void> {
    const pending = saves.get(path);
    if (pending) return pending;
    const document = documents.get(path);
    if (!document || document.status !== 'ready' || document.content === document.saved) return Promise.resolve();
    const content = document.content;
    update({ ...document, status: 'saving', error: null });
    const operation = (async () => {
      try {
        await client.save(path, content);
        const current = documents.get(path);
        if (current) update({ ...current, saved: content, status: 'ready', error: null });
      } catch (cause) {
        const current = documents.get(path);
        if (current) update({ ...current, status: 'ready', error: errorOf(cause) });
        throw cause;
      } finally { saves.delete(path); }
    })();
    saves.set(path, operation);
    return operation;
  }
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getListing: () => listing,
    getListingError: () => listingError,
    getBrowsing: () => browsing,
    getSelected: () => selected,
    getDocument: (path: string | null) => path ? documents.get(path) ?? null : null,
    isDirty: () => [...documents.values()].some((document) => document.content !== document.saved),
    list, open, edit, save,
  };
}
export type FileWorkspace = ReturnType<typeof createFileWorkspace>;

import { z } from 'zod';

type PickerOptions = { readonly defaultPath?: string };
type NotificationInput = { readonly title: string; readonly body?: string };
// Main returns one of these IPC values. Each operation narrows it below.
type NativeDesktopReply = string | null | { readonly supported: boolean };

/** Preload is trusted to expose methods; IPC replies are parsed here. */
export interface NativeDesktopBridge {
  selectFolder(options?: PickerOptions): Promise<NativeDesktopReply>;
  selectFile(options?: PickerOptions): Promise<NativeDesktopReply>;
  openPath(path: string): Promise<NativeDesktopReply>;
  revealPath(path: string): Promise<NativeDesktopReply>;
  notify(input: NotificationInput): Promise<NativeDesktopReply>;
}

export interface NativeDesktopCapabilities {
  selectFolder(options?: PickerOptions): Promise<string | null>;
  selectFile(options?: PickerOptions): Promise<string | null>;
  openPath(path: string): Promise<null>;
  revealPath(path: string): Promise<null>;
  notify(input: NotificationInput): Promise<{ readonly supported: boolean }>;
}

const selectionSchema = z.string().min(1).max(4096).nullable();
const pathResultSchema = z.null();
const notificationResultSchema = z.object({ supported: z.boolean() }).strict();

/** Absence is a capability decision, never an unsupported-runtime stub. */
export function createNativeDesktopCapabilities(bridge: NativeDesktopBridge | undefined): NativeDesktopCapabilities | undefined {
  if (!bridge) return undefined;
  return {
    selectFolder: async (options = {}) => selectionSchema.parse(await bridge.selectFolder(options)),
    selectFile: async (options = {}) => selectionSchema.parse(await bridge.selectFile(options)),
    openPath: async (path) => pathResultSchema.parse(await bridge.openPath(path)),
    revealPath: async (path) => pathResultSchema.parse(await bridge.revealPath(path)),
    notify: async (input) => notificationResultSchema.parse(await bridge.notify(input)),
  };
}

import type express from 'express';
import type { Server } from 'node:http';

/** In-process native lifecycle, also consumed by the local Electron shell. */
export interface NativeServerHandle {
  readonly runtime: 'omo';
  readonly expressApp: ReturnType<typeof express>;
  readonly httpServer: Server;
  readonly getPort: () => number | null;
  readonly isReady: () => boolean;
  /** Idempotent; closes owned HTTP/PTYS and attachments, never retained hosts. */
  readonly stop: () => Promise<void>;
}

export type WebUiServerController = NativeServerHandle;

export interface StartWebUiServerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly dataDir?: string;
  /** Defaults to the web package's dist directory. */
  readonly uiDirectory?: string;
  readonly uiPassword?: string | null;
  readonly runtimeOptions?: {
    readonly omoBinary?: string;
    readonly bunBinary?: string;
    readonly agentDir?: string;
  };
}

export declare function startWebUiServer(options?: StartWebUiServerOptions): Promise<NativeServerHandle>;

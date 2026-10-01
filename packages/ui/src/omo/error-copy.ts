import type { useI18n } from '@/lib/i18n';
import { z } from 'zod';
import { NativeClientError } from './client';
import { NativeStateError } from './state';
import { NativeAppearanceError } from './appearance/state';
import { WorkspaceError } from './workbench/workspace';

/** Translate application failures at render time; native diagnostics stay literal. */
export function nativeErrorCopy(error: Error, t: ReturnType<typeof useI18n>['t']): string {
  if (error instanceof z.ZodError) return t('sessionAuth.error.unexpectedResponse');
  if (error instanceof NativeClientError) {
    switch (error.kind) {
      // A status-less HTTP error carries the native command result verbatim.
      case 'http': return error.status === null ? error.message : t('omo.errors.http', { status: error.status });
      case 'transport': return t('omo.errors.transport');
      case 'invalid-response': return t('sessionAuth.error.unexpectedResponse');
      case 'correlation': return t('omo.errors.correlation');
      case 'stream-ended': return t('omo.errors.streamEnded');
      default: return error.kind satisfies never;
    }
  }
  if (error instanceof NativeStateError) {
    switch (error.kind) {
      case 'not-ready': return t('omo.errors.notReady');
      case 'read-only': return t('omo.chat.readOnly');
      case 'duplicate-request': return t('omo.errors.duplicateRequest');
      case 'stale-interaction': return t('omo.errors.staleInteraction');
      case 'invalid-answer': return t('omo.errors.invalidAnswer');
      default: return error.kind satisfies never;
    }
  }
  if (error instanceof NativeAppearanceError) {
    switch (error.kind) {
      case 'not-ready': return t('omo.errors.settingsNotReady');
      case 'invalid-settings': return t('omo.errors.invalidSettings');
      case 'owner-changed': return t('omo.errors.appearanceOwnerChanged');
      default: return error.kind satisfies never;
    }
  }
  if (error instanceof WorkspaceError) {
    switch (error.code) {
      case 'binary_file': return `${t('filesView.editor.cannotPreviewBinary')}: ${error.message}`;
      case 'file_too_large': return `${t('omo.workbench.fileTooLarge')}: ${error.message}`;
      // The local service's status, code and diagnostic are authoritative.
      default: return `${t('omo.errors.http', { status: error.status })}${error.code ? ` (${error.code})` : ''}: ${error.message}`;
    }
  }
  return error.message;
}

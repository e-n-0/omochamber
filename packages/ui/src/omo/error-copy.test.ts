import { expect, test } from 'bun:test';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import { NativeClientError } from './client';
import { NativeStateError } from './state';
import { NativeAppearanceError } from './appearance/state';
import { WorkspaceError } from './workbench/workspace';
import { nativeErrorCopy } from './error-copy';

test('typed application failures select keys and preserve HTTP status parameters', () => {
  // Given typed failures with arbitrary diagnostic wording.
  const cases = [
    [new NativeClientError('http', 'LOCAL_SENTINEL', 503), 'omo.errors.http'],
    [new NativeClientError('transport', 'LOCAL_SENTINEL'), 'omo.errors.transport'],
    [new NativeClientError('invalid-response', 'LOCAL_SENTINEL'), 'sessionAuth.error.unexpectedResponse'],
    [new NativeClientError('correlation', 'LOCAL_SENTINEL'), 'omo.errors.correlation'],
    [new NativeClientError('stream-ended', 'LOCAL_SENTINEL'), 'omo.errors.streamEnded'],
    [new NativeStateError('not-ready'), 'omo.errors.notReady'],
    [new NativeStateError('read-only'), 'omo.chat.readOnly'],
    [new NativeStateError('duplicate-request'), 'omo.errors.duplicateRequest'],
    [new NativeStateError('stale-interaction'), 'omo.errors.staleInteraction'],
    [new NativeStateError('invalid-answer'), 'omo.errors.invalidAnswer'],
    [new NativeAppearanceError('not-ready'), 'omo.errors.settingsNotReady'],
    [new NativeAppearanceError('invalid-settings'), 'omo.errors.invalidSettings'],
    [new NativeAppearanceError('owner-changed'), 'omo.errors.appearanceOwnerChanged'],
  ] as const;
  for (const [error, key] of cases) {
    const calls: { key: I18nKey; params?: I18nParams }[] = [];
    // When the rendering boundary translates the failure.
    nativeErrorCopy(error, (key, params) => { calls.push({ key, params }); return 'TRANSLATED'; });
    // Then routing depends on typed fields, not diagnostic wording.
    expect(calls).toEqual([{ key, params: error instanceof NativeClientError && error.kind === 'http' ? { status: 503 } : undefined }]);
  }
});

test('native and unknown diagnostics stay literal while local file errors retain paths', () => {
  // Given authoritative native diagnostics and a literal file path.
  const native = new NativeClientError('http', 'NATIVE_RESULT_SENTINEL');
  const unknown = new Error('NATIVE_UNKNOWN_SENTINEL');
  const calls: I18nKey[] = [];
  const translate = (key: I18nKey) => { calls.push(key); return 'TRANSLATED'; };
  // When each rendering boundary formats them.
  const results = [
    nativeErrorCopy(native, translate),
    nativeErrorCopy(unknown, translate),
    nativeErrorCopy(new WorkspaceError(415, 'binary_file', '/workspace/native.bin'), translate),
    nativeErrorCopy(new WorkspaceError(413, 'file_too_large', '/workspace/native.txt'), translate),
    nativeErrorCopy(new WorkspaceError(409, 'native_code', 'NATIVE_SERVICE_SENTINEL'), translate),
  ];
  // Then native content is unchanged and file diagnostics keep their exact data.
  expect(results).toEqual([
    'NATIVE_RESULT_SENTINEL', 'NATIVE_UNKNOWN_SENTINEL',
    'TRANSLATED: /workspace/native.bin', 'TRANSLATED: /workspace/native.txt',
    'TRANSLATED (native_code): NATIVE_SERVICE_SENTINEL',
  ]);
  expect(calls).toEqual(['filesView.editor.cannotPreviewBinary', 'omo.workbench.fileTooLarge', 'omo.errors.http']);
});

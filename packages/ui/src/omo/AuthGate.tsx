import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import type { RuntimeFetchOptions } from '@/lib/runtime-fetch';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { NativeClientError } from './client';
import { nativeErrorCopy } from './error-copy';

const authSchema = z.object({ authenticated: z.boolean(), disabled: z.boolean().optional(), locked: z.boolean().optional() });

export function AuthGate({ children, fetchSession = runtimeFetch }: {
  readonly children: ReactNode;
  readonly fetchSession?: (path: string, options?: RuntimeFetchOptions) => Promise<Response>;
}) {
  const { t } = useI18n();
  const expired = useAuthSessionStore((state) => state.state === 'expired');
  const [status, setStatus] = useState<'checking' | 'locked' | 'ready' | 'unavailable'>('checking');
  const [error, setError] = useState<Error | null>(null);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const submittingRef = useRef(false);
  const checkGeneration = useRef(0);
  useEffect(() => {
    if (expired && status === 'ready') {
      setStatus('locked');
      setPassword('');
    }
  }, [expired, status]);
  useEffect(() => {
    const abort = new AbortController();
    const generation = ++checkGeneration.current;
    setStatus('checking');
    setError(null);
    void (async () => {
      try {
        const response = await fetchSession('/auth/session', {
          credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
        });
        if (response.status === 401) {
          await response.body?.cancel();
          if (!abort.signal.aborted && checkGeneration.current === generation) setStatus('locked');
          return;
        }
        if (!response.ok) throw new NativeClientError('http', `Native authentication returned ${response.status}`, response.status);
        const session = authSchema.parse(await response.json());
        if (!abort.signal.aborted && checkGeneration.current === generation) {
          if (session.authenticated) useAuthSessionStore.getState().markAuthenticated();
          setStatus(session.authenticated ? 'ready' : 'locked');
        }
      } catch (cause) {
        if (abort.signal.aborted || checkGeneration.current !== generation) return;
        setError(cause instanceof NativeClientError ? cause : new NativeClientError(
          cause instanceof z.ZodError || cause instanceof SyntaxError ? 'invalid-response' : 'transport',
          'Native authentication failed', null, { cause },
        ));
        setStatus('unavailable');
      }
    })();
    return () => abort.abort();
  }, [fetchSession, attempt]);
  const unlock = async () => {
    if (!password || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetchSession('/auth/session', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
      });
      setPassword('');
      if (!response.ok) {
        await response.body?.cancel();
        throw new NativeClientError('http', `Native authentication returned ${response.status}`, response.status);
      }
      const session = authSchema.parse(await response.json());
      if (!session.authenticated) throw new NativeClientError('invalid-response', 'Native authentication was not confirmed');
      useAuthSessionStore.getState().markAuthenticated();
      setStatus('ready');
    } catch (cause) {
      setError(cause instanceof NativeClientError ? cause : new NativeClientError(
        cause instanceof z.ZodError || cause instanceof SyntaxError ? 'invalid-response' : 'transport',
        'Native login failed', null, { cause },
      ));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };
  if (status === 'ready') return children;
  return <main className="grid h-dvh place-items-center bg-background p-6 text-foreground" data-testid="omo-auth-gate">
    <section className="w-full max-w-sm space-y-4">
      <h1 className="typography-settings-page-title">OmoChamber</h1>
      {status === 'checking' ? <p role="status">{t('common.loading')}</p> : <>
        <p className="typography-meta text-muted-foreground">{t(status === 'locked'
          ? 'sessionAuth.locked.passwordDescription' : 'sessionAuth.error.networkTitle')}</p>
        {status === 'locked' && <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void unlock(); }}>
          <Input type="password" autoFocus autoComplete="current-password" maxLength={4096} value={password}
            onChange={(event) => setPassword(event.currentTarget.value)} disabled={submitting}
            aria-label={t('sessionAuth.password.placeholder')} placeholder={t('sessionAuth.password.placeholder')} data-testid="omo-auth-password" />
          <Button type="submit" className="w-full" disabled={submitting || !password} data-testid="omo-auth-unlock">
            {t(submitting ? 'sessionAuth.actions.unlockingAria' : 'sessionAuth.actions.unlockAria')}
          </Button>
        </form>}
        {error && <p role="alert" className="break-words typography-meta text-[var(--status-error-text)]">
          {error instanceof NativeClientError && error.kind === 'http' && error.status === 401
            ? t('sessionAuth.error.incorrectPassword') : nativeErrorCopy(error, t)}
        </p>}
        {status === 'unavailable' && <Button variant="outline" onClick={() => setAttempt(attempt + 1)}>{t('sessionAuth.error.retry')}</Button>}
      </>}
    </section>
  </main>;
}

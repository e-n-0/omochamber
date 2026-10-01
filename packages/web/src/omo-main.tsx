import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider, initializeLocale } from '@openchamber/ui/lib/i18n';
import { OmoApp } from '@openchamber/ui/omo/OmoApp';
import { NativeDesktopContext } from '@openchamber/ui/omo/desktop/context';
import { initializeNativeDesktopCapability, initializeNativeWebRuntime } from './omo-runtime';
import '@openchamber/ui/index.css';
import '@openchamber/ui/styles/fonts';
import '@openchamber/ui/styles/katex-css';

const client = initializeNativeWebRuntime();
const desktop = initializeNativeDesktopCapability();
initializeLocale();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found');

const root = createRoot(rootElement);
root.render(
  <StrictMode>
    <I18nProvider>
      <NativeDesktopContext.Provider value={desktop}>
        <OmoApp client={client} />
      </NativeDesktopContext.Provider>
    </I18nProvider>
  </StrictMode>,
);

if (import.meta.hot) {
  import.meta.hot.dispose(() => root.unmount());
}

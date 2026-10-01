import { setRuntimeBearerToken, setRuntimeExtraHeaders } from '@openchamber/ui/lib/runtime-auth';
import { initializeRuntimeEndpoint } from '@openchamber/ui/lib/runtime-switch';
import { configureRuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';
import { createNativeClient } from '@openchamber/ui/omo/client';
import { createNativeDesktopCapabilities, type NativeDesktopBridge } from '@openchamber/ui/omo/desktop/adapter';

declare global {
  interface Window {
    readonly __OMOCHAMBER_DESKTOP__?: NativeDesktopBridge;
  }
}

/** The trusted preload is optional; no legacy RuntimeAPIs composition is mounted. */
export function initializeNativeDesktopCapability() {
  return createNativeDesktopCapabilities(window.__OMOCHAMBER_DESKTOP__);
}

/** Browser requests stay same-origin; the local Electron preload supplies its backend. */
export function initializeNativeWebRuntime() {
  const apiBaseUrl = window.__OPENCHAMBER_API_BASE_URL__?.trim() || window.location.origin;
  // Packaged HTTP stays on the UI scheme; native WebSockets need the owned
  // loopback listener, which already accepts the packaged client origin.
  const realtimeBaseUrl = window.location.protocol === 'openchamber-ui:'
    ? window.__OPENCHAMBER_LOCAL_ORIGIN__?.trim() || apiBaseUrl : apiBaseUrl;
  configureRuntimeUrlResolver({ apiBaseUrl, realtimeBaseUrl });
  initializeRuntimeEndpoint({ apiBaseUrl, runtimeKey: apiBaseUrl });
  setRuntimeBearerToken(window.__OPENCHAMBER_CLIENT_TOKEN__ || null);
  setRuntimeExtraHeaders(null);
  return createNativeClient();
}

// Native-only public URL boundary. Ordinary web builds preserve same-origin behavior.
export function publicWebOrigin(): string {
  const runtime = globalThis as any;
  if (!runtime.Capacitor?.isNativePlatform?.()) return window.location.origin;
  const host = String(runtime.SitonNativeConfig?.linkHost || '');
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) || host.endsWith('.invalid')) {
    throw new Error('MOBILE_PUBLIC_HOST_NOT_CONFIGURED');
  }
  return 'https://' + host;
}

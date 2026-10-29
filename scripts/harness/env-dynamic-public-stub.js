// $env/dynamic/public stub for the QA harness — the harness runs in a browser
// without SvelteKit's env module, so PUBLIC_STREAM_PROXY_URL is empty (the
// harness tests the PlayerShell UI, not the proxy routing).
export const env = {
  PUBLIC_STREAM_PROXY_URL: '',
};

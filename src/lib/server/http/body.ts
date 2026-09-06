export const DEFAULT_MAX_JSON_BYTES = 256 * 1024;

export type JsonBodyResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 413; message: string };

export async function readJsonBody<T>(request: Request, maxBytes = DEFAULT_MAX_JSON_BYTES): Promise<JsonBodyResult<T>> {
  const contentLength = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { ok: false, status: 413, message: 'The request body is too large.' };
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { ok: false, status: 400, message: 'The request body could not be read.' };
  }

  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    return { ok: false, status: 413, message: 'The request body is too large.' };
  }

  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch {
    return { ok: false, status: 400, message: 'The request body must be valid JSON.' };
  }
}

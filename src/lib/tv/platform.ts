export type TizenKeyRegistrationResult = {
  requested: string[];
  registered: string[];
  available: boolean;
};

type TizenApplication = {
  getCurrentApplication?: () => {
    exit?: () => void;
  };
};

type TizenInputDevice = {
  getSupportedKeys?: () => Array<{ name?: string }>;
  registerKey?: (keyName: string) => void;
  registerKeyBatch?: (keyNames: string[]) => void;
};

type TizenGlobal = {
  application?: TizenApplication;
  tvinputdevice?: TizenInputDevice;
};

export type ExitApplicationResult =
  | { ok: true; reason: 'exited' }
  | { ok: false; reason: 'unavailable' | 'failed'; error?: unknown };

function getTizen(): TizenGlobal | null {
  if (typeof globalThis === 'undefined') return null;

  const candidate = (globalThis as typeof globalThis & { tizen?: unknown }).tizen;
  if (!candidate || typeof candidate !== 'object') return null;

  return candidate as TizenGlobal;
}

export function isTizen(): boolean {
  return getTizen() !== null;
}

export function hasTizenApplicationAPI(): boolean {
  const application = getTizen()?.application;
  return typeof application?.getCurrentApplication === 'function';
}

export function canExitApplication(): boolean {
  if (!hasTizenApplicationAPI()) return false;

  try {
    return typeof getTizen()?.application?.getCurrentApplication?.()?.exit === 'function';
  } catch {
    return false;
  }
}

export function exitApplication(): ExitApplicationResult {
  if (!canExitApplication()) return { ok: false, reason: 'unavailable' };

  try {
    getTizen()?.application?.getCurrentApplication?.()?.exit?.();
    return { ok: true, reason: 'exited' };
  } catch (error) {
    return { ok: false, reason: 'failed', error };
  }
}

export function registerRemoteKeys(keys: string[]): TizenKeyRegistrationResult {
  const requested = [...new Set(keys)];
  const inputDevice = getTizen()?.tvinputdevice;

  if (!inputDevice) {
    return { requested, registered: [], available: false };
  }

  let supported = requested;
  try {
    const supportedKeys = inputDevice.getSupportedKeys?.() ?? [];
    if (supportedKeys.length) {
      const supportedNames = new Set(supportedKeys.map((key) => key.name).filter(Boolean));
      supported = requested.filter((key) => supportedNames.has(key));
    }

    if (supported.length && typeof inputDevice.registerKeyBatch === 'function') {
      inputDevice.registerKeyBatch(supported);
    } else if (typeof inputDevice.registerKey === 'function') {
      supported.forEach((key) => inputDevice.registerKey?.(key));
    }

    return { requested, registered: supported, available: true };
  } catch {
    return { requested, registered: [], available: true };
  }
}

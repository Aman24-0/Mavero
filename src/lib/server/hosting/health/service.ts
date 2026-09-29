/**
 * Phase 10 — Provider health service.
 *
 * Checks provider configuration, authentication, and lightweight API
 * availability. Reports health status + quota information where
 * available. Does NOT perform expensive operations (no uploads, no
 * listing all files).
 *
 * Health states:
 *   healthy     — provider responds to a lightweight authenticated request
 *   degraded    — provider responds but has issues (rate limit, quota near limit)
 *   unavailable — provider does not respond (network error, timeout)
 *   misconfigured — credentials or configuration is missing/invalid
 *   unknown     — cannot determine (e.g. adapter not found)
 *
 * SECURITY: no credentials are exposed. Health responses contain only
 * safe metadata (status, latency, quota if available, config state).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';
import { getHostingAdapter } from '../registry';
import { getVidaraConfigOrNull } from '../vidara/config';
import { getAbyssConfigOrNull } from '../abyss/config';
import { HostingProviderError, asHostingError } from '../errors';

export type ProviderHealthStatus = 'healthy' | 'degraded' | 'unavailable' | 'misconfigured' | 'unknown';

export type ProviderHealthReport = {
  providerAdapterId: string;
  status: ProviderHealthStatus;
  configured: boolean;
  latencyMs: number | null;
  quota: ProviderQuotaInfo | null;
  lastError: string | null;
  checkedAt: string;
};

export type ProviderQuotaInfo = {
  storageUsed: number | null;
  storageLimit: number | null;
  maxUploadSize: number | null;
  /** 'available' = quota reported, 'unknown' = quota not available from API, 'unavailable' = provider unreachable */
  availability: 'available' | 'unknown' | 'unavailable';
};

export type HealthCheckResult = {
  reports: ProviderHealthReport[];
  overallStatus: ProviderHealthStatus;
};

export class ProviderHealthService {
  constructor(private client: SupabaseClient<Database>) {}

  async checkProvider(adapterId: string): Promise<ProviderHealthReport> {
    const checkedAt = new Date().toISOString();

    // Check configuration.
    if (adapterId === 'vidara') {
      const config = getVidaraConfigOrNull();
      if (!config) {
        return { providerAdapterId: adapterId, status: 'misconfigured', configured: false, latencyMs: null, quota: null, lastError: 'VIDARA_API_KEY is not configured.', checkedAt };
      }
      return this.checkVidaraHealth(config.apiKey, config.baseUrl, checkedAt);
    }

    if (adapterId === 'abyss') {
      const config = getAbyssConfigOrNull();
      if (!config) {
        return { providerAdapterId: adapterId, status: 'misconfigured', configured: false, latencyMs: null, quota: null, lastError: 'ABYSS_EMAIL / ABYSS_PASSWORD are not configured.', checkedAt };
      }
      return this.checkAbyssHealth(config.baseUrl, config.email, config.password, config.apiKey, checkedAt);
    }

    return { providerAdapterId: adapterId, status: 'unknown', configured: false, latencyMs: null, quota: null, lastError: `Unknown adapter: ${adapterId}`, checkedAt };
  }

  async checkAll(): Promise<HealthCheckResult> {
    const reports: ProviderHealthReport[] = [];
    for (const adapterId of ['vidara', 'abyss'] as const) {
      try {
        reports.push(await this.checkProvider(adapterId));
      } catch (error) {
        reports.push({
          providerAdapterId: adapterId,
          status: 'unavailable',
          configured: true,
          latencyMs: null,
          quota: null,
          lastError: asHostingError(error).message,
          checkedAt: new Date().toISOString(),
        });
      }
    }

    const overallStatus = this.deriveOverallStatus(reports);
    return { reports, overallStatus };
  }

  private deriveOverallStatus(reports: ProviderHealthReport[]): ProviderHealthStatus {
    if (reports.every((r) => r.status === 'healthy')) return 'healthy';
    if (reports.some((r) => r.status === 'unavailable' || r.status === 'misconfigured')) return 'degraded';
    if (reports.some((r) => r.status === 'degraded')) return 'degraded';
    return 'unknown';
  }

  private async checkVidaraHealth(apiKey: string, baseUrl: string, checkedAt: string): Promise<ProviderHealthReport> {
    const adapter = getHostingAdapter('vidara');
    if (!adapter) {
      return { providerAdapterId: 'vidara', status: 'misconfigured', configured: true, latencyMs: null, quota: null, lastError: 'VidaraAdapter not instantiated.', checkedAt };
    }

    const startTime = Date.now();
    try {
      // Use listAssets(null) as a lightweight health check — it calls
      // GET /v1/video/list?api_key=<key> which is the verified working
      // endpoint. If it returns, the provider is healthy.
      // Do NOT use getAccountInfo (/v1/account/info returns 404 on
      // the current Vidara API).
      await adapter.listAssets(null);
      const latencyMs = Date.now() - startTime;

      // Vidara does not expose quota info via /v1/video/list — report unknown.
      return {
        providerAdapterId: 'vidara',
        status: 'healthy',
        configured: true,
        latencyMs,
        quota: { storageUsed: null, storageLimit: null, maxUploadSize: null, availability: 'unknown' },
        lastError: null,
        checkedAt,
      };
    } catch (error) {
      const err = asHostingError(error);
      const latencyMs = Date.now() - startTime;
      const status: ProviderHealthStatus =
        err.code === 'AUTHENTICATION' ? 'misconfigured' :
        err.code === 'RATE_LIMITED' ? 'degraded' :
        err.code === 'TIMEOUT' || err.code === 'NETWORK' ? 'unavailable' :
        err.code === 'TRANSIENT' ? 'degraded' :
        'unavailable';

      return {
        providerAdapterId: 'vidara',
        status,
        configured: true,
        latencyMs,
        quota: { storageUsed: null, storageLimit: null, maxUploadSize: null, availability: 'unavailable' },
        lastError: err.message,
        checkedAt,
      };
    }
  }

  private async checkAbyssHealth(baseUrl: string, email: string, password: string, apiKey: string | null, checkedAt: string): Promise<ProviderHealthReport> {
    const adapter = getHostingAdapter('abyss');
    if (!adapter) {
      return { providerAdapterId: 'abyss', status: 'misconfigured', configured: true, latencyMs: null, quota: null, lastError: 'AbyssAdapter not instantiated.', checkedAt };
    }

    const startTime = Date.now();
    try {
      // Use getAccountInfo (/v1/about) as a health check — it returns
      // quota info including maxUploadSize, storageQuota, uploadQuota.
      const account = await adapter.getAccountInfo();
      const latencyMs = Date.now() - startTime;

      const quota: ProviderQuotaInfo = {
        storageUsed: account.storageUsed,
        storageLimit: account.storageTotal,
        maxUploadSize: null, // Abyss /v1/about reports maxUploadSize but normalizeAbyssAccount may not extract it
        availability: 'available',
      };

      // Check if Abyss upload is possible (apiKey configured).
      const status: ProviderHealthStatus = apiKey ? 'healthy' : 'degraded';
      const lastError = apiKey ? null : 'ABYSS_API_KEY is not configured. Upload is not available.';

      return {
        providerAdapterId: 'abyss',
        status,
        configured: true,
        latencyMs,
        quota,
        lastError,
        checkedAt,
      };
    } catch (error) {
      const err = asHostingError(error);
      const latencyMs = Date.now() - startTime;
      const status: ProviderHealthStatus =
        err.code === 'AUTHENTICATION' ? 'misconfigured' :
        err.code === 'RATE_LIMITED' ? 'degraded' :
        err.code === 'TIMEOUT' || err.code === 'NETWORK' ? 'unavailable' :
        err.code === 'TRANSIENT' ? 'degraded' :
        'unavailable';

      return {
        providerAdapterId: 'abyss',
        status,
        configured: true,
        latencyMs,
        quota: { storageUsed: null, storageLimit: null, maxUploadSize: null, availability: 'unavailable' },
        lastError: err.message,
        checkedAt,
      };
    }
  }
}

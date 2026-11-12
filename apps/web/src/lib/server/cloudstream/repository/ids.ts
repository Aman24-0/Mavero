/**
 * MAVERO CloudStream repository manager — id validation (CS-1).
 *
 * Mirrors the streaming_addons UUID contract (`assertAddonId`): every
 * client-supplied repository/extension id is UUID-checked before it ever
 * reaches a query. Purely lexical — never a network operation.
 */

import { CloudStreamRepositoryError } from './errors';

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates a CloudStream repository or extension id against the UUID contract. */
export function validateCloudStreamId(id: unknown, label: 'Repository' | 'Extension'): string {
  if (typeof id !== 'string' || !ID_PATTERN.test(id.trim())) {
    throw new CloudStreamRepositoryError('INVALID_ID', { message: `${label} id is invalid.` });
  }
  return id.trim();
}

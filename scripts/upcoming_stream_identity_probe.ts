// Stream-identity probe: prints the digest for a FIXED identity-entry
// list passed as argv[2] (a JSON string array).
//
// Spawned by scripts/upcoming_stream_identity_test.ts as a SEPARATE
// node process to prove the digest is stable across processes — the
// cursor contract requires a stream hashed by one server instance to
// validate on another (pure string hashing: no randomness, no clock,
// no hidden module state).
import { computeStreamId } from '../src/lib/server/content/upcoming-cursor.ts';

const entries: string[] = JSON.parse(process.argv[2] ?? '[]');
process.stdout.write(computeStreamId(entries));

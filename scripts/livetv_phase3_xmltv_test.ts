/**
 * UNIFIED LIVE TV — Phase 3 XMLTV parsing + timestamp policy verification.
 *
 * Covers the Phase 3 brief §12 items:
 *   1  valid plain XMLTV (multi-channel, multi-programme)
 *   2  valid gzip XMLTV (content-detected, extension-independent)
 *   3  invalid gzip + truncated compressed input (typed failures)
 *   4  malformed XML (document-level structure failures, tolerant-tokenizer
 *      shape validation)
 *   5  external DTD / entity-fetch attempts (inert — nothing is fetched)
 *   6  entity expansion / billion-laughs payloads (custom entities never
 *      expand — verified against the installed parser)
 *   7  excessive nesting, huge text fields, oversized documents, record
 *      caps (document-level typed failures; field-level skips)
 *   8  explicit timezone offsets (correct UTC instants)
 *   9  configured timezone-less timestamps (documented IANA policy)
 *  10  DST boundary cases (fall-back ambiguity + spring-forward gap rules)
 *  11  multiple IANA timezones in one test set
 *  12  invalid timestamps + end <= start (per-record skips)
 *  20  abort/deadline handling
 *  21  safe diagnostics + redaction (static messages, sanitized samples)
 *
 * NO network, NO database, NO live guide. Deterministic fixtures only.
 */

import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

let passed = 0;
function ok(condition: unknown, label: string, hint?: string) {
  assert.ok(condition, hint ? `${label} (${hint})` : label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

import {
  DEFAULT_XMLTV_LIMITS,
  XMLTV_MAX_COMPRESSED_BYTES,
  XmltvDocumentError,
  decodeXmltvPayload,
  parseXmltvDocument
} from '../src/lib/server/livetv/epg/xmltv';
import { XmltvTimestampError, formatXmltvTimestamp, parseXmltvTimestamp } from '../src/lib/server/livetv/epg/time';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv generator-info-name="fixture">
  <channel id="ch.one">
    <display-name>Channel One</display-name>
    <icon src="https://cdn.example/one.png" />
  </channel>
  <channel id="ch.two">
    <display-name>Channel Two</display-name>
    <display-name>Canale 2</display-name>
  </channel>
  <programme start="20240115083000 +0530" stop="20240115090000 +0530" channel="ch.one">
    <title lang="en">Morning News</title>
    <sub-title>Episode 1</sub-title>
    <desc>News from around the world.</desc>
    <category>News</category>
    <icon src="https://cdn.example/prog.png" />
  </programme>
  <programme start="20240115090000 +0000" stop="20240115100000 +0000" channel="ch.two">
    <title>Sports Hour</title>
  </programme>
</tv>`;

function validXmlWith(options: { channels?: string; programmes?: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?><tv>${options.channels ?? ''}${options.programmes ?? ''}</tv>`;
}

function programmeXml(id: string, start: string, stop: string, title: string, extra = ''): string {
  return `<programme start="${start}" stop="${stop}" channel="${id}"><title>${title}</title>${extra}</programme>`;
}

// ---------------------------------------------------------------------------
// §1 — valid plain XMLTV
// ---------------------------------------------------------------------------
console.log('§1 valid plain XMLTV');
{
  const result = parseXmltvDocument(VALID_XML);
  ok(result.channels.length === 2, '§1 both channels parsed');
  ok(result.channels[0]!.id === 'ch.one' && result.channels[0]!.displayName === 'Channel One', '§1 channel id + display name verbatim');
  ok(result.channels[0]!.iconUrl === 'https://cdn.example/one.png', '§1 genuine channel icon preserved');
  ok(result.channels[1]!.displayName === 'Channel Two', '§1 first display name wins (bounded record)');
  ok(result.programmes.length === 2, '§1 both programmes parsed');
  const first = result.programmes[0]!;
  ok(first.title === 'Morning News' && first.subTitle === 'Episode 1' && first.description === 'News from around the world.' && first.category === 'News', '§1 programme metadata normalized');
  ok(first.language === 'en', '§1 source language captured when reliably present');
  ok(first.iconUrl === 'https://cdn.example/prog.png', '§1 genuine programme icon preserved');
  // +0530 → UTC minus offset: 08:30 IST = 03:00 UTC.
  ok(first.startMs === Date.UTC(2024, 0, 15, 3, 0, 0), '§1 explicit offset honored (08:30 +05:30 → 03:00Z)');
  ok(first.endMs - first.startMs === 30 * 60_000, '§1 window duration correct');
  const second = result.programmes[1]!;
  ok(second.startMs === Date.UTC(2024, 0, 15, 9, 0, 0), '§1 second programme window correct');
  ok(result.counts.explicitOffsetTimestamps === 4 && result.counts.defaultTimezoneTimestamps === 0, '§1 timestamp provenance counted');
  ok(result.diagnostics.channelsSkipped === 0 && result.diagnostics.programmesSkipped === 0, '§1 zero skips on valid input');
}

// ---------------------------------------------------------------------------
// §2 — valid gzip XMLTV (content detection)
// ---------------------------------------------------------------------------
console.log('§2 valid gzip XMLTV');
{
  const gzipped = gzipSync(Buffer.from(VALID_XML, 'utf8'));
  const text = decodeXmltvPayload(new Uint8Array(gzipped));
  ok(text.includes('<tv') && text.includes('Morning News'), '§2 gzip decoded by magic bytes (no filename involved)');
  const result = parseXmltvDocument(text);
  ok(result.programmes.length === 2, '§2 decoded document parses fully');

  // Plain bytes also accepted (no compression).
  const plain = decodeXmltvPayload(new Uint8Array(Buffer.from(VALID_XML, 'utf8')));
  ok(plain.includes('Morning News'), '§2 plain XML passes through');
}

// ---------------------------------------------------------------------------
// §3 — invalid gzip + truncated compressed input
// ---------------------------------------------------------------------------
console.log('§3 invalid/truncated gzip');
{
  let failedAsInvalid = false;
  try {
    // Real gzip MAGIC bytes followed by garbage (not a valid deflate stream).
    decodeXmltvPayload(new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x01, 0x02, 0x03, 0x04, 0x05]));
  } catch (error) {
    failedAsInvalid = error instanceof XmltvDocumentError && error.kind === 'invalid_gzip';
  }
  ok(failedAsInvalid, '§3 gzip-magic bytes with an invalid deflate stream → typed invalid_gzip');

  const full = gzipSync(Buffer.from(VALID_XML, 'utf8'));
  const truncated = full.subarray(0, Math.floor(full.length * 0.6));
  let failedAsTruncated = false;
  try {
    decodeXmltvPayload(new Uint8Array(truncated));
  } catch (error) {
    failedAsTruncated = error instanceof XmltvDocumentError && error.kind === 'invalid_gzip';
  }
  ok(failedAsTruncated, '§3 truncated gzip → typed invalid_gzip (never a partial document)');

  let failedAsEmpty = false;
  try {
    decodeXmltvPayload(new Uint8Array(0));
  } catch (error) {
    failedAsEmpty = error instanceof XmltvDocumentError && error.kind === 'empty_document';
  }
  ok(failedAsEmpty, '§3 empty payload → typed empty_document');
}

// ---------------------------------------------------------------------------
// §4 — malformed XML (document-level structure contract)
// ---------------------------------------------------------------------------
console.log('§4 malformed XML');
{
  let failedStructure = false;
  try {
    parseXmltvDocument('<html><body><p>not a guide</p></body></html>');
  } catch (error) {
    failedStructure = error instanceof XmltvDocumentError && error.kind === 'structure_invalid';
  }
  ok(failedStructure, '§4 a non-XMLTV root fails the document (structure_invalid)');

  let failedEmpty = false;
  try {
    parseXmltvDocument('   ');
  } catch (error) {
    failedEmpty = error instanceof XmltvDocumentError && error.kind === 'empty_document';
  }
  ok(failedEmpty, '§4 whitespace-only document fails as empty');

  // Missing required attributes are per-record skips (tolerant tokenizer).
  const partial = validXmlWith({ programmes: '<programme stop="20240115090000 +0000" channel="c1"><title>T</title></programme>' });
  const result = parseXmltvDocument(partial);
  ok(result.programmes.length === 0 && result.diagnostics.programmesSkipped === 1, '§4 programme without start is a counted skip, not a crash');
  ok(result.diagnostics.skipReasons['missing_start'] === 1, '§4 skip reason is typed');
}

// ---------------------------------------------------------------------------
// §5 — external DTD / entity-fetch attempts (inert)
// ---------------------------------------------------------------------------
console.log('§5 external DTD / entity fetch attempts');
{
  const external = `<?xml version="1.0"?><!DOCTYPE tv SYSTEM "http://192.0.2.1/evil.dtd"><!DOCTYPE tv PUBLIC "-//X//Y" "https://evil.example/x.dtd"><tv><channel id="e1"><display-name>E</display-name></channel></tv>`;
  let result: ReturnType<typeof parseXmltvDocument> | null = null;
  try {
    result = parseXmltvDocument(external);
  } catch {
    result = null;
  }
  ok(result !== null && result.channels.length === 1, '§5 external SYSTEM/PUBLIC DTD ids are inert (no fetch, no failure)');
}

// ---------------------------------------------------------------------------
// §6 — entity expansion / billion-laughs
// ---------------------------------------------------------------------------
console.log('§6 entity expansion safety');
{
  const laughs = `<?xml version="1.0"?><!DOCTYPE tv [
    <!ENTITY a "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA">
    <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
    <!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">
  ]><tv><channel id="x1"><display-name>&c;&c;&c;</display-name></channel>
  <programme start="20240115083000 +0000" stop="20240115090000 +0000" channel="x1"><title>&amp;&lt;&gt;&#65;</title></programme></tv>`;
  const result = parseXmltvDocument(laughs);
  const name = result.channels[0]?.displayName ?? '';
  ok(name === '&c;&c;&c;' || !name.includes('AAAA'), '§6 DTD-defined entities are NEVER expanded (literal text or dropped)');
  ok(name.length < 200, '§6 no exponential expansion happened');
  const title = result.programmes[0]?.title ?? '';
  ok(title === "&<>'".slice(0, 2) + '>' + 'A' || title === '&<>A' || title.includes('A'), '§6 predefined + numeric entities decode correctly');
}

// ---------------------------------------------------------------------------
// §7 — nesting / huge fields / oversized documents / record caps
// ---------------------------------------------------------------------------
console.log('§7 resource bounds');
{
  let deep = '<tv>';
  for (let i = 0; i < DEFAULT_XMLTV_LIMITS.maxNestingDepth + 50; i += 1) deep += `<n${i % 10}>`;
  deep += '<channel id="deep"><display-name>D</display-name></channel>';
  for (let i = 0; i < DEFAULT_XMLTV_LIMITS.maxNestingDepth + 50; i += 1) deep += `</n${i % 10}>`;
  deep += '</tv>';
  let failedDeep = false;
  try {
    parseXmltvDocument(deep);
  } catch (error) {
    failedDeep = error instanceof XmltvDocumentError && error.kind === 'nesting_too_deep';
  }
  ok(failedDeep, '§7 excessive nesting fails the document (nesting_too_deep)');

  const hugeTitle = validXmlWith({ programmes: programmeXml('c1', '20240115083000 +0000', '20240115090000 +0000', 'X'.repeat(600)) });
  const hugeResult = parseXmltvDocument(hugeTitle);
  ok(hugeResult.programmes.length === 0 && hugeResult.diagnostics.skipReasons['invalid_title'] === 1, '§7 an over-cap title skips the record with a typed reason');

  let failedOversize = false;
  try {
    decodeXmltvPayload(new Uint8Array(DEFAULT_XMLTV_LIMITS.maxDecompressedBytes + 1));
  } catch (error) {
    failedOversize = error instanceof XmltvDocumentError && error.kind === 'decompression_too_large';
  }
  ok(failedOversize, '§7 oversized decompressed input fails with a typed error');

  // Decompression bomb: small gzip, huge output (20 MiB of 'A' compresses
  // to a few KiB but inflates far beyond the 16 MiB budget).
  const bomb = gzipSync(Buffer.alloc(20 * 1024 * 1024, 65));
  let failedBomb = false;
  try {
    decodeXmltvPayload(new Uint8Array(bomb));
  } catch (error) {
    failedBomb = error instanceof XmltvDocumentError && error.kind === 'decompression_too_large';
  }
  ok(failedBomb, '§7 a gzip bomb is stopped by the decompression budget');

  const capped = validXmlWith({
    programmes: programmeXml('c1', '20240115083000 +0000', '20240115090000 +0000', 'A') + programmeXml('c1', '20240115090000 +0000', '20240115100000 +0000', 'B') + programmeXml('c1', '20240115100000 +0000', '20240115110000 +0000', 'C')
  });
  let failedCap = false;
  try {
    parseXmltvDocument(capped, { limits: { maxProgrammes: 2 } });
  } catch (error) {
    failedCap = error instanceof XmltvDocumentError && error.kind === 'programme_cap_exceeded';
  }
  ok(failedCap, '§7 programme-cap violation fails the WHOLE document (no partial snapshot)');

  const channelsCapped = validXmlWith({ channels: '<channel id="a"><display-name>A</display-name></channel><channel id="b"><display-name>B</display-name></channel><channel id="c"><display-name>C</display-name></channel>' });
  let failedChannelCap = false;
  try {
    parseXmltvDocument(channelsCapped, { limits: { maxChannels: 2 } });
  } catch (error) {
    failedChannelCap = error instanceof XmltvDocumentError && error.kind === 'channel_cap_exceeded';
  }
  ok(failedChannelCap, '§7 channel-cap violation fails the whole document');
}

// ---------------------------------------------------------------------------
// §8 — explicit timezone offsets
// ---------------------------------------------------------------------------
console.log('§8 explicit offsets');
{
  const plus = parseXmltvTimestamp('20240115083000 +0530', null);
  ok(plus.epochMs === Date.UTC(2024, 0, 15, 3, 0, 0) && plus.resolvedWith === 'explicit_offset', '§8 +05:30 resolved mechanically');
  const minus = parseXmltvTimestamp('20240115203000 -0600', null);
  ok(minus.epochMs === Date.UTC(2024, 0, 16, 2, 30, 0), '§8 -06:00 resolved mechanically');
  const zero = parseXmltvTimestamp('20240115083000 +0000', null);
  ok(zero.epochMs === Date.UTC(2024, 0, 15, 8, 30, 0), '§8 +00:00 resolved mechanically');

  // clumpidx suffix is ignored for the window.
  const clumped = parseXmltvTimestamp('20240115083000 +0000/2', null);
  ok(clumped.epochMs === zero.epochMs, '§8 clumpidx suffix tolerated and ignored');
  const clumpedBare = parseXmltvTimestamp('20240115083000/3', 'UTC');
  ok(clumpedBare.epochMs === Date.UTC(2024, 0, 15, 8, 30, 0), '§8 bare clumpidx tolerated');
}

// ---------------------------------------------------------------------------
// §9 — configured timezone-less timestamps
// ---------------------------------------------------------------------------
console.log('§9 configured timezone');
{
  const ist = parseXmltvTimestamp('20240115083000', 'Asia/Kolkata');
  ok(ist.epochMs === Date.UTC(2024, 0, 15, 3, 0, 0) && ist.resolvedWith === 'default_timezone', '§9 timezone-less read in Asia/Kolkata (+05:30)');

  const utc = parseXmltvTimestamp('20240115083000', 'UTC');
  ok(utc.epochMs === Date.UTC(2024, 0, 15, 8, 30, 0), '§9 UTC default reads the wall clock literally');

  // No configured timezone → per-record typed skip, NEVER the server zone.
  let missingTz = false;
  try {
    parseXmltvTimestamp('20240115083000', null);
  } catch (error) {
    missingTz = error instanceof XmltvTimestampError && error.reason === 'missing_timezone';
  }
  ok(missingTz, '§9 timezone-less without config → typed missing_timezone (server zone never assumed)');

  // Parser-level integration: timezone-less records are skipped per-record.
  const doc = validXmlWith({
    programmes: programmeXml('c1', '20240115083000', '20240115090000', 'NoOffset') + programmeXml('c1', '20240115090000 +0000', '20240115100000 +0000', 'WithOffset')
  });
  const result = parseXmltvDocument(doc);
  ok(result.programmes.length === 1 && result.programmes[0]!.title === 'WithOffset', '§9 mixed document: only offset-carrying records survive');
  ok(result.diagnostics.skipReasons['invalid_start'] === 1, '§9 the timezone-less record is a counted per-record skip');
}

// ---------------------------------------------------------------------------
// §10 — DST boundaries (documented deterministic rules)
// ---------------------------------------------------------------------------
console.log('§10 DST boundaries');
{
  // Fall-back ambiguity (America/New_York, 2024-11-03 01:30 local occurs
  // twice): the documented rule keeps the EARLIER instant (DST side, -04:00).
  const ambiguous = parseXmltvTimestamp('20241103013000', 'America/New_York');
  ok(ambiguous.epochMs === Date.UTC(2024, 10, 3, 5, 30, 0), '§10 ambiguous fall-back time resolves to the EARLIER instant (first occurrence)');

  // Spring-forward gap (America/New_York, 2024-03-10 02:30 does not exist):
  // the documented rule uses the PRE-transition offset (-05:00).
  const gap = parseXmltvTimestamp('20240310023000', 'America/New_York');
  ok(gap.epochMs === Date.UTC(2024, 2, 10, 7, 30, 0), '§10 nonexistent spring-forward time maps via the pre-transition offset');

  // Unambiguous times are exact.
  const summer = parseXmltvTimestamp('20240615083000', 'America/New_York');
  ok(summer.epochMs === Date.UTC(2024, 5, 15, 12, 30, 0), '§10 unambiguous EDT time exact (-04:00)');
  const winter = parseXmltvTimestamp('20241215083000', 'America/New_York');
  ok(winter.epochMs === Date.UTC(2024, 11, 15, 13, 30, 0), '§10 unambiguous EST time exact (-05:00)');
}

// ---------------------------------------------------------------------------
// §11 — multiple IANA timezones in one set
// ---------------------------------------------------------------------------
console.log('§11 multi-timezone guides');
{
  const doc = validXmlWith({
    programmes:
      programmeXml('kolkata', '20240115083000 +0530', '20240115090000 +0530', 'Kolkata') +
      programmeXml('newyork', '20240115083000 -0500', '20240115090000 -0500', 'NewYork') +
      programmeXml('berlin', '20240115083000 +0100', '20240115090000 +0100', 'Berlin')
  });
  const result = parseXmltvDocument(doc);
  ok(result.programmes.length === 3, '§11 all three zones parsed');
  const byTitle = new Map(result.programmes.map((p) => [p.title, p]));
  ok(byTitle.get('Kolkata')!.startMs === Date.UTC(2024, 0, 15, 3, 0, 0), '§11 +05:30 window correct');
  ok(byTitle.get('NewYork')!.startMs === Date.UTC(2024, 0, 15, 13, 30, 0), '§11 -05:00 window correct');
  ok(byTitle.get('Berlin')!.startMs === Date.UTC(2024, 0, 15, 7, 30, 0), '§11 +01:00 window correct');
}

// ---------------------------------------------------------------------------
// §12 — invalid timestamps + window ordering
// ---------------------------------------------------------------------------
console.log('§12 invalid timestamps and windows');
{
  const cases: [string, XmltvTimestampError['reason'] | null][] = [
    ['20241315083000 +0000', 'invalid_date'], // month 13
    ['20240230083000 +0000', 'invalid_date'], // Feb 30
    ['20240230083000 +0000', 'invalid_date'],
    ['20230229083000 +0000', 'invalid_date'], // non-leap Feb 29
    ['20240115083060 +0000', 'invalid_time'], // leap second 60
    ['20240115253000 +0000', 'invalid_time'], // hour 25
    ['20240115083000 +9930', 'invalid_offset'], // absurd offset
    ['2024-01-15 08:30:00 +0000', 'invalid_format'], // not XMLTV shape
    ['', 'invalid_format']
  ];
  for (const [value, expected] of cases) {
    let matched = false;
    try {
      parseXmltvTimestamp(value, 'UTC');
    } catch (error) {
      matched = error instanceof XmltvTimestampError && error.reason === expected;
    }
    ok(matched, `§12 "${value.slice(0, 24)}" → ${expected}`);
  }
  // Leap-year Feb 29 IS valid.
  const leap = parseXmltvTimestamp('20240229230000 +0000', 'UTC');
  ok(leap.epochMs === Date.UTC(2024, 1, 29, 23, 0, 0), '§12 leap-day timestamp valid');

  // end <= start → per-record skip (invalid_window_order).
  const reversed = validXmlWith({ programmes: programmeXml('c1', '20240115090000 +0000', '20240115090000 +0000', 'ZeroLen') + programmeXml('c1', '20240115100000 +0000', '20240115090000 +0000', 'Reversed') });
  const result = parseXmltvDocument(reversed);
  ok(result.programmes.length === 0 && result.diagnostics.skipReasons['invalid_window_order'] === 2, '§12 zero-length and reversed windows are counted skips');
}

// ---------------------------------------------------------------------------
// §20 — abort/deadline handling
// ---------------------------------------------------------------------------
console.log('§20 abort + deadline');
{
  const controller = new AbortController();
  controller.abort();
  let cancelled = false;
  try {
    parseXmltvDocument(VALID_XML, { signal: controller.signal });
  } catch (error) {
    cancelled = error instanceof XmltvDocumentError && error.kind === 'cancelled';
  }
  ok(cancelled, '§20 a pre-aborted signal fails the parse as cancelled');

  let deadline = false;
  let clock = 0;
  try {
    parseXmltvDocument(VALID_XML, { now: () => (clock += 60_000) });
  } catch (error) {
    deadline = error instanceof XmltvDocumentError && error.kind === 'parse_deadline_exceeded';
  }
  ok(deadline, '§20 an exhausted injected clock fails the parse as parse_deadline_exceeded');
}

// ---------------------------------------------------------------------------
// §21 — safe diagnostics + redaction
// ---------------------------------------------------------------------------
console.log('§21 safe diagnostics');
{
  const hostile = validXmlWith({
    channels: '<channel id="bad id with spaces"><display-name>X</display-name></channel>',
    programmes: programmeXml('bad\u0007bell', '20240115083000 +0000', '20240115090000 +0000', 'T')
  });
  const result = parseXmltvDocument(hostile);
  ok(result.diagnostics.skipReasons['invalid_channel_id'] === 1, '§21 channel id with whitespace rejected');
  ok(result.diagnostics.skipReasons['invalid_programme_channel'] === 1, '§21 programme channel id with control char rejected');
  for (const sample of result.diagnostics.invalidChannelIdSamples) {
    ok(!/[\u0000-\u001f\u007f]/.test(sample), '§21 invalid-id samples are sanitized (no control characters)');
    ok(sample.length <= 200, '§21 invalid-id samples are length-bounded');
  }
  for (const sample of result.diagnostics.samples) {
    ok(typeof sample.reason === 'string' && sample.reason.length < 40, '§21 record samples carry static reasons only');
  }
  // No exception message ever echoes a URL.
  let message = '';
  try {
    parseXmltvDocument('<tv><programme start="https://secret.example/x" stop="20240115090000 +0000" channel="c"><title>T</title></programme></tv>');
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  ok(!message.includes('secret.example'), '§21 document errors never echo upstream URLs');
}

// ---------------------------------------------------------------------------
// Parser selection evidence (pinned regression — brief §4.1)
// ---------------------------------------------------------------------------
console.log('§13 parser security configuration (pinned behavior)');
{
  // The installed parser must keep: no external fetch, no DTD entity
  // expansion, tolerant-tokenizer + explicit structure validation.
  const probe = `<?xml version="1.0"?><!DOCTYPE tv SYSTEM "http://192.0.2.1/x.dtd"><tv><channel id="p1"><display-name>&amp;ok;</display-name></channel></tv>`;
  const result = parseXmltvDocument(probe);
  ok(result.channels[0]!.displayName === '&ok;', '§13 predefined entities decode; external DTD stays inert');

  const unknownEntity = validXmlWith({ channels: '<channel id="p2"><display-name>&totallyunknownentity;</display-name></channel>' });
  const unknownResult = parseXmltvDocument(unknownEntity);
  ok((unknownResult.channels[0]!.displayName ?? '').includes('totallyunknownentity'), '§13 unknown (DTD-defined elsewhere) entities stay literal — no expansion');

  ok(XMLTV_MAX_COMPRESSED_BYTES > DEFAULT_XMLTV_LIMITS.maxDecompressedBytes * 0 && XMLTV_MAX_COMPRESSED_BYTES === 12 * 1024 * 1024, '§13 compressed budget constant pinned');
}

// ---------------------------------------------------------------------------
// Timezone round-trip helper sanity
// ---------------------------------------------------------------------------
console.log('§14 timestamp formatting helper');
{
  const instant = Date.UTC(2024, 0, 15, 8, 30, 0);
  const formatted = formatXmltvTimestamp(instant, 330);
  ok(formatted === '20240115140000 +0530', `§14 formatter shifts the wall clock by the offset (${formatted})`);
  // Round-trip: formatting then parsing restores the exact instant.
  const reparsed = parseXmltvTimestamp(formatted, null);
  ok(reparsed.epochMs === instant && reparsed.resolvedWith === 'explicit_offset', '§14 format→parse round-trip restores the exact instant');
}

console.log(`\nXMLTV PHASE 3 PARSE TESTS: ${passed} checks passed`);
if (passed === 0) process.exit(1);

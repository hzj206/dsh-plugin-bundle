/**
 * Local-first, read-only token usage analytics and equivalent API cost engine
 * for Google Antigravity (`agy`) accounts.
 *
 * Reads only local SQLite conversation stores (`<appDir>/conversations/*.db`
 * and optional standalone `~/.gemini/antigravity-cli/conversations/*.db`) via
 * Node's built-in `node:sqlite` in strict `{ readOnly: true }` mode, decodes
 * `steps.metadata` Protobuf billing counters (`f1` timestamp, `f9` usage stats),
 * auto-learns unknown model enums from lightweight `gen_metadata` rows, and
 * persists an incremental per-file summary ledger (`usage-ledger.json`) so
 * repeat queries stay sub-millisecond and historical totals survive `.db`
 * cleanup. Zero network requests and zero OAuth credential access.
 * @module dsh-llm-antigravity-acp/usage-stats
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
let cachedDatabaseSync;
function loadDatabaseSync() {
    if (cachedDatabaseSync !== undefined)
        return cachedDatabaseSync ?? undefined;
    try {
        const req = createRequire(import.meta.url);
        const sqlite = req('node:sqlite');
        cachedDatabaseSync = typeof sqlite.DatabaseSync === 'function' ? sqlite.DatabaseSync : null;
    }
    catch {
        cachedDatabaseSync = null;
    }
    return cachedDatabaseSync ?? undefined;
}
/** Dedicated source key for the user's standalone `~/.gemini/antigravity-cli` directory. */
export const STANDALONE_CLI_SOURCE_KEY = '__standalone_cli__';
/** Maximum `gen_metadata.data` byte size inspected when auto-learning an unknown `modelEnum`. */
const MAX_GEN_METADATA_INSPECT_BYTES = 262_144;
/** Default in-memory throttle between filesystem scans on non-forced queries. */
const DEFAULT_SCAN_TTL_MS = 5_000;
/**
 * Verified built-in mapping of Antigravity Protobuf `modelEnum` integers observed
 * in `agy` SQLite stores. Unknown enums encountered in future CLI updates are
 * automatically learned from `gen_metadata` (`f1.19` / `f1.21`) and persisted in
 * `usage-ledger.json`.
 */
const BUILTIN_MODEL_ENUMS = {
    342: { modelId: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B (Medium)' },
    1318: { modelId: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash (High)' },
    1319: { modelId: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash (Medium)' },
    1320: { modelId: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash (Low)' },
    1401: { modelId: 'claude-opus-5-5', displayName: 'Claude Opus 5.5 (Medium)' },
    1402: { modelId: 'claude-opus-5-5', displayName: 'Claude Opus 5.5 (High)' },
    1403: { modelId: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5 (Low)' },
    1404: { modelId: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5 (Medium)' },
    1405: { modelId: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5 (High)' },
    1417: { modelId: 'gemini-4-argon', displayName: 'Gemini 4 Argon (High)' },
    1418: { modelId: 'gemini-4-argon', displayName: 'Gemini 4 Argon (Medium)' },
    1419: { modelId: 'gemini-4-argon', displayName: 'Gemini 4 Argon (Low)' },
    1525: { modelId: 'gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen (High)' },
    1526: { modelId: 'gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen (Medium)' },
    1527: { modelId: 'gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen (Low)' },
    1532: { modelId: 'gemini-4-neon', displayName: 'Gemini 4 Neon (High)' },
    1533: { modelId: 'gemini-4-neon', displayName: 'Gemini 4 Neon (Medium)' },
    1534: { modelId: 'gemini-4-neon', displayName: 'Gemini 4 Neon (Low)' },
    1535: { modelId: 'gemini-4-neon', displayName: 'Gemini 4 Neon (XHigh)' },
    1537: { modelId: 'gemini-pro-orchestrator-neon', displayName: 'Orchestrator (Neon)' },
    1668: { modelId: 'gemini-pro-orchestrator-argon', displayName: 'Orchestrator (Argon)' },
    1669: { modelId: 'gemini-flash-worker-agy', displayName: 'Gemini 4 Hydrogen (Orchestrator)' },
};
/**
 * Resolve reference official API list pricing (USD per 1M tokens) for one model
 * family on a given calendar day (`YYYY-MM-DD`).
 *
 * Output rates apply to total `outputTokens` (which in `agy` already includes
 * `thoughtTokens`, matching both Google and Anthropic reasoning billing).
 * Carbon & Argon reflect Google's published introductory rate through
 * `2026-11-30` ($2/$10) and standard rate from `2026-12-01` ($4/$20).
 * @param familyId - normalized model family identifier.
 * @param day - optional local calendar date `YYYY-MM-DD`.
 * @returns USD rates per 1M tokens.
 */
export function referenceApiRatesFor(familyId, day) {
    const lower = familyId.toLowerCase();
    const postDec1 = typeof day === 'string' && day >= '2026-12-01';
    if (lower.includes('orchestrator-neon') || lower.startsWith('gemini-4-neon')) {
        return { inputPerM: 3.0, cacheReadPerM: 0.15, cacheWritePerM: 3.0, outputPerM: 15.0 };
    }
    if (lower.startsWith('gemini-4-carbon')
        || lower.startsWith('gemini-4-argon')
        || lower === 'gemini-pro-orchestrator'
        || lower.includes('orchestrator-argon')
        || lower.includes('orchestrator-g1-pro')) {
        return postDec1
            ? { inputPerM: 4.0, cacheReadPerM: 0.2, cacheWritePerM: 4.0, outputPerM: 20.0 }
            : { inputPerM: 2.0, cacheReadPerM: 0.1, cacheWritePerM: 2.0, outputPerM: 10.0 };
    }
    if (lower.startsWith('gemini-4-hydrogen') || lower.includes('flash-worker')) {
        return { inputPerM: 1.5, cacheReadPerM: 0.075, cacheWritePerM: 1.5, outputPerM: 7.5 };
    }
    if (lower.includes('flash')) {
        return { inputPerM: 0.75, cacheReadPerM: 0.075, cacheWritePerM: 0.75, outputPerM: 3.75 };
    }
    if (lower.startsWith('claude-opus-5-5') || lower.startsWith('claude-opus-5.5')) {
        return { inputPerM: 4.0, cacheReadPerM: 0.2, cacheWritePerM: 5.0, outputPerM: 20.0 };
    }
    if (lower.startsWith('claude-opus')) {
        return { inputPerM: 5.0, cacheReadPerM: 0.5, cacheWritePerM: 6.25, outputPerM: 25.0 };
    }
    if (lower.startsWith('claude-sonnet-5-5') || lower.startsWith('claude-sonnet-5.5')) {
        return { inputPerM: 2.0, cacheReadPerM: 0.1, cacheWritePerM: 2.5, outputPerM: 10.0 };
    }
    if (lower.startsWith('claude-sonnet') || lower.startsWith('claude-')) {
        return { inputPerM: 3.0, cacheReadPerM: 0.3, cacheWritePerM: 3.75, outputPerM: 15.0 };
    }
    if (lower.startsWith('gpt-oss') || lower.startsWith('gpt-')) {
        return { inputPerM: 0.15, cacheReadPerM: 0.075, cacheWritePerM: 0.15, outputPerM: 0.6 };
    }
    return { inputPerM: 2.0, cacheReadPerM: 0.1, cacheWritePerM: 2.0, outputPerM: 10.0 };
}
/**
 * Estimate equivalent official API USD cost and prompt-caching USD savings for
 * one bucket of tokens.
 * @param input - token counts and model/day context.
 * @returns `{ estimatedUsd, cacheSavingsUsd }`.
 */
export function estimateApiCostUsd(input) {
    const rate = referenceApiRatesFor(input.familyId, input.day);
    const estimatedUsd = (input.inputTokens * rate.inputPerM
        + input.cacheReadTokens * rate.cacheReadPerM
        + input.cacheWriteTokens * rate.cacheWritePerM
        + input.outputTokens * rate.outputPerM) / 1_000_000;
    const cacheSavingsUsd = (input.cacheReadTokens * Math.max(0, rate.inputPerM - rate.cacheReadPerM)) / 1_000_000;
    return { estimatedUsd, cacheSavingsUsd };
}
/**
 * Classify a normalized model family into a semantic color group.
 *
 * Orchestrators take their sibling's hue (Neon's emerald-free blue family aside,
 * Argon's violet, Carbon's slate) so a legend never paints two different rows in
 * the same colour while still reading as "the orchestrator of that family".
 * @param familyId - normalized model family identifier.
 * @returns the palette group the UI paints this family with.
 */
export function colorGroupForModel(familyId) {
    const lower = familyId.toLowerCase();
    if (lower.includes('orchestrator-argon') || lower.includes('orchestrator-g1-pro'))
        return 'argon';
    if (lower.includes('orchestrator') && lower.includes('carbon'))
        return 'carbon';
    if (lower.includes('orchestrator'))
        return 'orchestrator';
    if (lower.includes('neon'))
        return 'neon';
    if (lower.includes('hydrogen') || lower.includes('flash-worker'))
        return 'hydrogen';
    if (lower.includes('argon'))
        return 'argon';
    if (lower.includes('carbon'))
        return 'carbon';
    if (lower.includes('flash'))
        return 'flash';
    if (lower.includes('claude'))
        return 'claude';
    if (lower.includes('gpt') || lower.includes('oss'))
        return 'gpt';
    return 'other';
}
function stripEffortSuffixFromId(id) {
    const lower = id.toLowerCase();
    if (lower === 'gpt-oss-120b-medium')
        return lower;
    return id.replace(/-(xhigh|high|medium|low)$/i, '');
}
function stripEffortSuffixFromName(name) {
    return name.replace(/\s*\((XHigh|High|Medium|Low)\)\s*$/i, '').trim();
}
function normalizeModelIdentity(modelEnum, knownEnums) {
    const key = modelEnum !== undefined ? String(modelEnum) : undefined;
    const learned = key !== undefined ? knownEnums[key] : undefined;
    const builtin = modelEnum !== undefined ? BUILTIN_MODEL_ENUMS[modelEnum] : undefined;
    const rawId = (learned?.modelId || builtin?.modelId || '').trim();
    const rawName = (learned?.displayName || builtin?.displayName || '').trim();
    if (rawId.length === 0 && rawName.length === 0) {
        const fallbackId = modelEnum !== undefined ? `model-${modelEnum}` : 'unknown';
        const fallbackName = modelEnum !== undefined ? `Model #${modelEnum}` : 'Unknown Model';
        return { modelId: fallbackId, familyId: fallbackId, familyName: fallbackName, variantName: fallbackName };
    }
    const lowerId = rawId.toLowerCase();
    const lowerName = rawName.toLowerCase();
    let familyId;
    let familyName;
    if (lowerId.includes('orchestrator-neon') || lowerName.includes('orchestrator (neon)')) {
        familyId = 'gemini-pro-orchestrator-neon';
        familyName = 'Orchestrator (Neon)';
    }
    else if (lowerId.includes('orchestrator-g1-pro') || lowerId.includes('orchestrator-argon') || lowerName.includes('orchestrator (argon)')) {
        familyId = 'gemini-pro-orchestrator-argon';
        familyName = 'Orchestrator (Argon)';
    }
    else if (lowerId === 'gemini-pro-orchestrator' || lowerName.includes('orchestrator (carbon)')) {
        familyId = 'gemini-pro-orchestrator';
        familyName = 'Orchestrator (Carbon)';
    }
    else if (lowerId.includes('flash-worker') || lowerName.includes('hydrogen (orchestrator)')) {
        familyId = 'gemini-flash-worker-agy';
        familyName = 'Gemini 4 Hydrogen (Worker)';
    }
    else if (lowerId.startsWith('gemini-4-neon') || lowerName.includes('gemini 4 neon')) {
        familyId = 'gemini-4-neon';
        familyName = 'Gemini 4 Neon';
    }
    else if (lowerId.startsWith('gemini-4-hydrogen') || lowerName.includes('gemini 4 hydrogen')) {
        familyId = 'gemini-4-hydrogen';
        familyName = 'Gemini 4 Hydrogen';
    }
    else if (lowerId.startsWith('gemini-4-argon') || lowerName.includes('gemini 4 argon')) {
        familyId = 'gemini-4-argon';
        familyName = 'Gemini 4 Argon';
    }
    else if (lowerId.startsWith('gemini-4-carbon') || lowerName.includes('gemini 4 carbon')) {
        familyId = 'gemini-4-carbon';
        familyName = 'Gemini 4 Carbon';
    }
    else if (lowerId.startsWith('gemini-3.8-flash') || lowerName.includes('gemini 3.8 flash')) {
        familyId = 'gemini-3.8-flash';
        familyName = 'Gemini 3.8 Flash';
    }
    else if (lowerId.startsWith('claude-opus-5-5') || lowerName.includes('claude opus 5.5')) {
        familyId = 'claude-opus-5-5';
        familyName = 'Claude Opus 5.5';
    }
    else if (lowerId.startsWith('claude-sonnet-5-5') || lowerName.includes('claude sonnet 5.5')) {
        familyId = 'claude-sonnet-5-5';
        familyName = 'Claude Sonnet 5.5';
    }
    else if (lowerId.startsWith('claude-opus-4-6') || lowerName.includes('claude opus 4.6')) {
        familyId = 'claude-opus-4-6-thinking';
        familyName = 'Claude Opus 4.6';
    }
    else if (lowerId.startsWith('claude-sonnet-4-6') || lowerName.includes('claude sonnet 4.6')) {
        familyId = 'claude-sonnet-4-6-thinking';
        familyName = 'Claude Sonnet 4.6';
    }
    else if (lowerId.startsWith('gpt-oss-120b') || lowerName.includes('gpt-oss 120b')) {
        familyId = 'gpt-oss-120b-medium';
        familyName = 'GPT-OSS 120B (Medium)';
    }
    else {
        familyId = stripEffortSuffixFromId(rawId || rawName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-'));
        familyName = stripEffortSuffixFromName(rawName) || familyId;
    }
    const variantName = rawName.length > 0 ? rawName : familyName;
    return { modelId: rawId || familyId, familyId, familyName, variantName };
}
// ── Minimal Protobuf Wire Decoding (zero external dependencies) ──────────────
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });
function readVarint(buf, offset) {
    let value = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i += 1) {
        const byte = buf[offset + i];
        if (byte === undefined)
            return undefined;
        value |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0)
            return { value, next: offset + i + 1 };
        shift += 7n;
    }
    return undefined;
}
function toNonNegativeInt(raw) {
    const signed = BigInt.asIntN(64, raw);
    if (signed <= 0n)
        return 0;
    if (signed > BigInt(Number.MAX_SAFE_INTEGER))
        return Number.MAX_SAFE_INTEGER;
    return Number(signed);
}
function walkProto(buf, visit) {
    let pos = 0;
    while (pos < buf.length) {
        const tag = readVarint(buf, pos);
        if (tag === undefined)
            return false;
        pos = tag.next;
        const field = Number(tag.value >> 3n);
        const wire = Number(tag.value & 7n);
        if (field <= 0)
            return false;
        if (wire === 0) {
            const val = readVarint(buf, pos);
            if (val === undefined)
                return false;
            pos = val.next;
            if (visit({ field, wire: 0, value: val.value }) === false)
                return true;
        }
        else if (wire === 2) {
            const len = readVarint(buf, pos);
            if (len === undefined)
                return false;
            const n = Number(len.value);
            if (len.value < 0n || !Number.isSafeInteger(n) || len.next + n > buf.length)
                return false;
            const bytes = buf.subarray(len.next, len.next + n);
            pos = len.next + n;
            if (visit({ field, wire: 2, bytes }) === false)
                return true;
        }
        else if (wire === 1) {
            if (pos + 8 > buf.length)
                return false;
            pos += 8;
        }
        else if (wire === 5) {
            if (pos + 4 > buf.length)
                return false;
            pos += 4;
        }
        else {
            return false;
        }
    }
    return true;
}
function readTimestampSeconds(buf) {
    let sec;
    walkProto(buf, (entry) => {
        if (entry.wire === 0 && entry.field === 1) {
            const n = toNonNegativeInt(entry.value);
            if (n > 0)
                sec = n;
            return false;
        }
        return true;
    });
    return sec;
}
/**
 * Decode timestamp, model enum, request dedup id, and 5D billing counters from
 * a `steps.metadata` Protobuf blob.
 */
function decodeStepBilling(buf) {
    let startSec;
    let endSec;
    let topModelEnum;
    let foundUsage = false;
    let modelEnum;
    let requestId;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheWriteTokens = 0;
    let cacheReadTokens = 0;
    let thoughtTokens = 0;
    let textOutTokens = 0;
    const ok = walkProto(buf, (entry) => {
        if (entry.wire === 0 && entry.field === 11) {
            const n = toNonNegativeInt(entry.value);
            if (n > 0)
                topModelEnum = n;
            return true;
        }
        if (entry.wire !== 2)
            return true;
        if (entry.field === 1 && startSec === undefined) {
            startSec = readTimestampSeconds(entry.bytes);
        }
        else if (entry.field === 7 && endSec === undefined) {
            endSec = readTimestampSeconds(entry.bytes);
        }
        else if (entry.field === 9) {
            walkProto(entry.bytes, (u) => {
                if (u.wire === 0) {
                    const n = toNonNegativeInt(u.value);
                    if (u.field === 1 && n > 0)
                        modelEnum = n;
                    else if (u.field === 2)
                        inputTokens = n;
                    else if (u.field === 3)
                        outputTokens = n;
                    else if (u.field === 4)
                        cacheWriteTokens = n;
                    else if (u.field === 5)
                        cacheReadTokens = n;
                    else if (u.field === 9)
                        thoughtTokens = n;
                    else if (u.field === 10)
                        textOutTokens = n;
                }
                else if (u.wire === 2 && u.field === 7 && u.bytes.length > 0 && u.bytes.length <= 128) {
                    requestId = UTF8_DECODER.decode(u.bytes);
                }
            });
            foundUsage = true;
        }
        return true;
    });
    if (!ok || !foundUsage)
        return undefined;
    if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0)
        return undefined;
    // `f3` (`outputTokens`) includes `thoughtTokens` (`f9`); guard against malformed inputs.
    const effectiveTextOut = textOutTokens > 0
        ? textOutTokens
        : Math.max(0, outputTokens - thoughtTokens);
    const effectiveEnum = modelEnum ?? topModelEnum;
    const ts = startSec ?? endSec;
    return {
        ...(ts !== undefined ? { timestampSec: ts } : {}),
        ...(effectiveEnum !== undefined ? { modelEnum: effectiveEnum } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
        inputTokens,
        outputTokens,
        cacheWriteTokens,
        cacheReadTokens,
        thoughtTokens,
        textOutTokens: effectiveTextOut,
    };
}
/** Auto-learn `modelEnum -> { modelId, displayName }` from a `gen_metadata.data` blob. */
function decodeGenModelInfo(buf) {
    let modelEnum;
    let usageModelEnum;
    let modelId = '';
    let displayName = '';
    walkProto(buf, (entry) => {
        if (entry.wire !== 2 || entry.field !== 1)
            return true;
        walkProto(entry.bytes, (f2) => {
            if (f2.wire === 0 && f2.field === 3) {
                const n = toNonNegativeInt(f2.value);
                if (n > 0)
                    modelEnum = n;
            }
            else if (f2.wire === 2 && f2.field === 4) {
                walkProto(f2.bytes, (f3) => {
                    if (f3.wire === 0 && f3.field === 1) {
                        const n = toNonNegativeInt(f3.value);
                        if (n > 0)
                            usageModelEnum = n;
                        return false;
                    }
                    return true;
                });
            }
            else if (f2.wire === 2 && f2.field === 19 && f2.bytes.length > 0 && f2.bytes.length <= 128) {
                modelId = UTF8_DECODER.decode(f2.bytes).trim();
            }
            else if (f2.wire === 2 && f2.field === 21 && f2.bytes.length > 0 && f2.bytes.length <= 128) {
                displayName = UTF8_DECODER.decode(f2.bytes).trim();
            }
        });
        return false;
    });
    const resolvedEnum = modelEnum ?? usageModelEnum;
    if (resolvedEnum === undefined || (modelId.length === 0 && displayName.length === 0))
        return undefined;
    return { modelEnum: resolvedEnum, modelId, displayName };
}
// ── Date / Calendar Helpers (local timezone) ─────────────────────────────────
function pad2(n) {
    return n < 10 ? `0${n}` : String(n);
}
/** Format a local Date as `YYYY-MM-DD`. */
export function localDayKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}
function addLocalDays(base, delta) {
    const next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + delta);
    return next;
}
function compactDayLabel(day) {
    const parts = day.split('-');
    const m = Number(parts[1] ?? 0);
    const d = Number(parts[2] ?? 0);
    return `${m}/${d}`;
}
function resolveRangeBounds(range, nowMs) {
    const now = new Date(nowMs);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayKey = localDayKey(today);
    if (range === 'today') {
        const chartDays = [];
        for (let i = -6; i <= 0; i += 1)
            chartDays.push(localDayKey(addLocalDays(today, i)));
        return {
            filterStart: todayKey,
            filterEnd: todayKey,
            chartDays,
            todayKey,
            rangeLabel: todayKey,
        };
    }
    if (range === 'week') {
        const dowFromMon = (today.getDay() + 6) % 7;
        const monday = addLocalDays(today, -dowFromMon);
        const chartDays = [];
        for (let i = 0; i < 7; i += 1)
            chartDays.push(localDayKey(addLocalDays(monday, i)));
        const start = chartDays[0] ?? todayKey;
        const end = chartDays[6] ?? todayKey;
        return {
            filterStart: start,
            filterEnd: end,
            chartDays,
            todayKey,
            rangeLabel: `${compactDayLabel(start)} – ${compactDayLabel(end)}`,
        };
    }
    if (range === 'month') {
        const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
        const chartDays = [];
        for (let d = new Date(monthStart.getTime()); d <= today; d = addLocalDays(d, 1)) {
            chartDays.push(localDayKey(d));
        }
        const start = chartDays[0] ?? todayKey;
        return {
            filterStart: start,
            filterEnd: todayKey,
            chartDays,
            todayKey,
            rangeLabel: `${compactDayLabel(start)} – ${compactDayLabel(todayKey)}`,
        };
    }
    // '30d' rolling window ending today
    const chartDays = [];
    for (let i = -29; i <= 0; i += 1)
        chartDays.push(localDayKey(addLocalDays(today, i)));
    const start = chartDays[0] ?? todayKey;
    return {
        filterStart: start,
        filterEnd: todayKey,
        chartDays,
        todayKey,
        rangeLabel: `${compactDayLabel(start)} – ${compactDayLabel(todayKey)}`,
    };
}
// ── SQLite Single-File Read-Only Scanner ─────────────────────────────────────
function asBytes(raw) {
    if (raw instanceof Uint8Array)
        return raw;
    if (ArrayBuffer.isView(raw))
        return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    return undefined;
}
function fileFreshness(dbPath) {
    try {
        const st = statSync(dbPath);
        if (!st.isFile() || st.size === 0)
            return undefined;
        let mtimeMs = Math.trunc(st.mtimeMs);
        let size = st.size;
        const walPath = `${dbPath}-wal`;
        if (existsSync(walPath)) {
            try {
                const wal = statSync(walPath);
                if (wal.isFile() && wal.size > 0) {
                    mtimeMs = Math.max(mtimeMs, Math.trunc(wal.mtimeMs));
                    size += wal.size;
                }
            }
            catch {
                // Ignore transient WAL race.
            }
        }
        return { mtimeMs, size };
    }
    catch {
        return undefined;
    }
}
function scanConversationDb(dbPath, fallbackMtimeMs, knownEnums) {
    const Database = loadDatabaseSync();
    if (Database === undefined)
        return undefined;
    let db;
    try {
        db = new Database(dbPath, { readOnly: true, timeout: 150 });
        // Every completed step that carries billing, regardless of `step_type`: the
        // plugin's own calibration reads `status = 3` only, and failed or refused
        // steps (`6` / `7`) are not counted as consumption here either.
        const rows = db.prepare('SELECT metadata FROM steps WHERE status = 3 AND metadata IS NOT NULL AND length(metadata) > 0').all();
        const decodedSteps = [];
        const seenReqIds = new Set();
        const unknownEnums = new Set();
        for (const row of rows) {
            const bytes = asBytes(row['metadata']);
            if (bytes === undefined)
                continue;
            const billing = decodeStepBilling(bytes);
            if (billing === undefined)
                continue;
            if (billing.requestId !== undefined) {
                if (seenReqIds.has(billing.requestId))
                    continue;
                seenReqIds.add(billing.requestId);
            }
            decodedSteps.push(billing);
            if (billing.modelEnum !== undefined
                && knownEnums[String(billing.modelEnum)] === undefined
                && BUILTIN_MODEL_ENUMS[billing.modelEnum] === undefined) {
                unknownEnums.add(billing.modelEnum);
            }
        }
        let learnedEnums = false;
        if (unknownEnums.size > 0) {
            try {
                const genRows = db.prepare('SELECT data FROM gen_metadata WHERE data IS NOT NULL AND length(data) > 0 AND length(data) <= ?').all(MAX_GEN_METADATA_INSPECT_BYTES);
                for (const g of genRows) {
                    const bytes = asBytes(g['data']);
                    if (bytes === undefined)
                        continue;
                    const info = decodeGenModelInfo(bytes);
                    if (info === undefined)
                        continue;
                    const k = String(info.modelEnum);
                    if (knownEnums[k] === undefined) {
                        knownEnums[k] = { modelId: info.modelId, displayName: info.displayName };
                        learnedEnums = true;
                    }
                    unknownEnums.delete(info.modelEnum);
                    if (unknownEnums.size === 0)
                        break;
                }
            }
            catch {
                // Older DBs may omit `gen_metadata`; fall back cleanly to built-in/enum labels.
            }
        }
        const grouped = new Map();
        for (const step of decodedSteps) {
            const tsMs = step.timestampSec !== undefined ? step.timestampSec * 1000 : fallbackMtimeMs;
            const day = localDayKey(new Date(tsMs));
            const identity = normalizeModelIdentity(step.modelEnum, knownEnums);
            const key = `${day}\t${step.modelEnum ?? -1}\t${identity.familyId}\t${identity.variantName}`;
            const existing = grouped.get(key);
            if (existing !== undefined) {
                existing.calls += 1;
                existing.inputTokens += step.inputTokens;
                existing.cacheReadTokens += step.cacheReadTokens;
                existing.cacheWriteTokens += step.cacheWriteTokens;
                existing.outputTokens += step.outputTokens;
                existing.thoughtTokens += step.thoughtTokens;
                existing.textOutTokens += step.textOutTokens;
            }
            else {
                grouped.set(key, {
                    day,
                    ...(step.modelEnum !== undefined ? { modelEnum: step.modelEnum } : {}),
                    modelId: identity.modelId,
                    familyId: identity.familyId,
                    familyName: identity.familyName,
                    variantName: identity.variantName,
                    calls: 1,
                    inputTokens: step.inputTokens,
                    cacheReadTokens: step.cacheReadTokens,
                    cacheWriteTokens: step.cacheWriteTokens,
                    outputTokens: step.outputTokens,
                    thoughtTokens: step.thoughtTokens,
                    textOutTokens: step.textOutTokens,
                });
            }
        }
        return { buckets: [...grouped.values()], learnedEnums };
    }
    catch {
        // Gracefully skip locked (`SQLITE_BUSY`) or malformed DBs; never block chat turns.
        return undefined;
    }
    finally {
        try {
            db?.close();
        }
        catch { /* ignore */ }
    }
}
// ── Atomic Ledger Persistence ────────────────────────────────────────────────
function atomicWriteJson(filePath, data) {
    let tmp;
    try {
        mkdirSync(dirname(filePath), { recursive: true });
        tmp = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(data)}\n`, { encoding: 'utf8', mode: 0o600 });
        renameSync(tmp, filePath);
    }
    catch {
        if (tmp !== undefined) {
            try {
                unlinkSync(tmp);
            }
            catch { /* ignore */ }
        }
    }
}
function emptyLedger() {
    return {
        version: 1,
        updatedAt: new Date().toISOString(),
        knownEnums: {},
        files: {},
    };
}
function readLedgerFromDisk(filePath) {
    if (!existsSync(filePath))
        return emptyLedger();
    try {
        const raw = readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1)
            return emptyLedger();
        return {
            version: 1,
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
            knownEnums: parsed.knownEnums !== null && typeof parsed.knownEnums === 'object' && !Array.isArray(parsed.knownEnums)
                ? { ...parsed.knownEnums }
                : {},
            files: parsed.files !== null && typeof parsed.files === 'object' && !Array.isArray(parsed.files)
                ? { ...parsed.files }
                : {},
        };
    }
    catch {
        return emptyLedger();
    }
}
function createMutableCounters() {
    return {
        calls: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        thoughtTokens: 0,
        textOutTokens: 0,
        estimatedUsd: 0,
        cacheSavingsUsd: 0,
    };
}
function addBucketToCounters(target, row, cost) {
    target.calls += row.calls;
    target.inputTokens += row.inputTokens;
    target.cacheReadTokens += row.cacheReadTokens;
    target.cacheWriteTokens += row.cacheWriteTokens;
    target.outputTokens += row.outputTokens;
    target.thoughtTokens += row.thoughtTokens;
    target.textOutTokens += row.textOutTokens;
    target.estimatedUsd += cost.estimatedUsd;
    target.cacheSavingsUsd += cost.cacheSavingsUsd;
}
function finalizeCounters(m) {
    const totalInput = m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens;
    const totalTokens = totalInput + m.outputTokens;
    const cacheHitRate = totalInput > 0 ? m.cacheReadTokens / totalInput : 0;
    return {
        calls: m.calls,
        inputTokens: m.inputTokens,
        cacheReadTokens: m.cacheReadTokens,
        cacheWriteTokens: m.cacheWriteTokens,
        outputTokens: m.outputTokens,
        thoughtTokens: m.thoughtTokens,
        textOutTokens: m.textOutTokens,
        totalTokens,
        cacheHitRate: Math.round(cacheHitRate * 10_000) / 10_000,
        estimatedUsd: Math.round(m.estimatedUsd * 10_000) / 10_000,
        cacheSavingsUsd: Math.round(m.cacheSavingsUsd * 10_000) / 10_000,
    };
}
function normalizePathKey(p, platform) {
    const abs = resolve(p);
    return platform === 'win32' ? abs.toLowerCase() : abs;
}
function conversationDirsForAccount(account, platform) {
    const raw = [
        join(account.appDir, 'conversations'),
        join(account.geminiDir, 'antigravity-cli', 'conversations'),
    ];
    // Non-system accounts own a private isolated `homeDir`; include its CLI dir
    // so `agy -p` activity inside that sandbox is credited to that account.
    if (!account.system) {
        raw.push(join(account.homeDir, '.gemini', 'antigravity-cli', 'conversations'));
    }
    const seen = new Set();
    const out = [];
    for (const dir of raw) {
        const key = normalizePathKey(dir, platform);
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(dir);
    }
    return out;
}
function standaloneCliDirFor(accounts) {
    const sys = accounts.find(a => a.system);
    if (sys === undefined || sys.homeDir.length === 0)
        return undefined;
    return join(sys.homeDir, '.gemini', 'antigravity-cli', 'conversations');
}
/**
 * Persistent incremental token usage ledger and query engine across all
 * configured Antigravity accounts.
 */
export class UsageLedgerStore {
    ledgerPath;
    options;
    ledger;
    lastScanAt = 0;
    /**
     * @param ledgerPath - absolute path to `usage-ledger.json`.
     * @param options - injectable platform, scan TTL, and clock for tests.
     */
    constructor(ledgerPath, options = {}) {
        this.ledgerPath = ledgerPath;
        this.options = options;
    }
    platform() {
        return this.options.platform ?? process.platform;
    }
    now() {
        return this.options.now !== undefined ? this.options.now() : Date.now();
    }
    ensureLoaded() {
        if (this.ledger === undefined) {
            this.ledger = readLedgerFromDisk(this.ledgerPath);
        }
        return this.ledger;
    }
    /**
     * Incrementally refresh changed `.db` files on disk and return an aggregated
     * usage snapshot for the requested account, range, and grouping.
     * @param accounts - configured Antigravity account sources.
     * @param request - filter, grouping, and refresh options.
     * @param modelDisplayNames - optional user-configured display aliases by family id.
     * @returns complete analytics snapshot.
     */
    query(accounts, request = {}, modelDisplayNames = {}) {
        const t0 = Date.now();
        const nowMs = this.now();
        const range = request.range ?? 'week';
        const groupBy = request.groupBy ?? 'family';
        const includeStandaloneCli = request.includeStandaloneCli === true;
        const requestedAccount = request.accountId !== undefined && request.accountId.trim().length > 0
            ? request.accountId.trim()
            : 'all';
        const accountId = requestedAccount === 'all' || accounts.some(a => a.accountId === requestedAccount)
            ? requestedAccount
            : 'all';
        const ledger = this.ensureLoaded();
        const scanTtl = this.options.scanTtlMs ?? DEFAULT_SCAN_TTL_MS;
        let scannedFiles = 0;
        let cachedFiles = 0;
        let dirty = false;
        const shouldScan = request.force === true || this.lastScanAt === 0 || (nowMs - this.lastScanAt >= scanTtl);
        if (shouldScan) {
            const scanDirs = [];
            const seenDirKeys = new Set();
            for (const acc of accounts) {
                for (const dir of conversationDirsForAccount(acc, this.platform())) {
                    const dk = normalizePathKey(dir, this.platform());
                    if (seenDirKeys.has(dk))
                        continue;
                    seenDirKeys.add(dk);
                    scanDirs.push({ sourceKey: acc.accountId, dir });
                }
            }
            const standaloneDir = standaloneCliDirFor(accounts);
            if (standaloneDir !== undefined) {
                const sk = normalizePathKey(standaloneDir, this.platform());
                if (!seenDirKeys.has(sk)) {
                    seenDirKeys.add(sk);
                    scanDirs.push({ sourceKey: STANDALONE_CLI_SOURCE_KEY, dir: standaloneDir });
                }
            }
            for (const { sourceKey, dir } of scanDirs) {
                if (!existsSync(dir))
                    continue;
                let names;
                try {
                    names = readdirSync(dir);
                }
                catch {
                    continue;
                }
                for (const name of names) {
                    if (!name.endsWith('.db'))
                        continue;
                    const dbPath = join(dir, name);
                    const fresh = fileFreshness(dbPath);
                    if (fresh === undefined)
                        continue;
                    const fileKey = `${sourceKey}::${normalizePathKey(dbPath, this.platform())}`;
                    const prev = ledger.files[fileKey];
                    if (prev !== undefined && prev.mtimeMs === fresh.mtimeMs && prev.size === fresh.size) {
                        cachedFiles += 1;
                        continue;
                    }
                    const result = scanConversationDb(dbPath, fresh.mtimeMs, ledger.knownEnums);
                    if (result === undefined) {
                        if (prev !== undefined)
                            cachedFiles += 1;
                        continue;
                    }
                    scannedFiles += 1;
                    ledger.files[fileKey] = {
                        sourceKey,
                        path: dbPath,
                        mtimeMs: fresh.mtimeMs,
                        size: fresh.size,
                        buckets: result.buckets,
                    };
                    dirty = true;
                }
            }
            this.lastScanAt = nowMs;
            if (dirty) {
                ledger.updatedAt = new Date(nowMs).toISOString();
                atomicWriteJson(this.ledgerPath, ledger);
            }
        }
        else {
            cachedFiles = Object.keys(ledger.files).length;
        }
        const bounds = resolveRangeBounds(range, nowMs);
        const chartDaySet = new Set(bounds.chartDays);
        const systemAccountId = accounts.find(a => a.system)?.accountId ?? accounts[0]?.accountId ?? 'default';
        const totalsMut = createMutableCounters();
        const modelMap = new Map();
        const dailyMap = new Map();
        for (const day of bounds.chartDays) {
            dailyMap.set(day, { counters: createMutableCounters(), segments: new Map() });
        }
        const accountMutMap = new Map();
        for (const acc of accounts) {
            accountMutMap.set(acc.accountId, createMutableCounters());
        }
        let hasStandaloneCli = false;
        const resolveFamilyName = (familyId, fallbackName) => {
            const alias = Object.hasOwn(modelDisplayNames, familyId) ? modelDisplayNames[familyId]?.trim() : '';
            return alias !== undefined && alias.length > 0 ? alias : fallbackName;
        };
        for (const entry of Object.values(ledger.files)) {
            const isStandalone = entry.sourceKey === STANDALONE_CLI_SOURCE_KEY;
            if (isStandalone && entry.buckets.length > 0)
                hasStandaloneCli = true;
            if (isStandalone && !includeStandaloneCli)
                continue;
            const creditedAccountId = isStandalone ? systemAccountId : entry.sourceKey;
            const matchesAccountFilter = accountId === 'all' || creditedAccountId === accountId;
            for (const row of entry.buckets) {
                const inFilterRange = row.day >= bounds.filterStart && row.day <= bounds.filterEnd;
                const inChartRange = chartDaySet.has(row.day);
                if (!inFilterRange && !inChartRange)
                    continue;
                // Re-resolve model names dynamically in case new enum mappings or user aliases were learned.
                const resolved = row.modelEnum !== undefined
                    ? normalizeModelIdentity(row.modelEnum, ledger.knownEnums)
                    : { modelId: row.modelId, familyId: row.familyId, familyName: row.familyName, variantName: row.variantName };
                const familyId = resolved.familyId;
                const displayFamilyName = resolveFamilyName(familyId, resolved.familyName);
                const displayVariantName = resolved.variantName;
                const colorGroup = colorGroupForModel(familyId);
                const cost = estimateApiCostUsd({
                    familyId,
                    day: row.day,
                    inputTokens: row.inputTokens,
                    cacheReadTokens: row.cacheReadTokens,
                    cacheWriteTokens: row.cacheWriteTokens,
                    outputTokens: row.outputTokens,
                });
                if (inFilterRange) {
                    const accMut = accountMutMap.get(creditedAccountId);
                    if (accMut !== undefined) {
                        addBucketToCounters(accMut, row, cost);
                    }
                }
                if (!matchesAccountFilter)
                    continue;
                if (inFilterRange) {
                    addBucketToCounters(totalsMut, row, cost);
                    const modelKey = groupBy === 'variant' ? `${familyId}::${displayVariantName}` : familyId;
                    const modelLabel = groupBy === 'variant' ? displayVariantName : displayFamilyName;
                    let mEntry = modelMap.get(modelKey);
                    if (mEntry === undefined) {
                        mEntry = {
                            key: modelKey,
                            familyId,
                            familyName: displayFamilyName,
                            name: modelLabel,
                            colorGroup,
                            counters: createMutableCounters(),
                        };
                        modelMap.set(modelKey, mEntry);
                    }
                    addBucketToCounters(mEntry.counters, row, cost);
                }
                if (inChartRange) {
                    const dayBucket = dailyMap.get(row.day);
                    if (dayBucket !== undefined) {
                        addBucketToCounters(dayBucket.counters, row, cost);
                        const seg = dayBucket.segments.get(familyId);
                        const rowTokens = row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens + row.outputTokens;
                        if (seg !== undefined) {
                            seg.totalTokens += rowTokens;
                            seg.estimatedUsd += cost.estimatedUsd;
                        }
                        else {
                            dayBucket.segments.set(familyId, {
                                familyId,
                                name: displayFamilyName,
                                colorGroup,
                                totalTokens: rowTokens,
                                estimatedUsd: cost.estimatedUsd,
                            });
                        }
                    }
                }
            }
        }
        const totals = finalizeCounters(totalsMut);
        const models = [...modelMap.values()]
            .map((item) => {
            const finalized = finalizeCounters(item.counters);
            return {
                key: item.key,
                familyId: item.familyId,
                familyName: item.familyName,
                name: item.name,
                colorGroup: item.colorGroup,
                ...finalized,
                share: totals.totalTokens > 0 ? Math.round((finalized.totalTokens / totals.totalTokens) * 10_000) / 10_000 : 0,
            };
        })
            .sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls || a.name.localeCompare(b.name));
        const daily = bounds.chartDays.map((day) => {
            const bucket = dailyMap.get(day);
            const finalized = finalizeCounters(bucket.counters);
            const segments = [...bucket.segments.values()]
                .map(s => ({
                ...s,
                estimatedUsd: Math.round(s.estimatedUsd * 10_000) / 10_000,
            }))
                .sort((a, b) => b.totalTokens - a.totalTokens);
            return {
                day,
                label: compactDayLabel(day),
                isToday: day === bounds.todayKey,
                isFuture: day > bounds.todayKey,
                inRange: day >= bounds.filterStart && day <= bounds.filterEnd,
                ...finalized,
                segments,
            };
        });
        let allAccountsTotalTokens = 0;
        const rawAccountRows = accounts.map((acc) => {
            const finalized = finalizeCounters(accountMutMap.get(acc.accountId) ?? createMutableCounters());
            allAccountsTotalTokens += finalized.totalTokens;
            return { acc, finalized };
        });
        const accountSummaries = rawAccountRows.map(({ acc, finalized }) => ({
            accountId: acc.accountId,
            label: acc.label,
            ...(acc.email !== undefined ? { email: acc.email } : {}),
            system: acc.system,
            ...finalized,
            share: allAccountsTotalTokens > 0
                ? Math.round((finalized.totalTokens / allAccountsTotalTokens) * 10_000) / 10_000
                : 0,
        }));
        return {
            status: 'ok',
            updatedAt: new Date(nowMs).toISOString(),
            range,
            rangeLabel: bounds.rangeLabel,
            accountId,
            groupBy,
            includeStandaloneCli,
            hasStandaloneCli,
            totals,
            models,
            daily,
            accounts: accountSummaries,
            scannedFiles,
            cachedFiles,
            elapsedMs: Date.now() - t0,
        };
    }
}

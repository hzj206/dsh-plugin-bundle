/**
 * Persistent per-account health, subscription tier history, downgrade alerts,
 * and Terms-of-Service suspension tracking (`account-health.json`).
 *
 * Also persists the Windows active account selection (`active-account.json`) so
 * hot-switched accounts survive DSH restarts without ambiguity.
 * @module dsh-llm-antigravity-acp/account-health
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
/** Official Google Antigravity ToS suspension appeal form URL. */
export const DEFAULT_TOS_APPEAL_URL = 'https://forms.gle/hGzM9MEUv2azZsrb9';
const MAX_TIER_HISTORY = 20;
function tierRank(tier) {
    switch (tier) {
        case 'ULTRA':
        case 'ENTERPRISE':
            return 3;
        case 'PRO':
            return 2;
        case 'FREE':
            return 1;
        default:
            return 0;
    }
}
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function atomicWriteJson(filePath, data) {
    let tmp;
    try {
        mkdirSync(dirname(filePath), { recursive: true });
        tmp = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        renameSync(tmp, filePath);
    }
    catch {
        if (tmp !== undefined) {
            try {
                unlinkSync(tmp);
            }
            catch { /* best-effort temp cleanup */ }
        }
        // Health store is best-effort telemetry; never crash the runtime on I/O errors.
    }
}
/** Persistent store of per-account health and downgrade history. */
export class AccountHealthStore {
    filePath;
    records = new Map();
    /** @param filePath - absolute path of `account-health.json`. */
    constructor(filePath) {
        this.filePath = filePath;
        this.load();
    }
    /**
     * Read the stored health record of one account.
     * @param accountId - account key.
     * @returns a shallow copy of the record, or undefined if never observed.
     */
    get(accountId) {
        const rec = this.records.get(accountId);
        if (rec === undefined)
            return undefined;
        return {
            ...rec,
            ...(rec.lastAvailableModels !== undefined ? { lastAvailableModels: rec.lastAvailableModels.map(m => ({ ...m })) } : {}),
            ...(rec.lastDisabledModels !== undefined ? { lastDisabledModels: [...rec.lastDisabledModels] } : {}),
            ...(rec.downgradeAlert !== undefined ? { downgradeAlert: { ...rec.downgradeAlert } } : {}),
            tierHistory: rec.tierHistory.map(e => ({ ...e })),
        };
    }
    /**
     * Record a successful subscription/model observation and detect downgrades.
     * Comparing only against the same email prevents false alerts when a slot is
     * re-signed-in with a different Google account.
     * @param accountId - account key.
     * @param obs - observed tier, model count, and email.
     * @returns the updated record.
     */
    observeSubscription(accountId, obs) {
        const now = obs.at ?? new Date().toISOString();
        const existing = this.records.get(accountId);
        const normalizedEmail = obs.email?.trim().toLowerCase();
        const prevEmail = existing?.email?.trim().toLowerCase();
        const sameIdentity = normalizedEmail === undefined || prevEmail === undefined || normalizedEmail === prevEmail;
        const rec = sameIdentity && existing !== undefined
            ? { ...existing, tierHistory: [...existing.tierHistory] }
            : { tierHistory: [] };
        if (obs.email !== undefined && obs.email.trim().length > 0) {
            rec.email = obs.email.trim();
        }
        const nextTier = obs.tier;
        const nextRank = tierRank(nextTier);
        const prevTier = rec.lastTier;
        const prevRank = tierRank(prevTier);
        const prevModels = rec.lastModelCount ?? 0;
        let changed = !sameIdentity || existing === undefined;
        if (nextTier !== undefined && nextRank > 0) {
            if (prevRank > 0 && nextRank < prevRank && prevTier !== undefined) {
                // Confirmed tier drop (e.g. PRO -> FREE or ULTRA -> PRO/FREE).
                rec.downgradeAlert = {
                    fromTier: prevTier,
                    toTier: nextTier,
                    fromModels: prevModels,
                    toModels: obs.modelCount,
                    detectedAt: now,
                    acknowledged: false,
                };
                changed = true;
            }
            else if (prevRank > 0 && nextRank > prevRank && rec.downgradeAlert !== undefined) {
                // Subscription upgraded/restored: clear stale downgrade alert.
                delete rec.downgradeAlert;
                changed = true;
            }
            const lastHist = rec.tierHistory.at(-1);
            if (lastHist === undefined || lastHist.tier !== nextTier || lastHist.modelCount !== obs.modelCount) {
                rec.tierHistory.push({
                    tier: nextTier,
                    ...(obs.subscriptionName !== undefined ? { subscriptionName: obs.subscriptionName } : {}),
                    modelCount: obs.modelCount,
                    at: now,
                });
                if (rec.tierHistory.length > MAX_TIER_HISTORY) {
                    rec.tierHistory.splice(0, rec.tierHistory.length - MAX_TIER_HISTORY);
                }
                changed = true;
            }
            if (rec.lastTier !== nextTier || rec.lastModelCount !== obs.modelCount || rec.lastSubscriptionName !== obs.subscriptionName) {
                rec.lastTier = nextTier;
                if (obs.subscriptionName !== undefined)
                    rec.lastSubscriptionName = obs.subscriptionName;
                rec.lastModelCount = obs.modelCount;
                changed = true;
            }
        }
        if (obs.availableModels !== undefined && obs.availableModels.length > 0) {
            const normalized = obs.availableModels
                .filter(m => typeof m.id === 'string' && m.id.trim().length > 0)
                .map(m => ({ id: m.id.trim(), name: (m.name || m.id).trim() }));
            if (normalized.length > 0 && JSON.stringify(rec.lastAvailableModels) !== JSON.stringify(normalized)) {
                rec.lastAvailableModels = normalized;
                changed = true;
            }
        }
        if (obs.disabledModels !== undefined) {
            const normalizedDisabled = [...new Set(obs.disabledModels.filter(id => typeof id === 'string' && id.trim().length > 0).map(id => id.trim()))];
            if (normalizedDisabled.length > 0) {
                if (JSON.stringify(rec.lastDisabledModels) !== JSON.stringify(normalizedDisabled)) {
                    rec.lastDisabledModels = normalizedDisabled;
                    changed = true;
                }
            }
            else if (rec.lastDisabledModels !== undefined) {
                delete rec.lastDisabledModels;
                changed = true;
            }
        }
        if (obs.argonSharedWithGemini !== undefined && rec.lastArgonSharedWithGemini !== obs.argonSharedWithGemini) {
            rec.lastArgonSharedWithGemini = obs.argonSharedWithGemini;
            changed = true;
        }
        if (rec.authError !== undefined || rec.authErrorAt !== undefined) {
            delete rec.authError;
            delete rec.authErrorAt;
            changed = true;
        }
        if (changed) {
            rec.updatedAt = now;
            this.records.set(accountId, rec);
            this.flush();
        }
        return this.get(accountId) ?? rec;
    }
    /**
     * Mark an account as suspended for Terms of Service violations (HTTP 403).
     * @param accountId - account key.
     * @param detail - raw error message and optional appeal link.
     */
    recordTosSuspended(accountId, detail) {
        const now = detail.at ?? new Date().toISOString();
        const rec = this.records.get(accountId) ?? { tierHistory: [] };
        if (detail.email !== undefined && detail.email.trim().length > 0)
            rec.email = detail.email.trim();
        rec.tosSuspended = true;
        rec.tosSuspendedAt = rec.tosSuspendedAt ?? now;
        rec.tosAppealUrl = detail.appealUrl ?? rec.tosAppealUrl ?? DEFAULT_TOS_APPEAL_URL;
        rec.tosError = detail.error;
        rec.updatedAt = now;
        this.records.set(accountId, rec);
        this.flush();
        return this.get(accountId) ?? rec;
    }
    /**
     * Clear a recorded ToS suspension (for example after an appeal succeeds and
     * generation or health recheck returns OK).
     * @param accountId - account key.
     */
    clearTosSuspended(accountId) {
        const rec = this.records.get(accountId);
        if (rec === undefined || rec.tosSuspended !== true)
            return;
        delete rec.tosSuspended;
        delete rec.tosSuspendedAt;
        delete rec.tosAppealUrl;
        delete rec.tosError;
        rec.updatedAt = new Date().toISOString();
        this.flush();
    }
    /**
     * Record a persisted OAuth credential error (e.g. HTTP 401 token expired or revoked)
     * so disabled/unprobed accounts keep surfacing their real auth status across restarts.
     * @param accountId - account key.
     * @param detail - account email and error message.
     */
    recordAuthError(accountId, detail) {
        const now = detail.at ?? new Date().toISOString();
        const existing = this.records.get(accountId);
        const rec = existing !== undefined
            ? { ...existing, tierHistory: [...existing.tierHistory] }
            : { tierHistory: [] };
        if (detail.email !== undefined && detail.email.trim().length > 0)
            rec.email = detail.email.trim();
        const trimmed = detail.error.trim();
        const changed = rec.authError !== trimmed || existing === undefined;
        rec.authError = trimmed;
        rec.authErrorAt = rec.authErrorAt ?? now;
        if (changed) {
            rec.updatedAt = now;
            this.records.set(accountId, rec);
            this.flush();
        }
        return this.get(accountId) ?? rec;
    }
    /**
     * Clear a persisted OAuth credential error once the account signs in again or probes OK.
     * @param accountId - account key.
     */
    clearAuthError(accountId) {
        const rec = this.records.get(accountId);
        if (rec === undefined || (rec.authError === undefined && rec.authErrorAt === undefined))
            return;
        delete rec.authError;
        delete rec.authErrorAt;
        rec.updatedAt = new Date().toISOString();
        this.flush();
    }
    /**
     * Dismiss the active downgrade banner while retaining the tier history log.
     * @param accountId - account key.
     */
    acknowledgeDowngrade(accountId) {
        const rec = this.records.get(accountId);
        if (rec?.downgradeAlert === undefined)
            return;
        rec.downgradeAlert.acknowledged = true;
        rec.updatedAt = new Date().toISOString();
        this.flush();
    }
    /** Remove state of a deleted account. */
    delete(accountId) {
        if (this.records.delete(accountId))
            this.flush();
    }
    load() {
        if (!existsSync(this.filePath))
            return;
        try {
            const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
            const root = asRecord(parsed);
            if (root === undefined)
                return;
            for (const [id, raw] of Object.entries(root)) {
                const obj = asRecord(raw);
                if (obj === undefined)
                    continue;
                const historyRaw = Array.isArray(obj.tierHistory) ? obj.tierHistory : [];
                const tierHistory = [];
                for (const item of historyRaw) {
                    const entry = asRecord(item);
                    if (entry === undefined || typeof entry.tier !== 'string' || typeof entry.at !== 'string')
                        continue;
                    tierHistory.push({
                        tier: entry.tier,
                        ...(typeof entry.subscriptionName === 'string' ? { subscriptionName: entry.subscriptionName } : {}),
                        modelCount: typeof entry.modelCount === 'number' ? entry.modelCount : 0,
                        at: entry.at,
                    });
                }
                const alertObj = asRecord(obj.downgradeAlert);
                const downgradeAlert = alertObj !== undefined
                    && typeof alertObj.fromTier === 'string'
                    && typeof alertObj.toTier === 'string'
                    && typeof alertObj.detectedAt === 'string'
                    ? {
                        fromTier: alertObj.fromTier,
                        toTier: alertObj.toTier,
                        fromModels: typeof alertObj.fromModels === 'number' ? alertObj.fromModels : 0,
                        toModels: typeof alertObj.toModels === 'number' ? alertObj.toModels : 0,
                        detectedAt: alertObj.detectedAt,
                        ...(alertObj.acknowledged === true ? { acknowledged: true } : {}),
                    }
                    : undefined;
                const lastAvailableModels = Array.isArray(obj.lastAvailableModels)
                    ? obj.lastAvailableModels
                        .map(asRecord)
                        .filter((m) => m !== undefined && typeof m.id === 'string' && m.id.trim().length > 0)
                        .map(m => ({ id: m.id.trim(), name: typeof m.name === 'string' && m.name.trim().length > 0 ? m.name.trim() : m.id.trim() }))
                    : undefined;
                const lastDisabledModels = Array.isArray(obj.lastDisabledModels)
                    ? obj.lastDisabledModels.filter((id) => typeof id === 'string' && id.trim().length > 0).map(id => id.trim())
                    : undefined;
                this.records.set(id, {
                    ...(typeof obj.email === 'string' ? { email: obj.email } : {}),
                    ...(typeof obj.lastTier === 'string' ? { lastTier: obj.lastTier } : {}),
                    ...(typeof obj.lastSubscriptionName === 'string' ? { lastSubscriptionName: obj.lastSubscriptionName } : {}),
                    ...(typeof obj.lastModelCount === 'number' ? { lastModelCount: obj.lastModelCount } : {}),
                    ...(lastAvailableModels !== undefined && lastAvailableModels.length > 0 ? { lastAvailableModels } : {}),
                    ...(lastDisabledModels !== undefined && lastDisabledModels.length > 0 ? { lastDisabledModels } : {}),
                    ...(typeof obj.lastArgonSharedWithGemini === 'boolean' ? { lastArgonSharedWithGemini: obj.lastArgonSharedWithGemini } : {}),
                    ...(downgradeAlert !== undefined ? { downgradeAlert } : {}),
                    tierHistory,
                    ...(obj.tosSuspended === true ? { tosSuspended: true } : {}),
                    ...(typeof obj.tosSuspendedAt === 'string' ? { tosSuspendedAt: obj.tosSuspendedAt } : {}),
                    ...(typeof obj.tosAppealUrl === 'string' ? { tosAppealUrl: obj.tosAppealUrl } : {}),
                    ...(typeof obj.tosError === 'string' ? { tosError: obj.tosError } : {}),
                    ...(typeof obj.authError === 'string' && obj.authError.trim().length > 0 ? { authError: obj.authError.trim() } : {}),
                    ...(typeof obj.authErrorAt === 'string' ? { authErrorAt: obj.authErrorAt } : {}),
                    ...(typeof obj.updatedAt === 'string' ? { updatedAt: obj.updatedAt } : {}),
                });
            }
        }
        catch {
            // Corrupt health file starts fresh.
        }
    }
    flush() {
        const out = {};
        for (const [id, rec] of this.records.entries())
            out[id] = rec;
        atomicWriteJson(this.filePath, out);
    }
}
/**
 * Load the persisted Windows active account pointer (`active-account.json`).
 * @param filePath - path of `active-account.json`.
 * @returns the stored pointer, or undefined when absent/invalid.
 */
export function readActiveAccountRecord(filePath) {
    if (!existsSync(filePath))
        return undefined;
    try {
        const parsed = asRecord(JSON.parse(readFileSync(filePath, 'utf8')));
        if (parsed === undefined || typeof parsed.accountId !== 'string' || parsed.accountId.trim().length === 0)
            return undefined;
        return {
            accountId: parsed.accountId.trim(),
            ...(typeof parsed.email === 'string' && parsed.email.trim().length > 0 ? { email: parsed.email.trim() } : {}),
            switchedAt: typeof parsed.switchedAt === 'string' ? parsed.switchedAt : '',
        };
    }
    catch {
        return undefined;
    }
}
/**
 * Persist the preferred/default account pointer atomically.
 * @param filePath - path of `active-account.json`.
 * @param record - active account metadata.
 */
export function writeActiveAccountRecord(filePath, record) {
    atomicWriteJson(filePath, record);
}
/** Maximum per-session account pins persisted in `session-accounts.json`. */
const MAX_SESSION_ACCOUNT_PINS = 256;
/**
 * Load persisted per-session explicit account bindings (`session-accounts.json`).
 * @param filePath - path of `session-accounts.json`.
 * @returns map of `dshSessionId -> SessionAccountPinEntry`.
 */
export function readSessionAccountPins(filePath) {
    const map = new Map();
    if (!existsSync(filePath))
        return map;
    try {
        const parsed = asRecord(JSON.parse(readFileSync(filePath, 'utf8')));
        if (parsed === undefined)
            return map;
        for (const [sessionId, raw] of Object.entries(parsed)) {
            if (sessionId.trim().length === 0)
                continue;
            const entry = asRecord(raw);
            if (entry === undefined || typeof entry.accountId !== 'string' || entry.accountId.trim().length === 0)
                continue;
            map.set(sessionId.trim(), {
                accountId: entry.accountId.trim(),
                updatedAt: typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
            });
        }
    }
    catch {
        // Corrupt session-accounts file starts clean.
    }
    return map;
}
/**
 * Persist per-session explicit account bindings atomically, retaining the newest entries.
 * @param filePath - path of `session-accounts.json`.
 * @param pins - map of `dshSessionId -> SessionAccountPinEntry`.
 */
export function writeSessionAccountPins(filePath, pins) {
    const entries = [...pins.entries()]
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .slice(0, MAX_SESSION_ACCOUNT_PINS);
    const out = {};
    for (const [sessionId, entry] of entries)
        out[sessionId] = entry;
    atomicWriteJson(filePath, out);
}

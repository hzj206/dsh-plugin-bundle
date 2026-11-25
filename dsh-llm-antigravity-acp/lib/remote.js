/**
 * Typert Remote service `antigravityAcp`: provider status, quota, warmup, live
 * configuration, and account administration for the Web client's settings card
 * and quota pill.
 * @module dsh-llm-antigravity-acp/remote
 */
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { SYSTEM_ACCOUNT_LABEL } from './accounts.js';
import { asDegradeAction, asEffort, asEngineMode } from './config.js';
/** Package name used for Typert descriptor identities. */
export const PACKAGE_NAME = 'dsh-llm-antigravity-acp';
/** Cordis service key and wire namespace. */
export const SERVICE_NAME = 'antigravityAcp';
function parseQuotaRequest(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'object' || Array.isArray(value))
        throw new TypeError('Invalid antigravity quota request');
    const force = value.force;
    if (force !== undefined && typeof force !== 'boolean')
        throw new TypeError('Invalid antigravity quota request.force');
    const accountId = value.accountId;
    if (accountId !== undefined && (typeof accountId !== 'string' || accountId.trim().length === 0)) {
        throw new TypeError('Invalid antigravity quota request.accountId');
    }
    const model = value.model;
    if (model !== undefined && (typeof model !== 'string' || model.trim().length === 0)) {
        throw new TypeError('Invalid antigravity quota request.model');
    }
    const sessionId = value.sessionId;
    if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.trim().length === 0)) {
        throw new TypeError('Invalid antigravity quota request.sessionId');
    }
    return {
        ...force === undefined ? {} : { force },
        ...typeof accountId === 'string' ? { accountId: accountId.trim() } : {},
        ...typeof model === 'string' ? { model: model.trim() } : {},
        ...typeof sessionId === 'string' ? { sessionId: sessionId.trim() } : {},
    };
}
function parseAccountId(value, label) {
    if (typeof value !== 'string' || value.trim().length === 0)
        throw new TypeError(`Invalid antigravity ${label}.accountId`);
    return value.trim();
}
function parseAccountRequest(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new TypeError(`Invalid antigravity ${label}`);
    return value;
}
function parseLoginRequest(value) {
    return { accountId: parseAccountId(parseAccountRequest(value, 'login request').accountId, 'login request') };
}
function parseLoginCodeRequest(value) {
    const record = parseAccountRequest(value, 'loginCode request');
    const accountId = parseAccountId(record.accountId, 'loginCode request');
    if (typeof record.code !== 'string' || record.code.trim().length === 0)
        throw new TypeError('Invalid antigravity loginCode request.code');
    return { accountId, code: record.code };
}
function parseSwitchAccountRequest(value) {
    const record = parseAccountRequest(value, 'switchAccount request');
    const rawAccountId = record.accountId;
    const accountId = rawAccountId === undefined || rawAccountId === null
        ? undefined
        : (() => {
            if (typeof rawAccountId !== 'string' || rawAccountId.trim().length === 0) {
                throw new TypeError('Invalid antigravity switchAccount request.accountId');
            }
            return rawAccountId.trim();
        })();
    const rawSessionId = record.sessionId;
    const sessionId = rawSessionId === undefined || rawSessionId === null
        ? undefined
        : (() => {
            if (typeof rawSessionId !== 'string' || rawSessionId.trim().length === 0) {
                throw new TypeError('Invalid antigravity switchAccount request.sessionId');
            }
            return rawSessionId.trim();
        })();
    const clear = record.clear;
    if (clear !== undefined && typeof clear !== 'boolean') {
        throw new TypeError('Invalid antigravity switchAccount request.clear');
    }
    if (clear === true) {
        if (sessionId === undefined)
            throw new TypeError('Invalid antigravity switchAccount request.sessionId');
        return { sessionId, clear: true };
    }
    if (accountId === undefined)
        throw new TypeError('Invalid antigravity switchAccount request.accountId');
    return {
        accountId,
        ...(sessionId !== undefined ? { sessionId } : {}),
    };
}
function parseSnapshotRequest(value) {
    if (value === undefined || value === null)
        return undefined;
    const record = parseAccountRequest(value, 'snapshotAccount request');
    const displayName = record.displayName;
    if (displayName !== undefined && typeof displayName !== 'string') {
        throw new TypeError('Invalid antigravity snapshotAccount request.displayName');
    }
    return displayName !== undefined ? { displayName } : {};
}
function parseImportCredentialRequest(value) {
    const record = parseAccountRequest(value, 'importCredential request');
    const content = record.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
        throw new TypeError('Invalid antigravity importCredential request.content');
    }
    const displayName = record.displayName;
    if (displayName !== undefined && typeof displayName !== 'string') {
        throw new TypeError('Invalid antigravity importCredential request.displayName');
    }
    return { content, ...(displayName !== undefined ? { displayName } : {}) };
}
/**
 * Validate one declared account of a configure request.
 *
 * The request carries the whole account list, the machine entry included as
 * its `system: true` row. A retired per-account `families` gate is ignored:
 * `visibleModels` is the only model allowlist an account has.
 * @param value - candidate entry.
 * @param index - position, used to name the offending field.
 * @returns the account profile.
 */
function parseAccountProfile(value, index) {
    const label = `Invalid antigravity configure request.accounts[${String(index)}]`;
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new TypeError(label);
    const record = value;
    const id = record.id === undefined ? '' : record.id;
    if (typeof id !== 'string')
        throw new TypeError(`${label}.id`);
    const key = id.trim();
    if (key.length > 0 && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key))
        throw new TypeError(`${label}.id`);
    const displayName = record.displayName === undefined ? '' : record.displayName;
    if (typeof displayName !== 'string')
        throw new TypeError(`${label}.displayName`);
    const home = record.home === undefined ? '' : record.home;
    if (typeof home !== 'string')
        throw new TypeError(`${label}.home`);
    const enabled = record.enabled === undefined ? true : record.enabled;
    if (typeof enabled !== 'boolean')
        throw new TypeError(`${label}.enabled`);
    const contextWindow = record.contextWindow === undefined ? 0 : record.contextWindow;
    if (typeof contextWindow !== 'number' || !Number.isInteger(contextWindow) || contextWindow < 0 || contextWindow > 1_048_576) {
        throw new TypeError(`${label}.contextWindow`);
    }
    const system = record.system === undefined ? false : record.system;
    if (typeof system !== 'boolean')
        throw new TypeError(`${label}.system`);
    const visibleModels = parseVisibleModels(record.visibleModels, `${label}.visibleModels`);
    const priority = record.priority === undefined ? 1 : record.priority;
    if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 1 || priority > 999) {
        throw new TypeError(`${label}.priority`);
    }
    const weight = record.weight === undefined ? 1 : record.weight;
    if (typeof weight !== 'number' || !Number.isInteger(weight) || weight < 1 || weight > 100) {
        throw new TypeError(`${label}.weight`);
    }
    const env = record.env === undefined ? {} : record.env;
    if (env === null || typeof env !== 'object' || Array.isArray(env))
        throw new TypeError(`${label}.env`);
    const vars = {};
    for (const [envName, entry] of Object.entries(env)) {
        if (typeof entry !== 'string')
            throw new TypeError(`${label}.env.${envName}`);
        vars[envName] = entry;
    }
    return {
        id: key,
        displayName,
        home,
        enabled,
        env: vars,
        contextWindow,
        ...system ? { system: true } : {},
        visibleModels,
        priority,
        weight,
    };
}
/**
 * Validate a model allowlist field: strings, trimmed, deduplicated, bounded.
 * An empty array is meaningful — it means "no restriction at this level".
 * @param value - candidate field, undefined when the caller omitted it.
 * @param label - dotted path used in the error message.
 * @returns the normalized ids.
 * @throws when the field is not an array of short non-empty strings.
 */
function parseVisibleModels(value, label) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value) || value.length > 500)
        throw new TypeError(label);
    const ids = [];
    for (const entry of value) {
        if (typeof entry !== 'string' || entry.trim().length === 0 || entry.length > 200)
            throw new TypeError(label);
        const id = entry.trim();
        if (!ids.includes(id))
            ids.push(id);
    }
    return ids;
}
/**
 * Validate one configure request. Retired wire fields an older settings page
 * still sends (`systemProfile`, `useSystemAccount`) and a retired per-account
 * `families` gate are ignored: the account list is the whole truth, so a page
 * that saves it never loses this Mac's own login.
 * @param value - request payload.
 * @returns the live overrides to apply.
 */
export function parseConfigureRequest(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new TypeError('Invalid antigravity configure request');
    const record = value;
    const out = {};
    const displayName = (name) => {
        if (typeof name !== 'string' || name.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
            throw new TypeError('Invalid antigravity display name: use a single line of at most 80 characters');
        }
        return name.trim();
    };
    if (record.displayName !== undefined)
        out.displayName = displayName(record.displayName);
    if (record.modelDisplayNames !== undefined) {
        const names = record.modelDisplayNames;
        if (names === null || typeof names !== 'object' || Array.isArray(names) || Object.keys(names).length > 500) {
            throw new TypeError('Invalid antigravity modelDisplayNames');
        }
        out.modelDisplayNames = Object.create(null);
        for (const [id, alias] of Object.entries(names)) {
            if (!id.trim() || id.length > 200)
                throw new TypeError('Invalid antigravity model display name id');
            const name = displayName(alias);
            if (name)
                out.modelDisplayNames[id] = name;
        }
    }
    if (record.accounts !== undefined) {
        if (!Array.isArray(record.accounts))
            throw new TypeError('Invalid antigravity configure request.accounts');
        out.accounts = record.accounts.map((entry, index) => parseAccountProfile(entry, index));
    }
    if (record.contextWindow !== undefined) {
        if (typeof record.contextWindow !== 'number' || !Number.isInteger(record.contextWindow) || record.contextWindow < 0 || record.contextWindow > 1_048_576) {
            throw new TypeError('Invalid antigravity contextWindow');
        }
        out.contextWindow = record.contextWindow;
    }
    if (record.defaultEffort !== undefined) {
        const effort = typeof record.defaultEffort === 'string' ? asEffort(record.defaultEffort) : undefined;
        if (effort === undefined)
            throw new TypeError('Invalid antigravity defaultEffort');
        out.defaultEffort = effort;
    }
    if (record.longDecodeContinuations !== undefined) {
        if (typeof record.longDecodeContinuations !== 'number' || !Number.isInteger(record.longDecodeContinuations) || record.longDecodeContinuations < 0 || record.longDecodeContinuations > 16) {
            throw new TypeError('Invalid antigravity longDecodeContinuations');
        }
        out.longDecodeContinuations = record.longDecodeContinuations;
    }
    if (record.degradeAction !== undefined) {
        const action = asDegradeAction(record.degradeAction);
        if (action === undefined)
            throw new TypeError('Invalid antigravity degradeAction');
        out.degradeAction = action;
    }
    if (record.engineMode !== undefined) {
        const mode = asEngineMode(record.engineMode);
        if (mode === undefined)
            throw new TypeError('Invalid antigravity engineMode');
        out.engineMode = mode;
    }
    if (record.realUsageCompaction !== undefined) {
        if (typeof record.realUsageCompaction !== 'boolean')
            throw new TypeError('Invalid antigravity realUsageCompaction');
        out.realUsageCompaction = record.realUsageCompaction;
    }
    if (record.visibleModels !== undefined)
        out.visibleModels = parseVisibleModels(record.visibleModels, 'Invalid antigravity configure request.visibleModels');
    return out;
}
/**
 * One reported account row as the stored profile spells it, so a save keeps
 * every entry — the machine row included — and never freezes the default
 * display label into a remark.
 * @param row - account status row.
 * @returns the account profile.
 */
export function profileFromStatus(row) {
    const label = row.label.trim();
    return {
        id: row.id,
        displayName: row.system && label === SYSTEM_ACCOUNT_LABEL ? '' : label,
        home: row.home,
        enabled: row.enabled,
        env: { ...row.env },
        contextWindow: row.contextWindow,
        ...row.system ? { system: true } : {},
        visibleModels: [...row.visibleModels],
        priority: row.priority,
        weight: row.weight,
    };
}
/**
 * Every reported account row as the profile stored in the settings profile.
 * The machine row is part of the list, so a save keeps this Mac's own login.
 * @param rows - accounts reported after the patch.
 * @returns the account list to store.
 */
export function storedAccounts(rows) {
    return rows.map(row => profileFromStatus(row));
}
function parseObject(label) {
    return (value) => {
        if (value === null || typeof value !== 'object' || Array.isArray(value))
            throw new TypeError(`Invalid ${label}`);
        return value;
    };
}
function parseArray(label) {
    return (value) => {
        if (!Array.isArray(value))
            throw new TypeError(`Invalid ${label}`);
        return value;
    };
}
function codec(typeSymbol, parse) {
    return { mode: 'strict', typeSymbol, create: () => ({ parse }) };
}
const statusCodec = codec(`${PACKAGE_NAME}#Status`, parseObject('antigravity status'));
const quotaCodec = codec(`${PACKAGE_NAME}#Quota`, parseObject('antigravity quota'));
const requestCodec = codec(`${PACKAGE_NAME}#QuotaRequest`, parseQuotaRequest);
const configureCodec = codec(`${PACKAGE_NAME}#ConfigureRequest`, parseConfigureRequest);
const accountsCodec = codec(`${PACKAGE_NAME}#Accounts`, parseArray('antigravity accounts'));
const loginCodec = codec(`${PACKAGE_NAME}#LoginRequest`, parseLoginRequest);
const switchAccountRequestCodec = codec(`${PACKAGE_NAME}#SwitchAccountRequest`, parseSwitchAccountRequest);
const loginCodeRequestCodec = codec(`${PACKAGE_NAME}#LoginCodeRequest`, parseLoginCodeRequest);
const ticketCodec = codec(`${PACKAGE_NAME}#LoginTicket`, parseObject('antigravity login ticket'));
const loginResultCodec = codec(`${PACKAGE_NAME}#LoginResult`, parseObject('antigravity login result'));
const snapshotRequestCodec = codec(`${PACKAGE_NAME}#SnapshotAccountRequest`, parseSnapshotRequest);
const importCredentialRequestCodec = codec(`${PACKAGE_NAME}#ImportCredentialRequest`, parseImportCredentialRequest);
const credentialResultCodec = codec(`${PACKAGE_NAME}#CredentialActionResult`, parseObject('antigravity credential result'));
const exportCredentialResultCodec = codec(`${PACKAGE_NAME}#CredentialExportResult`, parseObject('antigravity credential export result'));
const recheckResultCodec = codec(`${PACKAGE_NAME}#RecheckResult`, parseObject('antigravity recheck result'));
/** Invocation descriptors registered with the Host Gateway. */
export const INVOCATIONS = [
    {
        id: `${PACKAGE_NAME}#${SERVICE_NAME}/status`,
        service: SERVICE_NAME,
        namespace: SERVICE_NAME,
        method: 'status',
        invocation: { kind: 'direct' },
        parameters: [],
        result: statusCodec,
    },
    {
        id: `${PACKAGE_NAME}#${SERVICE_NAME}/quota`,
        service: SERVICE_NAME,
        namespace: SERVICE_NAME,
        method: 'quota',
        invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: true, codec: requestCodec }],
        result: quotaCodec,
    },
    {
        id: `${PACKAGE_NAME}#${SERVICE_NAME}/warmup`,
        service: SERVICE_NAME,
        namespace: SERVICE_NAME,
        method: 'warmup',
        invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: true, codec: requestCodec }],
        result: statusCodec,
    },
    {
        id: `${PACKAGE_NAME}#${SERVICE_NAME}/configure`,
        service: SERVICE_NAME,
        namespace: SERVICE_NAME,
        method: 'configure',
        invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: false, codec: configureCodec }],
        result: statusCodec,
    },
    {
        id: `${PACKAGE_NAME}#${SERVICE_NAME}/accounts`,
        service: SERVICE_NAME,
        namespace: SERVICE_NAME,
        method: 'accounts',
        invocation: { kind: 'direct' },
        parameters: [],
        result: accountsCodec,
    },
    {
        id: `${PACKAGE_NAME}#${SERVICE_NAME}/login`,
        service: SERVICE_NAME,
        namespace: SERVICE_NAME,
        method: 'login',
        invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: false, codec: loginCodec }],
        result: ticketCodec,
    },
    {
        id: `${PACKAGE_NAME}#${SERVICE_NAME}/loginCode`,
        service: SERVICE_NAME,
        namespace: SERVICE_NAME,
        method: 'loginCode',
        invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: false, codec: loginCodeRequestCodec }],
        result: loginResultCodec,
    },
    {
        id: `${PACKAGE_NAME}#${SERVICE_NAME}/cancelLogin`,
        service: SERVICE_NAME,
        namespace: SERVICE_NAME,
        method: 'cancelLogin',
        invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: false, codec: loginCodec }],
        result: statusCodec,
    },
    {
        id: `${PACKAGE_NAME}#${SERVICE_NAME}/switchAccount`,
        service: SERVICE_NAME,
        namespace: SERVICE_NAME,
        method: 'switchAccount',
        invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: false, codec: switchAccountRequestCodec }],
        result: statusCodec,
    },
    {
        id: `${PACKAGE_NAME}#${SERVICE_NAME}/snapshotAccount`,
        service: SERVICE_NAME,
        namespace: SERVICE_NAME,
        method: 'snapshotAccount',
        invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: true, codec: snapshotRequestCodec }],
        result: credentialResultCodec,
    },
    {
        id: `${PACKAGE_NAME}#${SERVICE_NAME}/importCredential`,
        service: SERVICE_NAME,
        namespace: SERVICE_NAME,
        method: 'importCredential',
        invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: false, codec: importCredentialRequestCodec }],
        result: credentialResultCodec,
    },
    {
        id: `${PACKAGE_NAME}#${SERVICE_NAME}/exportCredential`,
        service: SERVICE_NAME,
        namespace: SERVICE_NAME,
        method: 'exportCredential',
        invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: false, codec: loginCodec }],
        result: exportCredentialResultCodec,
    },
    {
        id: `${PACKAGE_NAME}#${SERVICE_NAME}/recheckAccount`,
        service: SERVICE_NAME,
        namespace: SERVICE_NAME,
        method: 'recheckAccount',
        invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: false, codec: loginCodec }],
        result: recheckResultCodec,
    },
    {
        id: `${PACKAGE_NAME}#${SERVICE_NAME}/ackDowngrade`,
        service: SERVICE_NAME,
        namespace: SERVICE_NAME,
        method: 'ackDowngrade',
        invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: false, codec: loginCodec }],
        result: statusCodec,
    },
];
/** Remote facade over the runtime. */
export class AntigravityRemote extends TypertRemoteService {
    options;
    /**
     * @param ctx - owning context.
     * @param options - runtime and settings namespace.
     */
    constructor(ctx, options) {
        super(ctx, SERVICE_NAME);
        this.options = options;
    }
    /**
     * Provider status.
     * @returns the status snapshot.
     */
    status() {
        return this.options.runtime.status();
    }
    /**
     * Plan quota for every model group.
     * @param request - optional cache bypass, account, or model to resolve.
     * @returns the quota snapshot.
     */
    quota(request) {
        const force = request?.force === true;
        if (request?.accountId !== undefined)
            return this.options.runtime.quotaFor(request.accountId, force);
        if (request?.model !== undefined)
            return this.options.runtime.quotaForModel(request.model, force, request.sessionId);
        return this.options.runtime.quotaFor(undefined, force);
    }
    /**
     * Refresh the catalog of one or all accounts without sending a prompt.
     * @param request - optional target `accountId`.
     * @returns the status after warmup.
     */
    async warmup(request) {
        try {
            await this.options.runtime.warmup(request?.accountId);
        }
        catch (_warmupFailure) {
            // The failure is reported through the returned status.
        }
        return this.options.runtime.status();
    }
    /**
     * Apply live settings and persist them into the profile settings when writable.
     * @param request - updated configuration fields.
     * @returns updated status.
     */
    async configure(request) {
        const patch = parseConfigureRequest(request);
        const settings = this.ctx.get('settings');
        // Alias edits must not look saved when the profile refused persistence.
        const aliases = {
            ...patch.displayName !== undefined ? { displayName: patch.displayName } : {},
            ...patch.modelDisplayNames !== undefined ? { modelDisplayNames: patch.modelDisplayNames } : {},
        };
        if (Object.keys(aliases).length > 0) {
            if (settings?.writable !== true || typeof settings.update !== 'function')
                throw new Error('Display aliases require writable profile settings');
            await settings.update(this.options.settingsNs, { ...aliases });
        }
        const status = this.options.runtime.configure(patch);
        if (settings?.writable === true && typeof settings.update === 'function') {
            const { displayName: _displayName, modelDisplayNames: _modelDisplayNames, ...stored } = patch;
            if (patch.accounts !== undefined) {
                // The machine account travels inside the list: storing the reported
                // rows keeps it and leaves its default label unremark'd. A request
                // that dropped it stores a list without it, which is the removal.
                stored.accounts = storedAccounts(status.accounts);
            }
            try {
                if (Object.keys(stored).length > 0)
                    await settings.update(this.options.settingsNs, { ...stored });
            }
            catch (_persistSkipped) {
                // Ephemeral or overlay-mounted entries may not exist in the profile patch; in-memory override still applies.
            }
        }
        return status;
    }
    /**
     * Every configured account with its live process state, cooldowns, and sign-in.
     * @returns one row per account in configured order.
     */
    async accounts() {
        await this.options.runtime.refreshAccountEmails(true);
        return this.options.runtime.accounts();
    }
    /**
     * Create the account sandbox and start an interactive sign-in.
     * @param request - the account to sign in.
     * @returns the authorization URL and the equivalent terminal command.
     */
    login(request) {
        return this.options.runtime.beginLogin(parseLoginRequest(request).accountId);
    }
    /**
     * Finish an interactive sign-in with the authorization code from the browser.
     * @param request - the account and its authorization code.
     * @returns whether the account now holds a credential.
     */
    loginCode(request) {
        const parsed = parseLoginCodeRequest(request);
        return this.options.runtime.completeLogin(parsed.accountId, parsed.code);
    }
    /**
     * Abandon a pending interactive sign-in.
     * @param request - the account whose sign-in should stop.
     * @returns status after the sign-in process was terminated.
     */
    cancelLogin(request) {
        this.options.runtime.cancelLogin(parseLoginRequest(request).accountId);
        return this.options.runtime.status();
    }
    /**
     * Bind a specific DSH conversation/session to a chosen account (or clear its
     * explicit pin), or update the global default account when `sessionId` is omitted.
     * @param request - target account id and optional `sessionId` / `clear`.
     * @returns updated status snapshot.
     */
    async switchAccount(request) {
        const parsed = parseSwitchAccountRequest(request);
        const wasDisabled = parsed.accountId !== undefined
            && this.options.runtime.accounts().some(row => row.id === parsed.accountId && row.enabled === false);
        const status = await this.options.runtime.switchActiveAccount(parsed.accountId, {
            ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
            ...(parsed.clear === true ? { clear: true } : {}),
        });
        if (wasDisabled) {
            await this.persistAccounts(status.accounts);
        }
        return status;
    }
    /**
     * Snapshot the current Windows Credential Manager login into a permanent slot
     * and persist any newly added account row into profile settings.
     * @param request - optional remark for a newly created slot.
     * @returns saved account metadata and updated status.
     */
    async snapshotAccount(request) {
        const parsed = parseSnapshotRequest(request);
        const result = await this.options.runtime.snapshotCurrentAccount(parsed?.displayName);
        await this.persistAccountsIfCreated(result);
        return result;
    }
    /**
     * Import a permanent OAuth credential backup (JSON content or local file path)
     * into an isolated account slot and persist the updated account list.
     * @param request - credential backup payload or path, plus optional remark.
     * @returns saved account metadata and updated status.
     */
    async importCredential(request) {
        const parsed = parseImportCredentialRequest(request);
        const result = await this.options.runtime.importAccountCredential(parsed);
        await this.persistAccountsIfCreated(result);
        return result;
    }
    /**
     * Safely export one account's permanent OAuth credential to a local 0600 backup
     * file under `<primaryHome>/credential-backups/`. Never returns secret tokens over RPC.
     * @param request - target account id.
     * @returns metadata including the saved local file path.
     */
    exportCredential(request) {
        return this.options.runtime.exportAccountCredential(parseLoginRequest(request).accountId);
    }
    /**
     * Recheck verification / ToS suspension status and live quota for one account.
     * @param request - target account id.
     * @returns updated status and quota snapshot.
     */
    recheckAccount(request) {
        return this.options.runtime.recheckAccount(parseLoginRequest(request).accountId);
    }
    /**
     * Dismiss an account's subscription downgrade banner while retaining tier history.
     * @param request - target account id.
     * @returns updated status snapshot.
     */
    ackDowngrade(request) {
        return this.options.runtime.acknowledgeDowngrade(parseLoginRequest(request).accountId);
    }
    async persistAccountsIfCreated(result) {
        if (!result.created)
            return;
        await this.persistAccounts(result.status.accounts);
    }
    async persistAccounts(rows) {
        const settings = this.ctx.get('settings');
        if (settings?.writable !== true || typeof settings.update !== 'function')
            return;
        try {
            await settings.update(this.options.settingsNs, { accounts: storedAccounts(rows) });
        }
        catch {
            // Ephemeral/overlay settings may skip persistence; runtime state still applies.
        }
    }
}
/**
 * Register the invocation descriptors with the Host Gateway when present.
 * @param ctx - plugin context.
 */
export function registerRemote(ctx) {
    ctx.inject(['typert'], (scope) => {
        scope.effect(() => {
            const registrar = scope.get('typert');
            if (registrar === undefined || typeof registrar.register !== 'function')
                return () => undefined;
            return registrar.register({
                package: PACKAGE_NAME,
                face: 'host',
                schemas: [],
                model: { services: [], events: [], objects: [] },
                invocations: INVOCATIONS,
            });
        }, 'antigravity-acp: remote descriptors');
    });
}

/**
 * Shared storage layer for an account's Antigravity login blob: the one place
 * that knows how `agy` stores credentials (`go-keyring-base64:`-prefixed
 * base64 JSON in the OS keychain, plain JSON in `antigravity-oauth-token`).
 *
 * Both the account pool (which only needs the email) and the Cloud Code client
 * (which needs the whole OAuth credential) decode the same blobs, so the keychain
 * unlock, the `security` argv, the timeouts and the file fallback live here only.
 * This module deliberately imports nothing from `accounts.ts` or `cloudcode.ts`
 * so both can depend on it without a cycle.
 * @module dsh-llm-antigravity-acp/credential
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandRunner } from './preflight.ts'
import { parseOAuthBlob, readWindowsCredential, updateTokenJsonAfterRefresh } from './wincred.ts'

/** Prefix `agy` writes in front of the base64 JSON blob stored by `go-keyring`. */
export const GO_KEYRING_BASE64_PREFIX = 'go-keyring-base64:'

/** Layout fields the credential reader needs; structurally satisfied by `AccountLayout`. */
export interface CredentialLayout {
  /** True when the account reuses this machine's own login (no sandboxed `$HOME`). */
  system: boolean
  /** `$HOME` the keychain lookup is scoped to. */
  homeDir: string
  /** `--app-data-dir` that owns the `antigravity-oauth-token` fallback file. */
  appDir: string
}

/** Optional Windows routing flags for {@link readStoredCredentialRaw}. */
export interface ReadCredentialOptions {
  /**
   * On Windows, whether this slot currently owns the global Windows Credential
   * Manager entry (`gemini:antigravity`). Defaults to `layout.system`.
   * Inactive Windows backup slots MUST pass `false` so they read only their own
   * `antigravity-oauth-token` file and never bleed into the active account.
   */
  useWindowsCredentialManager?: boolean
  /** When true, reading a fresher WinCred blob also mirrors it into the slot's token file. */
  syncFileOnWinCredRead?: boolean
  /**
   * Whether `QuotaReader` may fall back to `agy -p /usage` if no local token
   * file is readable. Set to `false` for inactive Windows backup slots so CLI
   * fallback never leaks the active WinCred account's quota into a backup row.
   */
  allowCliFallback?: boolean
}

/** Path of one account's permanent OAuth token file under its ACP app-data directory. */
export function credentialFilePath(appDir: string): string {
  return join(appDir, 'antigravity-oauth-token')
}

/** Secondary CLI token path inside a non-system account's isolated home (`<homeDir>/.gemini/antigravity-cli`). */
export function cliHomeCredentialDir(homeDir: string): string {
  return join(homeDir, '.gemini', 'antigravity-cli')
}

/**
 * Atomically write a normalized OAuth credential JSON file to `<appDir>/antigravity-oauth-token`.
 * Keeps a `.bak` copy of the prior file when requested so an unexpected crash never loses a refresh token.
 * @param appDir - account app-data directory.
 * @param rawJson - validated OAuth credential JSON string.
 * @param keepBackup - copy existing file to `.bak` before replacing (default true).
 */
export function writeStoredCredentialFile(appDir: string, rawJson: string, keepBackup = true): void {
  const file = credentialFilePath(appDir)
  mkdirSync(appDir, { recursive: true })
  if (keepBackup && existsSync(file)) {
    try {
      const bak = `${file}.bak`
      copyFileSync(file, bak)
      try { chmodSync(bak, 0o600) } catch { /* Windows ignores POSIX chmod */ }
    } catch {
      // Best-effort backup.
    }
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, rawJson, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* best-effort temp cleanup */ }
    throw error
  }
}

/**
 * Write one slot's permanent OAuth credential file, and for non-system isolated
 * slots also mirror it into `<homeDir>/.gemini/antigravity-cli/antigravity-oauth-token`
 * so both `agy acp --gemini-dir ... --app-data-dir agy` and `agy -p` / `agy models`
 * resolve the exact same isolated credential.
 * @param layout - account credential layout.
 * @param rawJson - validated OAuth credential JSON string.
 * @param keepBackup - copy existing file to `.bak` before replacing (default true).
 */
export function writeSlotCredentialFile(layout: CredentialLayout, rawJson: string, keepBackup = true): void {
  writeStoredCredentialFile(layout.appDir, rawJson, keepBackup)
  if (!layout.system) {
    try {
      writeStoredCredentialFile(cliHomeCredentialDir(layout.homeDir), rawJson, false)
    } catch {
      // Best-effort mirror for CLI subcommands (`agy -p`, `agy models`).
    }
  }
}

/**
 * Read one account's local `antigravity-oauth-token` file directly without touching OS keychains.
 * @param appDir - account app-data directory.
 * @returns raw file text, or undefined when absent or unreadable.
 */
export function readStoredCredentialFileRaw(appDir: string): string | undefined {
  const file = credentialFilePath(appDir)
  if (!existsSync(file)) return undefined
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Persist a freshly refreshed OAuth access token back into `<appDir>/antigravity-oauth-token`,
 * keeping the account's permanent `refresh_token` and all metadata intact.
 * @param appDir - account app-data directory.
 * @param refreshed - new access token fields returned by Google OAuth.
 * @param mirrorLayout - optional slot layout; when non-system, also mirrors the CLI home copy.
 * @returns true when the file was updated.
 */
export function persistRefreshedCredentialFile(
  appDir: string,
  refreshed: { accessToken: string; expiresInSeconds?: number; refreshToken?: string },
  mirrorLayout?: CredentialLayout,
): boolean {
  const existing = readStoredCredentialFileRaw(appDir)
  if (existing === undefined) return false
  const updated = updateTokenJsonAfterRefresh(existing, refreshed)
  if (updated === undefined) return false
  try {
    if (mirrorLayout !== undefined) writeSlotCredentialFile(mirrorLayout, updated, false)
    else writeStoredCredentialFile(appDir, updated, false)
    return true
  } catch {
    return false
  }
}

/**
 * Unwrap one stored credential blob into its JSON text.
 * Supports `go-keyring-base64:<base64>` (written by `agy` via `go-keyring` on
 * macOS Keychain) and plain JSON token files; JWT payloads stay to the caller.
 * @param raw - token payload from the keychain or oauth-token file.
 * @returns the JSON text, or undefined when the blob is empty or undecodable.
 */
export function decodeStoredCredential(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  if (!trimmed.startsWith(GO_KEYRING_BASE64_PREFIX)) return trimmed
  try {
    return Buffer.from(trimmed.slice(GO_KEYRING_BASE64_PREFIX.length).trim(), 'base64').toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * Unlock the empty-password login keychain of a sandboxed account. macOS
 * resolves the default keychain from `$HOME/Library/Keychains`, so a non-system
 * account has to be unlocked before any `security find-generic-password` lookup
 * scoped to that home can succeed. Missing keychain files and failed unlocks are
 * both ignored: the caller falls back to the token file.
 * @param layout - account layout (or any object carrying `homeDir`).
 * @param run - helper command runner.
 */
export async function unlockAccountKeychain(layout: Pick<CredentialLayout, 'homeDir'>, run: CommandRunner): Promise<void> {
  const kcPath = join(layout.homeDir, 'Library', 'Keychains', 'login.keychain-db')
  if (!existsSync(kcPath)) return
  await run(['security', 'unlock-keychain', '-p', '', kcPath], 5_000, { HOME: layout.homeDir }).catch(() => undefined)
}

/**
 * Read one account's raw stored credential: the sandboxed keychain first, the
 * `antigravity-oauth-token` file second. A keychain blob the caller cannot use
 * (`accept` returns false) falls through to the file exactly as before.
 *
 * macOS resolves the default keychain from `$HOME/Library/Keychains`, so a
 * non-system account unlocks its own empty-password keychain first (only when
 * the file exists) and every lookup then runs with `HOME` pointing at it.
 * @param layout - account layout (or any object carrying these three fields).
 * @param run - helper command runner.
 * @param platform - host platform, injectable for tests.
 * @param accept - predicate deciding whether a raw blob is usable.
 * @returns the raw blob, or undefined when the account is not signed in.
 */
export async function readStoredCredentialRaw(
  layout: CredentialLayout,
  run: CommandRunner,
  platform: NodeJS.Platform = process.platform,
  accept: (raw: string) => boolean = () => true,
  options: ReadCredentialOptions = {},
): Promise<string | undefined> {
  if (platform === 'darwin') {
    if (!layout.system) await unlockAccountKeychain(layout, run)
    const argv = ['security', 'find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w']
    const stored = layout.system ? await run(argv, 10_000) : await run(argv, 10_000, { HOME: layout.homeDir })
    if (stored.code === 0 && accept(stored.stdout)) return stored.stdout
  }
  if (platform === 'win32') {
    const useWinCred = options.useWindowsCredentialManager ?? layout.system
    if (useWinCred) {
      const winRaw = await readWindowsCredential(run).catch(() => undefined)
      if (winRaw !== undefined && accept(winRaw)) {
        // Mirror the fresh WinCred blob into the slot's local file only when
        // it matches the slot's existing email (or the slot has no file yet),
        // so an external WinCred login never clobbers another saved account's file.
        if (options.syncFileOnWinCredRead !== false) {
          const parsedWin = parseOAuthBlob(winRaw)
          if (parsedWin !== undefined && parsedWin.hasRefreshToken) {
            const existingRaw = readStoredCredentialFileRaw(layout.appDir)
            const existingEmail = existingRaw !== undefined ? parseOAuthBlob(existingRaw)?.email?.toLowerCase() : undefined
            const winEmail = parsedWin.email?.toLowerCase()
            if (existingEmail === undefined || winEmail === undefined || existingEmail === winEmail) {
              try {
                writeStoredCredentialFile(layout.appDir, parsedWin.rawJson, false)
              } catch {
                // Best-effort mirror.
              }
            }
          }
        }
        return winRaw
      }
    }
  }
  const candidates: string[] = [credentialFilePath(layout.appDir)]
  if (!layout.system) {
    const cliFile = credentialFilePath(cliHomeCredentialDir(layout.homeDir))
    if (cliFile !== candidates[0]) candidates.push(cliFile)
  }
  const readable: { path: string; mtimeMs: number }[] = []
  for (const candidate of candidates) {
    try {
      const st = statSync(candidate)
      if (st.size > 0) readable.push({ path: candidate, mtimeMs: st.mtimeMs })
    } catch {
      // Missing candidate file.
    }
  }
  readable.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const item of readable) {
    try {
      const raw = readFileSync(item.path, 'utf8')
      if (accept(raw)) {
        if (!layout.system && item.path !== candidates[0]) {
          try {
            writeStoredCredentialFile(layout.appDir, raw, false)
          } catch {
            // Best-effort sync from isolated CLI home into ACP appDir.
          }
        }
        return raw
      }
    } catch {
      // Try next candidate.
    }
  }
  return undefined
}

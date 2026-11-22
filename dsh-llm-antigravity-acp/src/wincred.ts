/**
 * Native Windows Credential Manager bridge (`gemini:antigravity`) and
 * credential blob validation/normalization for permanent OAuth tokens.
 *
 * `agy.exe` on Windows stores its single active OAuth credential in the current
 * user's Windows Credential Manager (`CRED_TYPE_GENERIC`, target
 * `gemini:antigravity`) regardless of `$HOME` or `%USERPROFILE%`. This module
 * lets the plugin read and atomically swap that credential safely without
 * putting secrets in process argv or leaking them to logs.
 * @module dsh-llm-antigravity-acp/wincred
 */

import type { CommandRunner } from './preflight.ts'

/** Windows Credential Manager target used by official `agy.exe`. */
export const WINCRED_TARGET = 'gemini:antigravity'
/** Windows Credential Manager username used by official `agy.exe`. */
export const WINCRED_USERNAME = 'antigravity'
/** `CRED_TYPE_GENERIC` (1). */
export const WINCRED_TYPE_GENERIC = 1
/** `CRED_PERSIST_LOCAL_MACHINE` (2). */
export const WINCRED_PERSIST_LOCAL_MACHINE = 2

const GO_KEYRING_BASE64_PREFIX = 'go-keyring-base64:'
const WINCRED_TIMEOUT_MS = 15_000
const OUTPUT_PREFIX = 'AGY_WINCRED_B64:'
const NOT_FOUND_MARKER = 'AGY_WINCRED_NOT_FOUND'

/** Normalized metadata extracted from one Antigravity OAuth credential blob. */
export interface ParsedOAuthBlob {
  /** Normalized UTF-8 JSON payload ready to store in WinCred or `antigravity-oauth-token`. */
  rawJson: string
  /** Account email from `id_token_email`, `email`, or JWT `id_token` claims. */
  email?: string
  /** Current OAuth access token. */
  accessToken: string
  /** Permanent OAuth refresh token when present. */
  refreshToken?: string
  /** Expiry timestamp in epoch milliseconds when parseable. */
  expiryMs?: number
  /** True when a non-empty permanent `refresh_token` is present. */
  hasRefreshToken: boolean
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function decodeJwtEmail(jwt: string): string | undefined {
  const parts = jwt.split('.')
  if (parts.length < 2) return undefined
  const segment = parts[1] ?? ''
  if (segment.length === 0) return undefined
  try {
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/')
    const padLen = (4 - (padded.length % 4)) % 4
    const parsed = JSON.parse(Buffer.from(padded + '='.repeat(padLen), 'base64').toString('utf8')) as unknown
    const claims = asRecord(parsed)
    const email = claims?.email
    return typeof email === 'string' && email.includes('@') ? email.trim() : undefined
  } catch {
    return undefined
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Unwrap a raw credential blob (plain JSON or `go-keyring-base64:...`) into
 * normalized JSON and structured token metadata.
 * @param raw - credential string from WinCred, keychain, or token file.
 * @returns parsed metadata, or undefined when the blob is malformed or lacks an access token.
 */
export function parseOAuthBlob(raw: string): ParsedOAuthBlob | undefined {
  const cleaned = stripBom(raw).trim()
  if (cleaned.length === 0) return undefined
  let jsonText = cleaned
  if (cleaned.startsWith(GO_KEYRING_BASE64_PREFIX)) {
    try {
      jsonText = Buffer.from(cleaned.slice(GO_KEYRING_BASE64_PREFIX.length).trim(), 'base64').toString('utf8').trim()
    } catch {
      return undefined
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return undefined
  }
  const outer = asRecord(parsed)
  if (outer === undefined) return undefined
  const inner = asRecord(outer.token) ?? outer
  const accessToken = typeof inner.access_token === 'string' ? inner.access_token.trim() : ''
  if (accessToken.length === 0) return undefined
  const refreshRaw = typeof inner.refresh_token === 'string'
    ? inner.refresh_token.trim()
    : (typeof outer.refresh_token === 'string' ? outer.refresh_token.trim() : '')
  const refreshToken = refreshRaw.length > 0 ? refreshRaw : undefined

  let expiryMs: number | undefined
  if (typeof inner.expiry === 'string') {
    const ms = Date.parse(inner.expiry)
    if (Number.isFinite(ms)) expiryMs = ms
  } else if (typeof inner.expires_at === 'number' && Number.isFinite(inner.expires_at)) {
    expiryMs = inner.expires_at > 1e12 ? inner.expires_at : inner.expires_at * 1000
  }

  let email: string | undefined
  if (typeof outer.id_token_email === 'string' && outer.id_token_email.trim().length > 0) {
    email = outer.id_token_email.trim()
  } else if (typeof outer.email === 'string' && outer.email.trim().length > 0) {
    email = outer.email.trim()
  } else if (typeof outer.id_token === 'string' && outer.id_token.trim().length > 0) {
    email = decodeJwtEmail(outer.id_token.trim())
  } else if (typeof inner.id_token === 'string' && inner.id_token.trim().length > 0) {
    email = decodeJwtEmail(inner.id_token.trim())
  }

  return {
    rawJson: jsonText,
    ...(email !== undefined ? { email } : {}),
    accessToken,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(expiryMs !== undefined ? { expiryMs } : {}),
    hasRefreshToken: refreshToken !== undefined,
  }
}

/**
 * Parse an externally exported credential backup. Supports:
 * - `agy_cred.ps1` backup JSON (`{ target, blobBase64, email?, ... }`)
 * - Raw `antigravity-oauth-token` JSON
 * - `go-keyring-base64:...` blobs
 * @param content - raw text pasted or read from a backup file.
 * @returns parsed permanent credential metadata, or undefined when invalid.
 */
export function parseImportedCredential(content: string): ParsedOAuthBlob | undefined {
  const cleaned = stripBom(content).trim()
  if (cleaned.length === 0) return undefined
  const direct = parseOAuthBlob(cleaned)
  if (direct !== undefined) return direct
  try {
    const wrapper = asRecord(JSON.parse(cleaned))
    if (wrapper !== undefined && typeof wrapper.blobBase64 === 'string' && wrapper.blobBase64.trim().length > 0) {
      const decoded = Buffer.from(wrapper.blobBase64.trim(), 'base64').toString('utf8')
      const inner = parseOAuthBlob(decoded)
      if (inner !== undefined) {
        if (inner.email === undefined && typeof wrapper.email === 'string' && wrapper.email.includes('@')) {
          return { ...inner, email: wrapper.email.trim() }
        }
        return inner
      }
    }
  } catch {
    // Not a JSON wrapper.
  }
  return undefined
}

/**
 * Merge a freshly refreshed OAuth access token into a stored credential JSON,
 * preserving every existing field (`refresh_token`, `id_token_email`,
 * `project_id`, `user_tier`, etc.).
 * @param existingRaw - current stored credential text.
 * @param refreshed - newly issued token fields from Google OAuth.
 * @returns updated JSON string, or undefined when the existing blob could not be parsed.
 */
export function updateTokenJsonAfterRefresh(
  existingRaw: string,
  refreshed: { accessToken: string; expiresInSeconds?: number; refreshToken?: string },
): string | undefined {
  const parsed = parseOAuthBlob(existingRaw)
  if (parsed === undefined) return undefined
  try {
    const outer = JSON.parse(parsed.rawJson) as Record<string, unknown>
    const expiryIso = new Date(Date.now() + Math.max(60, (refreshed.expiresInSeconds ?? 3500) - 60) * 1000).toISOString()
    const nested = asRecord(outer.token)
    if (nested !== undefined) {
      nested.access_token = refreshed.accessToken
      nested.expiry = expiryIso
      if (refreshed.refreshToken !== undefined && refreshed.refreshToken.length > 0) {
        nested.refresh_token = refreshed.refreshToken
      }
      outer.token = nested
    } else {
      outer.access_token = refreshed.accessToken
      outer.expiry = expiryIso
      if (refreshed.refreshToken !== undefined && refreshed.refreshToken.length > 0) {
        outer.refresh_token = refreshed.refreshToken
      }
    }
    return JSON.stringify(outer)
  } catch {
    return undefined
  }
}

const CS_WINCRED_TYPE = `
using System;
using System.Runtime.InteropServices;
public static class DshAgyWinCred {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWriteW(ref CREDENTIAL credential, int flags);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern void CredFree(IntPtr cred);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags;
    public int Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }
}
`

const READ_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${CS_WINCRED_TYPE}
'@
$target = if ($env:AGY_WINCRED_TARGET) { $env:AGY_WINCRED_TARGET } else { '${WINCRED_TARGET}' }
$found = $false
foreach ($t in 1, 2, 4) {
  $ptr = [IntPtr]::Zero
  if ([DshAgyWinCred]::CredReadW($target, $t, 0, [ref]$ptr)) {
    try {
      $c = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][DshAgyWinCred+CREDENTIAL])
      $bytes = New-Object byte[] $c.CredentialBlobSize
      if ($c.CredentialBlobSize -gt 0) {
        [System.Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $bytes, 0, $c.CredentialBlobSize)
      }
      Write-Output ('${OUTPUT_PREFIX}' + [Convert]::ToBase64String($bytes))
      $found = $true
      break
    } finally {
      [DshAgyWinCred]::CredFree($ptr)
    }
  }
}
if (-not $found) { Write-Output '${NOT_FOUND_MARKER}' }
`

const WRITE_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${CS_WINCRED_TYPE}
'@
$target = if ($env:AGY_WINCRED_TARGET) { $env:AGY_WINCRED_TARGET } else { '${WINCRED_TARGET}' }
$user = if ($env:AGY_WINCRED_USER) { $env:AGY_WINCRED_USER } else { '${WINCRED_USERNAME}' }
$b64 = $env:AGY_WINCRED_PAYLOAD_B64
if (-not $b64) { throw 'missing credential payload' }
$bytes = [Convert]::FromBase64String($b64)
$c = New-Object DshAgyWinCred+CREDENTIAL
$c.Type = ${WINCRED_TYPE_GENERIC}
$c.Persist = ${WINCRED_PERSIST_LOCAL_MACHINE}
$c.TargetName = [System.Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($target)
$c.UserName = [System.Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($user)
$c.Comment = [IntPtr]::Zero
$c.TargetAlias = [IntPtr]::Zero
$c.Attributes = [IntPtr]::Zero
$c.AttributeCount = 0
$c.CredentialBlobSize = $bytes.Length
$c.CredentialBlob = [System.Runtime.InteropServices.Marshal]::AllocCoTaskMem($bytes.Length)
[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $c.CredentialBlob, $bytes.Length)
try {
  $ok = [DshAgyWinCred]::CredWriteW([ref]$c, 0)
  if (-not $ok) { throw ('CredWriteW failed: ' + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  Write-Output 'AGY_WINCRED_WRITTEN'
} finally {
  [System.Runtime.InteropServices.Marshal]::FreeCoTaskMem($c.TargetName)
  [System.Runtime.InteropServices.Marshal]::FreeCoTaskMem($c.UserName)
  [System.Runtime.InteropServices.Marshal]::FreeCoTaskMem($c.CredentialBlob)
}
`

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

const READ_ENCODED = encodePowerShell(READ_SCRIPT)
const WRITE_ENCODED = encodePowerShell(WRITE_SCRIPT)

function powershellArgv(encoded: string): string[] {
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]
}

/**
 * Read the raw UTF-8 credential string from Windows Credential Manager.
 * @param run - command runner.
 * @param target - WinCred target name (defaults to `gemini:antigravity`).
 * @returns raw UTF-8 credential string, or undefined when absent or unreadable.
 */
export async function readWindowsCredential(
  run: CommandRunner,
  target = WINCRED_TARGET,
): Promise<string | undefined> {
  const res = await run(
    powershellArgv(READ_ENCODED),
    WINCRED_TIMEOUT_MS,
    { AGY_WINCRED_TARGET: target },
  )
  if (res.code !== 0) return undefined
  const lines = res.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  for (const line of lines) {
    if (line === NOT_FOUND_MARKER) return undefined
    if (line.startsWith(OUTPUT_PREFIX)) {
      const b64 = line.slice(OUTPUT_PREFIX.length).trim()
      if (b64.length === 0) return undefined
      try {
        return Buffer.from(b64, 'base64').toString('utf8')
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

/** Options that guard a write to Windows Credential Manager. */
export interface WriteWindowsCredentialOptions {
  target?: string
  userName?: string
  /** Reject blobs lacking a permanent `refresh_token` (default true). */
  requireRefreshToken?: boolean
  /** Reject blobs whose email does not match this expected address. */
  expectedEmail?: string
}

/**
 * Validate and atomically write an Antigravity OAuth JSON blob to Windows
 * Credential Manager. Secrets travel via one-shot child environment variable
 * (`AGY_WINCRED_PAYLOAD_B64`), never via process argv or temp files.
 * @param run - command runner.
 * @param rawJson - OAuth credential JSON (or `go-keyring-base64:...` blob).
 * @param options - validation and target overrides.
 * @returns the validated parsed metadata that was written.
 */
export async function writeWindowsCredential(
  run: CommandRunner,
  rawJson: string,
  options: WriteWindowsCredentialOptions = {},
): Promise<ParsedOAuthBlob> {
  const parsed = parseOAuthBlob(rawJson)
  if (parsed === undefined) {
    throw new Error('antigravity-acp: refusing to write malformed OAuth credential to Windows Credential Manager')
  }
  if (options.requireRefreshToken !== false && !parsed.hasRefreshToken) {
    throw new Error('antigravity-acp: refusing to write credential without a permanent refresh_token to Windows Credential Manager')
  }
  if (
    options.expectedEmail !== undefined
    && options.expectedEmail.trim().length > 0
    && parsed.email !== undefined
    && parsed.email.toLowerCase() !== options.expectedEmail.trim().toLowerCase()
  ) {
    throw new Error(`antigravity-acp: credential email "${parsed.email}" does not match expected account "${options.expectedEmail}"`)
  }

  const payloadB64 = Buffer.from(parsed.rawJson, 'utf8').toString('base64')
  const res = await run(
    powershellArgv(WRITE_ENCODED),
    WINCRED_TIMEOUT_MS,
    {
      AGY_WINCRED_TARGET: options.target ?? WINCRED_TARGET,
      AGY_WINCRED_USER: options.userName ?? WINCRED_USERNAME,
      AGY_WINCRED_PAYLOAD_B64: payloadB64,
    },
  )
  if (res.code !== 0 || !res.stdout.includes('AGY_WINCRED_WRITTEN')) {
    const detail = res.stderr.trim() || res.stdout.trim() || `exit ${String(res.code)}`
    throw new Error(`antigravity-acp: failed to write Windows Credential Manager entry: ${detail}`)
  }
  return parsed
}

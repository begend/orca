import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'
import { getSecretStore } from '../../shared/secret-store'
import {
  hardenExistingSecureFile,
  isUnreadableError,
  writeDurableSecureJsonFile
} from '../../shared/secure-file'

const LOG_SCOPE = '[ssh-host-passwords]'
const ENVELOPE_PREFIX = 'orca-ssh-host-password:v1:'
const FILE_NAME = 'ssh-host-passwords.json'

type PasswordEntry = { envelope: string; savedAt: number }
type PersistedPasswordsFile = {
  version: 1
  envelopePrefix: string
  entries: Record<string, PasswordEntry>
}

function isPersistedPasswordsFile(value: unknown): value is PersistedPasswordsFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'version' in value &&
    'envelopePrefix' in value &&
    'entries' in value &&
    value.version === 1 &&
    value.envelopePrefix === ENVELOPE_PREFIX &&
    typeof value.entries === 'object' &&
    value.entries !== null &&
    !Array.isArray(value.entries)
  )
}

export type SshHostPasswordStore = {
  has(targetId: string): boolean
  /** Null when absent or unusable — a broken entry degrades to the connect-time prompt, never to an error. */
  read(targetId: string): string | null
  save(targetId: string, password: string): void
  clear(targetId: string): void
  clearAll(): void
  listIds(): string[]
  protection(targetId: string): SecretAtRestProtection | null
  /** Drop entries whose target no longer exists in this profile. */
  sweep(validTargetIds: ReadonlySet<string>): void
  file(): { path: string }
}

export function createSshHostPasswordStore({
  directory
}: {
  directory: string
}): SshHostPasswordStore {
  const filePath = join(directory, FILE_NAME)

  type LoadResult =
    | { state: 'ok'; file: PersistedPasswordsFile }
    // Permission/transient denial: rewriting would destroy every secret we could not read.
    | { state: 'unreadable' }
    | { state: 'absent' }

  function emptyFile(): PersistedPasswordsFile {
    return { version: 1, envelopePrefix: ENVELOPE_PREFIX, entries: {} }
  }

  function loadState(): LoadResult {
    if (!existsSync(filePath)) {
      return { state: 'absent' }
    }
    let raw: Buffer
    try {
      raw = readFileSync(filePath)
    } catch (error) {
      if (isUnreadableError(error)) {
        return { state: 'unreadable' }
      }
      console.warn(`${LOG_SCOPE} failed to read ${FILE_NAME}`, error)
      return { state: 'absent' }
    }
    try {
      const parsed: unknown = JSON.parse(raw.toString('utf8'))
      if (isPersistedPasswordsFile(parsed)) {
        return { state: 'ok', file: parsed }
      }
    } catch {
      // Corrupt contents hold no recoverable secrets; the next save rewrites a valid file.
    }
    return { state: 'absent' }
  }

  type EnvelopeKind = 'sealed' | 'plaintext'

  function encodeEnvelope(kind: EnvelopeKind, payload: Buffer): string {
    return `${ENVELOPE_PREFIX}${kind}:${payload.toString('base64')}`
  }

  function decodeEnvelope(envelope: string): { kind: EnvelopeKind; payload: Buffer } | null {
    if (!envelope.startsWith(ENVELOPE_PREFIX)) {
      return null
    }
    const rest = envelope.slice(ENVELOPE_PREFIX.length)
    const separator = rest.indexOf(':')
    if (separator === -1) {
      return null
    }
    const kind = rest.slice(0, separator)
    if (kind !== 'sealed' && kind !== 'plaintext') {
      return null
    }
    return { kind, payload: Buffer.from(rest.slice(separator + 1), 'base64') }
  }

  function decryptEnvelope(kind: EnvelopeKind, payload: Buffer): string | null {
    try {
      if (kind === 'plaintext') {
        return payload.toString('utf8')
      }
      if (!getSecretStore().isEncryptionAvailable()) {
        console.warn(
          `${LOG_SCOPE} safeStorage is unavailable; stored host password cannot be decrypted`
        )
        return null
      }
      return getSecretStore().decryptString(payload)
    } catch (error) {
      console.warn(`${LOG_SCOPE} failed to decrypt a stored host password`, error)
      return null
    }
  }

  function save(targetId: string, password: string): void {
    const trimmed = password.trim()
    if (!trimmed) {
      throw new Error('SSH host password is required')
    }
    let kind: EnvelopeKind = 'sealed'
    let payload: Buffer
    if (getSecretStore().isEncryptionAvailable()) {
      payload = getSecretStore().encryptString(trimmed)
    } else {
      console.warn(
        `${LOG_SCOPE} safeStorage encryption unavailable — storing host password in plaintext`
      )
      kind = 'plaintext'
      payload = Buffer.from(trimmed, 'utf8')
    }
    mutate((file) => {
      file.entries[targetId] = { envelope: encodeEnvelope(kind, payload), savedAt: Date.now() }
      return true
    })
  }

  function read(targetId: string): string | null {
    const loaded = loadState()
    if (loaded.state !== 'ok') {
      return null
    }
    const entry = loaded.file.entries[targetId]
    if (!entry) {
      return null
    }
    try {
      hardenExistingSecureFile(filePath)
    } catch (error) {
      console.warn(`${LOG_SCOPE} failed to harden ${FILE_NAME} while reading`, error)
    }
    const decoded = decodeEnvelope(entry.envelope)
    return decoded ? decryptEnvelope(decoded.kind, decoded.payload) : null
  }

  function has(targetId: string): boolean {
    const loaded = loadState()
    return loaded.state === 'ok' && loaded.file.entries[targetId] !== undefined
  }

  function clear(targetId: string): void {
    mutate((file) => {
      if (file.entries[targetId] === undefined) {
        return false
      }
      delete file.entries[targetId]
      return true
    })
  }

  function clearAll(): void {
    rmSync(filePath, { force: true })
  }

  function listIds(): string[] {
    const loaded = loadState()
    return loaded.state === 'ok' ? Object.keys(loaded.file.entries) : []
  }

  function protection(targetId: string): SecretAtRestProtection | null {
    const loaded = loadState()
    if (loaded.state !== 'ok') {
      return null
    }
    const entry = loaded.file.entries[targetId]
    if (!entry) {
      return null
    }
    return decodeEnvelope(entry.envelope)?.kind ?? null
  }

  function sweep(validTargetIds: ReadonlySet<string>): void {
    mutate((file) => {
      let changed = false
      for (const targetId of Object.keys(file.entries)) {
        if (!validTargetIds.has(targetId)) {
          delete file.entries[targetId]
          changed = true
        }
      }
      return changed
    })
  }

  function mutate(edit: (file: PersistedPasswordsFile) => boolean): void {
    const loaded = loadState()
    if (loaded.state === 'unreadable') {
      console.warn(`${LOG_SCOPE} ${FILE_NAME} is unreadable; refusing to overwrite it`)
      return
    }
    const file = loaded.state === 'ok' ? loaded.file : emptyFile()
    if (!edit(file)) {
      return
    }
    writeDurableSecureJsonFile(filePath, file)
  }

  return {
    has,
    read,
    save,
    clear,
    clearAll,
    listIds,
    protection,
    sweep,
    file: () => ({ path: filePath })
  }
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setSecretStore } from '../../shared/secret-store'
import type * as SshHostPasswordStoreModule from './ssh-host-password-store'

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(value)),
  decryptString: vi.fn((value: Buffer) => value.toString('utf8'))
}))

beforeEach(() => setSecretStore({ ...safeStorageMock, describeProtectionGap: () => null }))

const existsSyncMock = vi.fn()
const readFileSyncMock = vi.fn()
const rmSyncMock = vi.fn()
const hardenExistingSecureFileMock = vi.fn()
const writeDurableSecureJsonFileMock = vi.fn()

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  rmSync: rmSyncMock
}))

vi.mock('node:path', () => ({
  join: (...parts: string[]) => parts.join('/')
}))

vi.mock('../../shared/secure-file', () => ({
  hardenExistingSecureFile: hardenExistingSecureFileMock,
  isUnreadableError: (error: unknown) =>
    error instanceof Error && 'code' in error && error.code === 'EBUSY',
  writeDurableSecureJsonFile: writeDurableSecureJsonFileMock
}))

const directory = '/profiles/p1'
const storePath = '/profiles/p1/ssh-host-passwords.json'

const envelope = (kind: 'sealed' | 'plaintext', value: string): string =>
  `orca-ssh-host-password:v1:${kind}:${Buffer.from(value, 'utf8').toString('base64')}`

function persistedFile(entries: Record<string, { envelope: string; savedAt: number }>): Buffer {
  return Buffer.from(
    JSON.stringify({ version: 1, envelopePrefix: 'orca-ssh-host-password:v1:', entries }),
    'utf8'
  )
}

async function loadFactory(): Promise<typeof SshHostPasswordStoreModule> {
  return await import('./ssh-host-password-store')
}

describe('createSshHostPasswordStore', () => {
  beforeEach(() => {
    existsSyncMock.mockReset().mockReturnValue(false)
    readFileSyncMock.mockReset()
    rmSyncMock.mockReset()
    hardenExistingSecureFileMock.mockReset()
    writeDurableSecureJsonFileMock.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReset().mockReturnValue(true)
    safeStorageMock.encryptString
      .mockReset()
      .mockImplementation((value: string) => Buffer.from(value))
    safeStorageMock.decryptString
      .mockReset()
      .mockImplementation((value: Buffer) => value.toString('utf8'))
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('writes a sealed envelope for a new target', async () => {
    const { createSshHostPasswordStore } = await loadFactory()
    const store = createSshHostPasswordStore({ directory })
    store.save('ssh-1', 'secret-pass')
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith('secret-pass')
    expect(writeDurableSecureJsonFileMock).toHaveBeenCalledTimes(1)
    expect(writeDurableSecureJsonFileMock).toHaveBeenCalledWith(
      storePath,
      expect.objectContaining({
        entries: {
          'ssh-1': { envelope: envelope('sealed', 'secret-pass'), savedAt: expect.any(Number) }
        }
      })
    )
  })

  it('warns and stores a plaintext envelope when encryption is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const { createSshHostPasswordStore } = await loadFactory()
    const store = createSshHostPasswordStore({ directory })
    store.save('ssh-1', 'secret-pass')
    expect(writeDurableSecureJsonFileMock).toHaveBeenCalledWith(
      storePath,
      expect.objectContaining({
        entries: {
          'ssh-1': { envelope: envelope('plaintext', 'secret-pass'), savedAt: expect.any(Number) }
        }
      })
    )
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('plaintext'))
    warn.mockRestore()
  })

  it('refuses empty passwords', async () => {
    const { createSshHostPasswordStore } = await loadFactory()
    const store = createSshHostPasswordStore({ directory })
    expect(() => store.save('ssh-1', '   ')).toThrow(/required/)
    expect(writeDurableSecureJsonFileMock).not.toHaveBeenCalled()
  })

  it('round-trips a saved password through the file', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(
      persistedFile({ 'ssh-1': { envelope: envelope('sealed', 'secret-pass'), savedAt: 1 } })
    )
    const { createSshHostPasswordStore } = await loadFactory()
    const store = createSshHostPasswordStore({ directory })
    expect(store.read('ssh-1')).toBe('secret-pass')
    expect(store.has('ssh-1')).toBe(true)
    expect(store.listIds()).toEqual(['ssh-1'])
    expect(hardenExistingSecureFileMock).toHaveBeenCalledWith(storePath)
  })

  it('returns null instead of throwing when decryption fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(
      persistedFile({ 'ssh-1': { envelope: envelope('sealed', 'lost'), savedAt: 1 } })
    )
    safeStorageMock.decryptString.mockImplementation(() => {
      throw new Error('boom')
    })
    const { createSshHostPasswordStore } = await loadFactory()
    const store = createSshHostPasswordStore({ directory })
    expect(store.read('ssh-1')).toBeNull()
    warn.mockRestore()
  })

  it('returns null for an unknown envelope format', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(
      persistedFile({ 'ssh-1': { envelope: 'garbage', savedAt: 1 } })
    )
    const { createSshHostPasswordStore } = await loadFactory()
    const store = createSshHostPasswordStore({ directory })
    expect(store.read('ssh-1')).toBeNull()
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('treats a corrupt file as absent and lets a save rewrite it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from('not-json'))
    const { createSshHostPasswordStore } = await loadFactory()
    const store = createSshHostPasswordStore({ directory })
    expect(store.has('ssh-1')).toBe(false)
    store.save('ssh-1', 'secret-pass')
    expect(writeDurableSecureJsonFileMock).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('refuses to overwrite an unreadable file', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('resource busy'), { code: 'EBUSY' })
    })
    const { createSshHostPasswordStore } = await loadFactory()
    const store = createSshHostPasswordStore({ directory })
    store.save('ssh-1', 'secret-pass')
    expect(writeDurableSecureJsonFileMock).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreadable'))
    warn.mockRestore()
  })

  it('skips the write when clear finds no entry', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(
      persistedFile({ 'ssh-1': { envelope: envelope('sealed', 'secret-pass'), savedAt: 1 } })
    )
    const { createSshHostPasswordStore } = await loadFactory()
    const store = createSshHostPasswordStore({ directory })
    store.clear('ssh-other')
    expect(writeDurableSecureJsonFileMock).not.toHaveBeenCalled()
    store.clear('ssh-1')
    expect(writeDurableSecureJsonFileMock).toHaveBeenCalledTimes(1)
    expect(writeDurableSecureJsonFileMock).toHaveBeenCalledWith(
      storePath,
      expect.objectContaining({ entries: {} })
    )
  })

  it('removes the file on clearAll', async () => {
    const { createSshHostPasswordStore } = await loadFactory()
    const store = createSshHostPasswordStore({ directory })
    store.clearAll()
    expect(rmSyncMock).toHaveBeenCalledWith(storePath, { force: true })
  })

  it('sweeps only entries whose target is gone', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(
      persistedFile({
        'ssh-keep': { envelope: envelope('sealed', 'a'), savedAt: 1 },
        'ssh-gone': { envelope: envelope('sealed', 'b'), savedAt: 2 }
      })
    )
    const { createSshHostPasswordStore } = await loadFactory()
    const store = createSshHostPasswordStore({ directory })
    store.sweep(new Set(['ssh-keep']))
    expect(writeDurableSecureJsonFileMock).toHaveBeenCalledTimes(1)
    expect(writeDurableSecureJsonFileMock).toHaveBeenCalledWith(
      storePath,
      expect.objectContaining({
        entries: { 'ssh-keep': { envelope: envelope('sealed', 'a'), savedAt: 1 } }
      })
    )
  })

  it('reports protection from the envelope without decrypting', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(
      persistedFile({
        'ssh-1': { envelope: envelope('plaintext', 'a'), savedAt: 1 },
        'ssh-2': { envelope: envelope('sealed', 'b'), savedAt: 2 }
      })
    )
    const { createSshHostPasswordStore } = await loadFactory()
    const store = createSshHostPasswordStore({ directory })
    expect(store.protection('ssh-1')).toBe('plaintext')
    expect(store.protection('ssh-2')).toBe('sealed')
    expect(store.protection('ssh-3')).toBeNull()
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
    expect(safeStorageMock.isEncryptionAvailable).not.toHaveBeenCalled()
  })

  it('reports no protection when the file is absent', async () => {
    const { createSshHostPasswordStore } = await loadFactory()
    const store = createSshHostPasswordStore({ directory })
    expect(store.protection('ssh-1')).toBeNull()
  })
})

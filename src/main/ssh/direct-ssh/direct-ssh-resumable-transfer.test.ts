import { Writable, Readable } from 'node:stream'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReadStream } from 'node:fs'
import type { SFTPWrapper } from 'ssh2'
import {
  cleanupDownloadArtifacts,
  resumeSftpDownload,
  resumeSftpUpload
} from './direct-ssh-resumable-transfer'

// SAFETY: the resume engine is exercised through an in-memory stand-in for ssh2's SFTPWrapper.
type FakeRemoteSftp = SFTPWrapper & { readStarts: number[] }

function fakeDownloadSftp(content: Buffer, mtime: number): FakeRemoteSftp {
  const state = { content, mtime }
  const readStarts: number[] = []
  const sftp = {
    readStarts,
    stat: (
      path: string,
      callback: (error: Error | null, stats?: { size: number; mtime: number }) => void
    ) => {
      if (path === 'remote.bin') {
        callback(null, { size: state.content.length, mtime: state.mtime })
      } else {
        callback(new Error(`no such file: ${path}`))
      }
    },
    createReadStream: (_path: string, options?: { start?: number }): ReadStream => {
      readStarts.push(options?.start ?? 0)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a one-shot readable stands in for ssh2's stream type in tests.
      return Readable.from([state.content.subarray(options?.start ?? 0)]) as unknown as ReadStream
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial in-memory stand-in for ssh2's SFTPWrapper; only the resumed surface is implemented.
  return sftp as unknown as FakeRemoteSftp
}

describe('resumeSftpDownload', () => {
  let tempPath = ''

  afterEach(async () => {
    if (tempPath) {
      await cleanupDownloadArtifacts(tempPath).catch(() => {})
      tempPath = ''
    }
  })

  it('downloads the whole file and cleans up on success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-resume-'))
    tempPath = join(root, 'out.bin')
    const sftp = fakeDownloadSftp(Buffer.from('hello world'), 100)
    await resumeSftpDownload(sftp, 'remote.bin', tempPath, {
      signal: new AbortController().signal,
      onProgress: () => {}
    })
    expect(await readFile(tempPath, 'utf8')).toBe('hello world')
    await cleanupDownloadArtifacts(tempPath)
    await expect(readFile(`${tempPath}.meta`)).rejects.toThrow()
  })

  it('appends from the surviving partial temp instead of restarting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-resume-'))
    tempPath = join(root, 'out.bin')
    const content = Buffer.from('0123456789')
    const sftp = fakeDownloadSftp(content, 7)
    // A previous attempt landed half the file and died before cleanup.
    await writeFile(tempPath, content.subarray(0, 5))
    await writeFile(
      `${tempPath}.meta`,
      JSON.stringify({ remoteSize: content.length, remoteMtime: 7 })
    )

    await resumeSftpDownload(sftp, 'remote.bin', tempPath, {
      signal: new AbortController().signal,
      onProgress: () => {}
    })

    expect(sftp.readStarts).toEqual([5])
    expect(await readFile(tempPath)).toEqual(content)
  })

  it('restarts from zero when the remote file changed since the partial was written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-resume-'))
    tempPath = join(root, 'out.bin')
    const sftp = fakeDownloadSftp(Buffer.from('new content'), 8)
    await writeFile(tempPath, 'stale')
    await writeFile(`${tempPath}.meta`, JSON.stringify({ remoteSize: 5, remoteMtime: 7 }))

    await resumeSftpDownload(sftp, 'remote.bin', tempPath, {
      signal: new AbortController().signal,
      onProgress: () => {}
    })

    expect(sftp.readStarts).toEqual([0])
    expect(await readFile(tempPath, 'utf8')).toBe('new content')
  })
})

describe('resumeSftpUpload', () => {
  it('streams the whole local file into the remote temp', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-upload-'))
    const localPath = join(root, 'src.bin')
    const payload = Buffer.from('upload payload')
    await writeFile(localPath, payload)
    const starts: number[] = []
    let written = Buffer.alloc(0)
    // SAFETY: only the write/stat surface the upload path touches is implemented.
    const sftp = {
      stat: (path: string, callback: (error: Error | null, stats?: { size: number }) => void) => {
        if (path.endsWith('.part')) {
          callback(null, { size: written.length })
        } else {
          callback(new Error(`no such file: ${path}`))
        }
      },
      createWriteStream: (_path: string, options?: { start?: number }) => {
        starts.push(options?.start ?? 0)
        const received: Buffer[] = []
        return new Writable({
          write(chunk: Buffer, _encoding: string, done: (error?: Error | null) => void) {
            received.push(chunk)
            const head = written.subarray(0, options?.start ?? 0)
            written = Buffer.concat([head, ...received])
            done(null)
          }
        })
      },
      readFile: (path: string, callback: (error: Error | null, handle?: Buffer) => void) => {
        callback(new Error(`no such file: ${path}`))
      },
      writeFile: (_path: string, _data: string, callback: (error?: Error | null) => void) => {
        callback(null)
      },
      unlink: (_path: string, callback: (error?: Error | null) => void) => callback(null),
      rename: (_from: string, _to: string, callback: (error?: Error | null) => void) =>
        callback(null),
      ext_openssh_rename: (_from: string, _to: string, callback: (error?: Error | null) => void) =>
        callback(null)
    }
    await resumeSftpUpload(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial in-memory stand-in for ssh2's SFTPWrapper; only the upload surface is implemented.
      sftp as unknown as SFTPWrapper,
      localPath,
      'dir/.orca-upload-src.bin.part',
      {
        signal: new AbortController().signal,
        onProgress: () => {}
      }
    )
    expect(starts).toEqual([0])
    expect(written).toEqual(payload)
    await rm(root, { recursive: true, force: true })
  })
})

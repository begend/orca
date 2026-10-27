// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshManagedServerStatus } from '../../../../shared/ssh-types'
import type {
  PlainSshTerminalEvent,
  PlainSshTerminalOpenRequest,
  PlainSshTerminalOpenResult
} from '../../../../shared/plain-ssh-terminal'
import { OpenPlainSshTerminalButton } from './OpenPlainSshTerminalButton'
import { PlainSshTerminalPanels } from './PlainSshTerminalPanels'
import { removePlainSshPanel, showPlainSshPanel } from '@/ssh/plain-ssh-terminal-panels'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'

const written: string[] = []

// The standalone terminal is the preview's, covered by its tests; this stands in for xterm.
vi.mock('@/components/standalone-terminal/open-standalone-terminal', () => ({
  openStandaloneTerminal: () => ({
    terminal: {
      options: {},
      cols: 80,
      rows: 24,
      loadAddon: () => {},
      focus: () => {},
      onResize: () => ({ dispose: () => {} })
    },
    write: (chunk: string, options: { onDone?: () => void }) => {
      written.push(chunk)
      options.onDone?.()
    },
    dispose: () => {}
  })
}))
const fit = vi.fn()
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {
      fit()
    }
  }
}))

const blocked: SshManagedServerStatus = {
  kind: 'relay',
  reason: 'refused',
  detail: 'This SSH host cannot move yet: automations (2).'
}

let emit: (event: PlainSshTerminalEvent) => void = () => {}
const open = vi.fn<(args: PlainSshTerminalOpenRequest) => Promise<PlainSshTerminalOpenResult>>()
const close = vi.fn()
const ack = vi.fn()
const list = vi.fn<() => Promise<{ sessionIds: string[] }>>()
// Every tab's terminal subscribes; events must reach all of them, not just the last subscriber.
const eventSubscribers = new Set<(event: PlainSshTerminalEvent) => void>()

beforeEach(() => {
  written.length = 0
  open.mockReset()
  close.mockReset()
  ack.mockReset()
  list.mockReset()
  list.mockResolvedValue({ sessionIds: [] })
  eventSubscribers.clear()
  emit = (event) => {
    for (const subscriber of eventSubscribers) {
      subscriber(event)
    }
  }
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    // Full surface: a hovered header button's Tooltip positions itself with unobserve too.
    value: class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      plainSsh: {
        open,
        close,
        ack,
        list,
        write: vi.fn(),
        resize: vi.fn(),
        onEvent: (callback: (event: PlainSshTerminalEvent) => void) => {
          eventSubscribers.add(callback)
          return () => eventSubscribers.delete(callback)
        }
      }
    }
  })
})

afterEach(() => {
  act(() => removePlainSshPanel('lambda'))
  cleanup()
})

function deferOpen(): (result: PlainSshTerminalOpenResult) => void {
  let resolve: (result: PlainSshTerminalOpenResult) => void = () => {}
  open.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  return (result) => resolve(result)
}

function Harness({ status }: { status: SshManagedServerStatus | undefined }): React.JSX.Element {
  return (
    <TooltipProvider>
      <OpenPlainSshTerminalButton targetId="lambda" targetLabel="lambda" status={status} />
      <PlainSshTerminalPanels />
    </TooltipProvider>
  )
}

describe('plain SSH terminal', () => {
  it('is offered only while the host’s move is blocked, and only for this desktop’s host', () => {
    const { rerender } = render(<Harness status={undefined} />)
    expect(screen.queryByRole('button', { name: 'Open plain SSH terminal' })).toBeNull()
    rerender(<Harness status={{ kind: 'managed', environmentId: 'e' }} />)
    expect(screen.queryByRole('button', { name: 'Open plain SSH terminal' })).toBeNull()
    rerender(<Harness status={{ ...blocked, bridged: true }} />)
    expect(screen.queryByRole('button', { name: 'Open plain SSH terminal' })).toBeNull()
    rerender(
      <OpenPlainSshTerminalButton
        targetId="lambda"
        targetLabel="lambda"
        status={blocked}
        ownerEnvironmentId="env-1"
      />
    )
    expect(screen.queryByRole('button', { name: 'Open plain SSH terminal' })).toBeNull()
  })

  it('opens a labelled unmanaged window, shows early output, and closes when ssh exits cleanly', async () => {
    let resolveOpen: (result: PlainSshTerminalOpenResult) => void = () => {}
    open.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve
        })
    )
    const user = userEvent.setup()
    render(<Harness status={blocked} />)
    await user.click(screen.getByRole('button', { name: 'Open plain SSH terminal' }))

    expect(screen.getByText('Plain SSH · lambda')).toBeInTheDocument()
    expect(screen.getByText(/Plain SSH — unmanaged\. Not an Orca workspace/)).toBeInTheDocument()
    expect(open).toHaveBeenCalledWith({ targetId: 'lambda', cols: 80, rows: 24, newSession: true })

    // ssh can print before the open reply arrives.
    act(() => emit({ kind: 'data', sessionId: 's1', data: 'Enter passphrase: ' }))
    await act(async () => resolveOpen({ ok: true, sessionId: 's1', label: 'lambda' }))
    expect(written).toEqual(['Enter passphrase: '])
    expect(ack).toHaveBeenCalledWith({ sessionId: 's1', chars: 'Enter passphrase: '.length })

    act(() => emit({ kind: 'exit', sessionId: 's1', exitCode: 0 }))
    await waitFor(() => expect(screen.queryByText('Plain SSH · lambda')).toBeNull())
  })

  it('keeps output when ssh is killed by a signal, even with exit code 0', async () => {
    const resolveOpen = deferOpen()
    const user = userEvent.setup()
    render(<Harness status={blocked} />)
    await user.click(screen.getByRole('button', { name: 'Open plain SSH terminal' }))
    await waitFor(() => expect(open).toHaveBeenCalled())
    await act(async () => resolveOpen({ ok: true, sessionId: 's4', label: 'lambda' }))
    act(() => emit({ kind: 'exit', sessionId: 's4', exitCode: 0, signal: 9 }))
    expect(await screen.findByText(/ssh was stopped \(signal 9\)/)).toBeInTheDocument()
  })

  it('still ends a session whose exit arrives before its open reply', async () => {
    let resolveOpen: (result: PlainSshTerminalOpenResult) => void = () => {}
    open.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve
        })
    )
    const user = userEvent.setup()
    render(<Harness status={blocked} />)
    await user.click(screen.getByRole('button', { name: 'Open plain SSH terminal' }))
    act(() => {
      // A flood from another window's session must not crowd out this session's exit.
      emit({ kind: 'data', sessionId: 'other', data: 'y'.repeat(300 * 1024) })
      emit({ kind: 'data', sessionId: 's5', data: 'Permission denied (publickey).\r\n' })
      emit({ kind: 'exit', sessionId: 's5', exitCode: 255 })
    })
    await act(async () => resolveOpen({ ok: true, sessionId: 's5', label: 'lambda' }))
    expect(await screen.findByText(/ssh exited with code 255/)).toBeInTheDocument()
    expect(written).toEqual(['Permission denied (publickey).\r\n'])
  })

  it('keeps a failed login readable, with no shell to fall back to', async () => {
    const resolveOpen = deferOpen()
    const user = userEvent.setup()
    render(<Harness status={blocked} />)
    await user.click(screen.getByRole('button', { name: 'Open plain SSH terminal' }))
    await waitFor(() => expect(open).toHaveBeenCalled())
    await act(async () => resolveOpen({ ok: true, sessionId: 's2', label: 'lambda' }))
    act(() => emit({ kind: 'exit', sessionId: 's2', exitCode: 255 }))
    expect(await screen.findByText(/ssh exited with code 255/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Close and end session' }))
    expect(screen.queryByText('Plain SSH · lambda')).toBeNull()
  })

  it('never refits a minimized window, which would shrink the remote terminal to 2x1', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(600)
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(400)
    try {
      const resolveOpen = deferOpen()
      const user = userEvent.setup()
      render(<Harness status={blocked} />)
      await user.click(screen.getByRole('button', { name: 'Open plain SSH terminal' }))
      await act(async () => resolveOpen({ ok: true, sessionId: 's6', label: 'lambda' }))
      await user.click(screen.getByRole('button', { name: 'Minimize' }))
      fit.mockClear()
      act(() =>
        useAppStore.setState({
          settings: { ...getDefaultSettings('/home/me'), terminalFontSize: 18 }
        })
      )
      expect(fit).not.toHaveBeenCalled()
    } finally {
      width.mockRestore()
      height.mockRestore()
    }
  })

  it('shows why it can’t open, e.g. no OpenSSH on Windows', async () => {
    open.mockResolvedValue({
      ok: false,
      reason: 'ssh-missing',
      message: 'Orca couldn’t find OpenSSH (ssh.exe) on this computer.'
    })
    const user = userEvent.setup()
    render(<Harness status={blocked} />)
    await user.click(screen.getByRole('button', { name: 'Open plain SSH terminal' }))
    expect(await screen.findByText(/couldn’t find OpenSSH/)).toBeInTheDocument()
    expect(document.querySelector('[data-plain-ssh-screen]')).toHaveClass('hidden')
  })

  it('hangs up when its window closes', async () => {
    const resolveOpen = deferOpen()
    const user = userEvent.setup()
    render(<Harness status={blocked} />)
    await user.click(screen.getByRole('button', { name: 'Open plain SSH terminal' }))
    await waitFor(() => expect(open).toHaveBeenCalled())
    await act(async () => resolveOpen({ ok: true, sessionId: 's3', label: 'lambda' }))
    await user.click(screen.getByRole('button', { name: 'Close and end session' }))
    expect(close).toHaveBeenCalledWith({ sessionId: 's3' })
  })
})

describe('direct SSH host window', () => {
  // Each direct open echoes the session it attached, or allocates a fresh shell's id.
  function echoOpen(): void {
    let fresh = 0
    open.mockImplementation(async (request) => {
      return { ok: true, sessionId: request.sessionId ?? `fresh-${++fresh}`, label: 'lambda' }
    })
  }

  it('reattaches the host’s listed sessions as tabs after a reload', async () => {
    echoOpen()
    list.mockResolvedValue({ sessionIds: ['d1', 'd2'] })
    render(<Harness status={blocked} />)
    act(() => showPlainSshPanel('lambda', 'lambda', { direct: true }))

    expect(await screen.findByRole('tab', { name: 'Terminal 1' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Terminal 2' })).toBeInTheDocument()
    expect(open).toHaveBeenCalledWith({ targetId: 'lambda', cols: 80, rows: 24, sessionId: 'd1' })
    expect(open).toHaveBeenCalledWith({ targetId: 'lambda', cols: 80, rows: 24, sessionId: 'd2' })
    expect(screen.getByText(/Closing a tab ends that shell/)).toBeInTheDocument()
  })

  it('opens an independent shell in a new tab from the + button', async () => {
    echoOpen()
    render(<Harness status={blocked} />)
    act(() => showPlainSshPanel('lambda', 'lambda', { direct: true }))
    expect(await screen.findByRole('tab', { name: 'Terminal 1' })).toBeInTheDocument()
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith({
        targetId: 'lambda',
        cols: 80,
        rows: 24,
        newSession: true
      })
    )

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'New terminal' }))
    expect(screen.getByRole('tab', { name: 'Terminal 2' })).toBeInTheDocument()
    expect(open).toHaveBeenCalledTimes(2)
    expect(open).toHaveBeenLastCalledWith({
      targetId: 'lambda',
      cols: 80,
      rows: 24,
      newSession: true
    })
  })

  it('hangs up only the closed tab’s session', async () => {
    echoOpen()
    list.mockResolvedValue({ sessionIds: ['d1', 'd2'] })
    render(<Harness status={blocked} />)
    act(() => showPlainSshPanel('lambda', 'lambda', { direct: true }))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2))
    await act(async () => {}) // Let the open replies attach their session ids.

    const user = userEvent.setup()
    await user.click(screen.getAllByRole('button', { name: 'Close tab' })[0])
    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith({ sessionId: 'd1' })
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(screen.getByText('Plain SSH · lambda')).toBeInTheDocument()
  })

  it('closes only the logged-out tab and keeps its siblings', async () => {
    echoOpen()
    list.mockResolvedValue({ sessionIds: ['d1', 'd2'] })
    render(<Harness status={blocked} />)
    act(() => showPlainSshPanel('lambda', 'lambda', { direct: true }))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2))
    await act(async () => {})

    act(() => emit({ kind: 'exit', sessionId: 'd1', exitCode: 0 }))
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(1))
    expect(screen.getByText('Plain SSH · lambda')).toBeInTheDocument()
    // The clean exit already detached; unmount must not hang up a dead session id.
    expect(close).not.toHaveBeenCalled()
  })

  it('shows the host’s file browser on the Files tab', async () => {
    echoOpen()
    list.mockResolvedValue({ sessionIds: ['d1'] })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        plainSsh: window.api.plainSsh,
        directSshFiles: {
          home: vi.fn(async () => ({ ok: true, path: '/home/me' })),
          list: vi.fn(async () => ({
            ok: true,
            path: '/home/me',
            entries: [{ name: 'notes.txt', path: '/home/me/notes.txt', kind: 'file' }]
          })),
          onEvent: vi.fn(() => () => {})
        }
      }
    })
    render(<Harness status={blocked} />)
    act(() => showPlainSshPanel('lambda', 'lambda', { direct: true }))

    const user = userEvent.setup()
    await user.click(await screen.findByRole('tab', { name: 'Files' }))
    expect(await screen.findByText('notes.txt')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Terminal 1' }))
    expect(screen.queryByText('notes.txt')).toBeNull()
    expect(screen.getByRole('tab', { name: 'Files' })).toBeInTheDocument()
  })
})

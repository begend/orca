import { translate } from '@/i18n/i18n'
import type { PlainSshTerminalPhase } from './PlainSshTerminalView'

export function phaseText(phase: PlainSshTerminalPhase): string | null {
  switch (phase.kind) {
    case 'opening':
    case 'open':
      return null
    case 'failed':
      return phase.message
    case 'ended':
      return phase.signal
        ? translate(
            'auto.components.plainSshTerminal.endedBySignal',
            'ssh was stopped (signal {{signal}}). Close it when you’re done reading.',
            { signal: phase.signal }
          )
        : translate(
            'auto.components.plainSshTerminal.ended',
            'ssh exited with code {{code}}. Close it when you’re done reading.',
            { code: phase.exitCode }
          )
  }
}

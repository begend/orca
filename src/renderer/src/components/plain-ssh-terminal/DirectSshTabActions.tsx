import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { DirectSshFilesDialog } from './DirectSshFilesDialog'

export type DirectSshFilesTarget = {
  targetId: string
}

/** Resolve SFTP identity solely from the canonical direct terminal descriptor. */
export function directSshFilesTarget(
  terminal: Pick<TerminalTab, 'directSsh' | 'customTitle' | 'title'> | null | undefined
): DirectSshFilesTarget | undefined {
  return terminal?.directSsh ? { targetId: terminal.directSsh.targetId } : undefined
}

/** Fixed strip action, intentionally outside the scrollable terminal tab strip. */
export function DirectSshTabActions({
  target
}: {
  target: DirectSshFilesTarget | undefined
}): React.JSX.Element | null {
  return target ? <DirectSshFilesDialog key={target.targetId} targetId={target.targetId} /> : null
}

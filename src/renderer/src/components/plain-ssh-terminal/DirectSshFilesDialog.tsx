import { FolderOpen } from 'lucide-react'
import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import { DirectSshFileBrowser } from './DirectSshFileBrowser'

/** Host-level SFTP surface for a connected direct host. Browsing, uploads and downloads keep
 * living in `DirectSshFileBrowser`/main; only the entry point moved here now that host shells
 * are canonical terminal tabs and no longer carry a Files pseudo-tab. */
export function DirectSshFilesDialog({
  targetId,
  targetLabel
}: {
  targetId: string
  /** Settings provides an immediate label; terminal actions resolve one from canonical target metadata. */
  targetLabel?: string
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const targetLabelFromStore = useAppStore(
    (state) =>
      state.sshTargetLabels.get(targetId) ?? state.removedSshTargetLabels.get(targetId) ?? targetId
  )
  const label = targetLabel ?? targetLabelFromStore
  if (!window.api.directSshFiles) {
    return null
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="xs">
          <FolderOpen />
          {translate('auto.components.plainSshTerminal.filesTab', 'Files')}
        </Button>
      </DialogTrigger>
      <DialogContent className="flex h-[70vh] max-w-2xl flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.plainSshTerminal.filesTitle', 'Files · {{host}}', {
              host: label
            })}
          </DialogTitle>
        </DialogHeader>
        {open ? <DirectSshFileBrowser targetId={targetId} /> : null}
      </DialogContent>
    </Dialog>
  )
}

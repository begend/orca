import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'

/** Runtime partitions can restore without waiting for repository catalog scans. */
export async function listRuntimeSessionHostIdsForStartup(): Promise<ExecutionHostId[]> {
  try {
    return (await window.api.runtimeEnvironments.list()).map((environment) =>
      toRuntimeExecutionHostId(environment.id)
    )
  } catch (err) {
    console.warn('Failed to list runtime session hosts for startup:', err)
    return []
  }
}

/**
 * restore_release — reactivate an earlier release (Release History face).
 * UI-only: never offered to or callable by an agent. The server wires the
 * real implementation (owner check + compatibility check) in wireHomeTools.
 */

import type { ToolDefinition } from '../../../agent/types.js'

const restoreRelease: ToolDefinition = {
  name: 'restore_release',
  description: 'Reactivate an earlier release of an app (owner only).',
  parameters: {
    release_id: { type: 'string', required: true, description: 'Release id' },
  },
  uiOnly: true,
  execute: async () => ({ result: null, error: 'restore_release is not wired' }),
}

export default restoreRelease

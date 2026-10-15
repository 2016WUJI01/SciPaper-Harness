/** Historical V4 command: refuse a different writer rather than publish mislabeled successors. */

import { realpathSync } from 'node:fs'
import { runMigrationCommand } from './migrate-sessions-current.ts'

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  await runMigrationCommand(4)
}

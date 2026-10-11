/** Native TLS sockets are unavailable in the browser Worker host. */
import { notImplementedFail } from '../../notImplementedFail.ts'

/** TLS connection entry used by SSH forwarded streams; calls fail explicitly. */
export const connect: typeof import('node:tls').connect = notImplementedFail('node:tls', 'connect')

/** CommonJS interop marker used by the Worker module loader. */
export const __esModule = true

/** CommonJS default export containing the supported module declarations. */
export default { connect } satisfies Partial<typeof import('node:tls')>

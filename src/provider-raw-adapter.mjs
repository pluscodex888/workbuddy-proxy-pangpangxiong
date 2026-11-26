import { BridgeError } from './contracts.mjs';

// ACP tool notifications occur after dispatch. Forwarding those notifications
// cannot prove zero local execution; never fall back to native on a raw request.
export function assertNativeMode(mode) {
  if (mode === 'raw') throw new BridgeError('raw_capability_not_supported', 422);
  if (mode !== 'native') throw new BridgeError('invalid_execution_mode', 400);
}

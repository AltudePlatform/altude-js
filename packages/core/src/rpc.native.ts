import { createSolanaClient, createSolanaRpc } from 'gill/react-native'
import { createAltudeClientWith } from './rpc.shared.js'
import type { AltudeClientConfig } from './rpc.shared.js'

export type { AltudeClientConfig, SolanaNetwork } from './rpc.shared.js'

export function createAltudeClient(config: AltudeClientConfig = {}) {
  return createAltudeClientWith(createSolanaRpc, createSolanaClient, config)
}

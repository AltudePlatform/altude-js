/**
 * Solana RPC client wrapper using Gill.
 * Reads ALTUDE_RPC_URL or falls back to well-known public endpoints.
 */

import type { createSolanaClient, createSolanaRpc } from 'gill'
import type { SolanaNetwork } from './types.js'

export type { SolanaNetwork }

const RPC_URLS: Record<SolanaNetwork, string> = {
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
}

type SolanaRpcHeaders = NonNullable<NonNullable<Parameters<typeof createSolanaClient>[0]['rpcConfig']>['headers']>

export interface AltudeClientConfig {
  network?: SolanaNetwork
  rpcUrl?: string
  /** Altude API key — used to route through the Altude relay when provided. */
  apiKey?: string
  /** Optional bearer token used to authorize RPC calls. */
  rpcToken?: string
  /** Additional headers to include on all RPC calls. */
  rpcHeaders?: SolanaRpcHeaders
}

/**
 * Create a Gill-backed Solana client configured for the Altude SDK.
 *
 * Priority for RPC URL:
 *  1. `config.rpcUrl` (explicit override)
 *  2. `process.env.ALTUDE_RPC_URL`
 *  3. Well-known public endpoint for the requested network
 */
export function createAltudeClientWith(
  createRpc: typeof createSolanaRpc,
  createClient: typeof createSolanaClient,
  config: AltudeClientConfig = {},
) {
  const network: SolanaNetwork = config.network ?? 'mainnet-beta'
  const envUrl = typeof process !== 'undefined' ? process.env['ALTUDE_RPC_URL'] : undefined
  const url = config.rpcUrl ?? envUrl ?? RPC_URLS[network]
  const headers: SolanaRpcHeaders = config.rpcToken?.trim()
    ? {
        ...(config.rpcHeaders ?? {}),
        Authorization: config.rpcToken.startsWith('Bearer ')
          ? config.rpcToken
          : `Bearer ${config.rpcToken}`,
      }
    : (config.rpcHeaders ?? {})

  const rpcConfig = Object.keys(headers).length > 0 ? { headers } : undefined
  const rpc = createRpc(url, rpcConfig)
  let fullClient: ReturnType<typeof createSolanaClient> | undefined

  const getFullClient = () => {
    fullClient ??= createClient({
      urlOrMoniker: url,
      ...(rpcConfig ? { rpcConfig } : {}),
    })
    return fullClient
  }

  return {
    rpc,
    get rpcSubscriptions() {
      return getFullClient().rpcSubscriptions
    },
    get sendAndConfirmTransaction() {
      return getFullClient().sendAndConfirmTransaction
    },
    get simulateTransaction() {
      return getFullClient().simulateTransaction
    },
  }
}

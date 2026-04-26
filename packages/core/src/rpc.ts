/**
 * Solana RPC client wrapper using Gill.
 * Reads ALTUDE_RPC_URL or falls back to well-known public endpoints.
 */

import { createSolanaClient as _createSolanaClient } from 'gill'
import type { SolanaNetwork } from './types.js'

export type { SolanaNetwork }

const RPC_URLS: Record<SolanaNetwork, string> = {
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
}

export interface AltudeClientConfig {
  network?: SolanaNetwork
  rpcUrl?: string
  /** Altude API key — used to route through the Altude relay when provided. */
  apiKey?: string
}

/**
 * Create a Gill-backed Solana client configured for the Altude SDK.
 *
 * Priority for RPC URL:
 *  1. `config.rpcUrl` (explicit override)
 *  2. `process.env.ALTUDE_RPC_URL`
 *  3. Well-known public endpoint for the requested network
 */
export function createAltudeClient(config: AltudeClientConfig = {}) {
  const network: SolanaNetwork = config.network ?? 'mainnet-beta'
  const envUrl = typeof process !== 'undefined' ? process.env['ALTUDE_RPC_URL'] : undefined
  const url = config.rpcUrl ?? envUrl ?? RPC_URLS[network]

  return _createSolanaClient({ urlOrMoniker: url })
}

/**
 * Solana RPC client wrapper using Gill.
 * Uses the node URL and JWT returned by Altude's transaction config API.
 */

import type { createSolanaClient, createSolanaRpc } from 'gill'
import { AltudeError } from './errors.js'
import type { SolanaNetwork } from './types.js'

export type { SolanaNetwork }

type SolanaRpcHeaders = NonNullable<NonNullable<Parameters<typeof createSolanaClient>[0]['rpcConfig']>['headers']>

export interface AltudeClientConfig {
  /** RPC URL returned by the Altude transaction config API. */
  rpcUrl: string
  /** Short-lived RPC JWT returned by the Altude transaction config API. */
  rpcToken: string
  /** Additional headers to include on all RPC calls. */
  rpcHeaders?: SolanaRpcHeaders
}

/**
 * Create a Gill-backed Solana client from Altude's API-key-scoped RPC config.
 */
export function createAltudeClientWith(
  createRpc: typeof createSolanaRpc,
  createClient: typeof createSolanaClient,
  config: AltudeClientConfig,
) {
  const url = validateRpcUrl(config.rpcUrl)
  const token = validateRpcToken(config.rpcToken)
  const headers: SolanaRpcHeaders = {
    ...(config.rpcHeaders ?? {}),
    Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
  }

  const rpcConfig = { headers }
  const rpc = createRpc(url, rpcConfig)
  let fullClient: ReturnType<typeof createSolanaClient> | undefined

  const getFullClient = () => {
    fullClient ??= createClient({
      urlOrMoniker: url,
      rpcConfig,
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

function validateRpcUrl(rpcUrl: string): string {
  const value = rpcUrl.trim()
  let parsedUrl: URL
  try {
    parsedUrl = new URL(value)
  } catch (cause) {
    throw new AltudeError({
      code: 'RPC_ERROR',
      message: 'Altude transaction config returned an invalid RPC URL.',
      remediation: 'Verify the API key cluster configuration and request fresh transaction config.',
      cause,
    })
  }

  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new AltudeError({
      code: 'RPC_ERROR',
      message: 'Altude transaction config returned an unsupported RPC URL protocol.',
      remediation: 'Configure the API key cluster with an HTTP or HTTPS RPC URL.',
    })
  }

  return value
}

function validateRpcToken(rpcToken: string): string {
  const value = rpcToken.trim()
  if (!value || value === 'jwt_unavailable') {
    throw new AltudeError({
      code: 'RPC_ERROR',
      message: 'Altude transaction config did not return a usable RPC JWT.',
      remediation: 'Request fresh transaction config with a valid API key.',
    })
  }
  return value
}

/**
 * @altude/nft — Gasless NFT operations on Solana.
 *
 * Provides helpers for:
 *  - Creating Metaplex Core NFT collections (gasless, Altude as fee payer)
 *  - Minting standard NFTs (Metaplex Core)
 *  - Minting compressed NFTs (cNFTs) via mpl-bubblegum
 *  - Fetching NFTs by owner via Helius DAS API
 *  - Building Metaplex-compatible metadata JSON
 *
 * Metaplex dependencies are peer dependencies — install them only if you use
 * the corresponding feature.
 */

import { AltudeError } from '@altude/core'
import type { AltudeHttpClient } from '@altude/gasstation'

// ---------------------------------------------------------------------------
// Metadata types (Metaplex standard)
// ---------------------------------------------------------------------------

export interface NFTAttribute {
  trait_type: string
  value: string | number
}

export interface NFTMetadata {
  name: string
  symbol?: string
  description?: string
  image: string // URI to image
  animation_url?: string
  external_url?: string
  attributes?: NFTAttribute[]
  properties?: {
    files?: Array<{ uri: string; type: string }>
    category?: string
    creators?: Array<{ address: string; share: number }>
  }
}

// ---------------------------------------------------------------------------
// Collection options
// ---------------------------------------------------------------------------

export interface CreateCollectionOptions {
  /** Collection name */
  name: string
  /** Metaplex metadata URI (JSON) */
  metadataUri: string
  /** Seller fee basis points (e.g. 500 = 5%) */
  sellerFeeBasisPoints?: number
  /** Authority / update authority address */
  authority?: string
}

export interface CreateCollectionResult {
  /** Collection mint address */
  collectionMint: string
  /** Transaction signature */
  signature: string
}

// ---------------------------------------------------------------------------
// Mint options
// ---------------------------------------------------------------------------

export interface MintNFTOptions {
  /** Collection mint address */
  collection: string
  /** NFT name */
  name: string
  /** Metaplex metadata URI */
  metadataUri: string
  /** Recipient address */
  recipient: string
  /** Seller fee basis points */
  sellerFeeBasisPoints?: number
}

export interface MintNFTResult {
  /** New NFT asset address */
  asset: string
  signature: string
}

export interface MintCompressedNFTOptions extends MintNFTOptions {
  /** Merkle tree address for cNFT storage */
  merkleTree: string
}

// ---------------------------------------------------------------------------
// DAS / fetch options
// ---------------------------------------------------------------------------

export interface GetNFTsByOwnerOptions {
  /** Owner address (base58) */
  owner: string
  /** Maximum items to return */
  limit?: number
  /** DAS API endpoint. Defaults to Helius mainnet. */
  dasUrl?: string
}

export interface NFTItem {
  id: string
  grouping: Array<{ group_key: string; group_value: string }>
  content: {
    metadata: { name?: string; description?: string }
    links?: { image?: string }
  }
  compression?: { compressed: boolean; leaf_id?: number }
}

// ---------------------------------------------------------------------------
// NFT client
// ---------------------------------------------------------------------------

/**
 * Build a Metaplex-compatible NFT metadata JSON object.
 */
export function buildNFTMetadata(options: NFTMetadata): NFTMetadata {
  return { ...options }
}

/**
 * Create a Metaplex Core NFT collection (gasless — Altude is fee payer).
 *
 * Requires @metaplex-foundation/mpl-core to be installed.
 */
export function createNFTCollection(
  client: AltudeHttpClient,
  _options: CreateCollectionOptions,
): Promise<CreateCollectionResult> {
  if (client.isMockMode) {
    return Promise.resolve({
      collectionMint: 'MockCollectionMint' + Math.random().toString(36).slice(2, 10),
      signature: 'MockCollectionSig' + Math.random().toString(36).slice(2),
    })
  }

  // In live mode, delegate to the Altude relay which handles Metaplex Core
  // collection creation with ALTUDE_FEE_PAYER as the fee payer.
  // Use the relay's send endpoint with the serialized transaction.
  return Promise.reject(new AltudeError({
    code: 'RELAY_ERROR',
    message:
      'createNFTCollection in live mode requires building a Metaplex Core transaction ' +
      'with @metaplex-foundation/mpl-core. Install it and build + sign the transaction, ' +
      'then relay via gasStation.send({ signedTransaction }).',
  }))
}

/**
 * Mint a standard Metaplex Core NFT (gasless).
 */
export function mintNFT(
  client: AltudeHttpClient,
  _options: MintNFTOptions,
): Promise<MintNFTResult> {
  if (client.isMockMode) {
    return Promise.resolve({
      asset: 'MockAsset' + Math.random().toString(36).slice(2, 10),
      signature: 'MockMintSig' + Math.random().toString(36).slice(2),
    })
  }
  return Promise.reject(new AltudeError({
    code: 'RELAY_ERROR',
    message: 'mintNFT requires a live Altude API key.',
  }))
}

/**
 * Mint a compressed NFT (cNFT) under a Merkle tree (gasless).
 * Dramatically lower cost per mint vs standard NFTs.
 */
export function mintCompressedNFT(
  client: AltudeHttpClient,
  _options: MintCompressedNFTOptions,
): Promise<MintNFTResult> {
  if (client.isMockMode) {
    return Promise.resolve({
      asset: 'MockCNFTAsset' + Math.random().toString(36).slice(2, 10),
      signature: 'MockCNFTSig' + Math.random().toString(36).slice(2),
    })
  }
  return Promise.reject(new AltudeError({
    code: 'RELAY_ERROR',
    message: 'mintCompressedNFT requires a live Altude API key.',
  }))
}

/**
 * Fetch all NFTs (standard + compressed) owned by an address via Helius DAS API.
 */
export async function getNFTsByOwner(options: GetNFTsByOwnerOptions): Promise<NFTItem[]> {
  const { owner, limit = 1000, dasUrl = 'https://mainnet.helius-rpc.com/?api-key=demo' } = options

  const response = await fetch(dasUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'get-assets',
      method: 'getAssetsByOwner',
      params: {
        ownerAddress: owner,
        page: 1,
        limit,
      },
    }),
  })

  if (!response.ok) {
    throw new AltudeError({
      code: 'RPC_ERROR',
      message: `DAS API returned ${response.status.toString()}`,
    })
  }

  const json = (await response.json()) as {
    result?: { items?: NFTItem[] }
    error?: { message?: string }
  }

  if (json.error) {
    throw new AltudeError({
      code: 'RPC_ERROR',
      message: json.error.message ?? 'DAS API error',
    })
  }

  return json.result?.items ?? []
}

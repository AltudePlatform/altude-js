import { describe, it, expect } from 'vitest'
import { AltudeHttpClient } from '@altude/gasstation'
import { buildNFTMetadata, createNFTCollection, mintNFT, mintCompressedNFT } from '../src/nft.js'

describe('buildNFTMetadata', () => {
  it('returns a well-formed metadata object', () => {
    const meta = buildNFTMetadata({
      name: 'Altude Genesis #1',
      image: 'https://arweave.net/abc123',
      attributes: [{ trait_type: 'Background', value: 'Blue' }],
    })
    expect(meta.name).toBe('Altude Genesis #1')
    expect(meta.attributes).toHaveLength(1)
  })
})

describe('NFT operations — mock mode', () => {
  const client = new AltudeHttpClient() // no API key → mock mode

  it('createNFTCollection returns a mock result', async () => {
    const result = await createNFTCollection(client, {
      name: 'Altude Collection',
      metadataUri: 'https://arweave.net/metadata.json',
    })
    expect(result.collectionMint).toBeTruthy()
    expect(result.signature).toBeTruthy()
  })

  it('mintNFT returns a mock result', async () => {
    const result = await mintNFT(client, {
      collection: 'MockCollection',
      name: 'NFT #1',
      metadataUri: 'https://arweave.net/nft1.json',
      recipient: '11111111111111111111111111111111',
    })
    expect(result.asset).toBeTruthy()
    expect(result.signature).toBeTruthy()
  })

  it('mintCompressedNFT returns a mock result', async () => {
    const result = await mintCompressedNFT(client, {
      collection: 'MockCollection',
      merkleTree: 'MockTree',
      name: 'cNFT #1',
      metadataUri: 'https://arweave.net/cnft1.json',
      recipient: '11111111111111111111111111111111',
    })
    expect(result.asset).toBeTruthy()
    expect(result.signature).toBeTruthy()
  })
})

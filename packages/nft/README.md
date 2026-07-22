# @altude/nft

Gasless NFT operations on Solana — Metaplex Core collections, standard NFTs, and
compressed NFTs (cNFTs) — relayed through the Altude gas station.

## Install

```bash
pnpm add @altude/nft @altude/gasstation
# or
npm install @altude/nft @altude/gasstation
```

Metaplex packages are **optional peer dependencies** — install the ones you need:

```bash
# For standard NFTs / collections
pnpm add @metaplex-foundation/mpl-core @metaplex-foundation/umi

# For compressed NFTs (cNFTs)
pnpm add @metaplex-foundation/mpl-bubblegum @metaplex-foundation/umi
```

## Usage

```typescript
import { AltudeGasStation } from '@altude/gasstation'
import {
  buildNFTMetadata,
  createNFTCollection,
  mintNFT,
  mintCompressedNFT,
  getNFTsByOwner,
} from '@altude/nft'

const gasStation = new AltudeGasStation({
  apiKey: process.env.ALTUDE_API_KEY!,
  network: 'devnet',
})

// Build metadata
const metadata = buildNFTMetadata({
  name: 'My NFT',
  description: 'A gasless NFT',
  image: 'https://example.com/image.png',
  attributes: [{ trait_type: 'Rarity', value: 'Legendary' }],
})

// Create a collection
const collection = await createNFTCollection({ gasStation, signer, metadata })

// Mint an NFT into the collection
const nft = await mintNFT({
  gasStation,
  signer,
  collection: collection.address,
  metadata,
  recipient: 'RECIPIENT_ADDRESS',
})

// Or mint a compressed NFT
const cnft = await mintCompressedNFT({
  gasStation,
  signer,
  treeAddress: 'MERKLE_TREE_ADDRESS',
  metadata,
  recipient: 'RECIPIENT_ADDRESS',
})

// Query NFTs owned by an address (DAS API)
const items = await getNFTsByOwner({ gasStation, owner: 'OWNER_ADDRESS' })
```

## What's included

- `buildNFTMetadata` — construct compliant NFT metadata.
- `createNFTCollection` — create a Metaplex Core collection (gasless).
- `mintNFT` — mint a standard NFT into a collection (gasless).
- `mintCompressedNFT` — mint a Bubblegum compressed NFT (gasless).
- `getNFTsByOwner` — query NFTs by owner via the Altude DAS endpoint.

See the [monorepo README](https://github.com/AltudePlatform/altude-js) for the full
SDK overview.

## License

MIT

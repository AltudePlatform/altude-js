/**
 * Altude Gas Station Demo
 *
 * Demonstrates the 4-step gasless transaction flow:
 *  1. Create / load an OWS vault wallet
 *  2. Fetch a blockhash from the Altude relay (Altude is fee payer)
 *  3. Build + sign the transaction using @altude/vault
 *  4. Relay the signed transaction via @altude/gasstation
 *
 * This mirrors the altude-dynamic-gas-station-demo but uses the
 * @altude/* TypeScript SDK instead of raw @solana/web3.js calls.
 *
 * Run: ALTUDE_API_KEY=your_key node src/index.js
 *   or without a key for mock/demo mode.
 */

import { AltudeVault } from '@altude/vault'
import { AltudeGasStation } from '@altude/gasstation'

const DEMO_PASSPHRASE = 'demo-passphrase'
const DEMO_WALLET_NAME = 'gas-station-demo-wallet'

async function main() {
  console.log('=== Altude Gas Station Demo ===\n')

  // ---------------------------------------------------------------------------
  // Step 0: Initialize vault and gas station
  // ---------------------------------------------------------------------------
  const vault = new AltudeVault() // uses ~/.ows by default
  const gasStation = new AltudeGasStation({
    apiKey: process.env['ALTUDE_API_KEY'],
    network: (process.env['ALTUDE_NETWORK'] as 'mainnet-beta' | 'devnet') ?? 'devnet',
  })

  console.log(gasStation.client.isMockMode ? '[mock mode — no API key]' : '[live mode]')

  // ---------------------------------------------------------------------------
  // Step 1: Create or load wallet
  // ---------------------------------------------------------------------------
  let walletInfo = (await vault.listWallets()).find((w) => w.name === DEMO_WALLET_NAME)

  if (!walletInfo) {
    console.log('Creating new wallet...')
    walletInfo = await vault.createWallet({
      name: DEMO_WALLET_NAME,
      passphrase: DEMO_PASSPHRASE,
      words: 12,
    })
    console.log(`Wallet created: ${walletInfo.id}`)
  } else {
    console.log(`Using existing wallet: ${walletInfo.id}`)
  }

  const address = walletInfo.accounts[0]?.address ?? 'unknown'
  console.log(`Solana address: ${address}\n`)

  // ---------------------------------------------------------------------------
  // Step 2: Fetch blockhash from Altude relay
  // ---------------------------------------------------------------------------
  console.log('Fetching blockhash from Altude relay...')
  const { Blockhash: recentBlockhash } = await gasStation.getBlockhash()
  console.log(`Recent blockhash: ${recentBlockhash}\n`)

  // ---------------------------------------------------------------------------
  // Step 3: Check balance
  // ---------------------------------------------------------------------------
  const balance = await gasStation.getBalance({ address })
  console.log(`Balance: ${balance.uiAmount ?? balance.lamports ?? 'n/a'} SOL\n`)

  // ---------------------------------------------------------------------------
  // Step 4: Sign a test message to verify vault + key derivation
  // ---------------------------------------------------------------------------
  console.log('Signing a test message with vault...')
  const signResult = await vault.signMessage(
    walletInfo.id,
    'Altude Gas Station Demo — signed message',
    DEMO_PASSPHRASE,
  )
  console.log(`Signature: ${signResult.signature.slice(0, 16)}...\n`)

  console.log('✓ Demo complete.')
  console.log('  To relay a real transaction, build it using @altude/solana-adapter,')
  console.log('  sign it with vault.sign(), then call gasStation.send({ signedTransaction }).')
  console.log('')
  console.log('  Example — sponsored account creation (mirrors Android SDK flow):')
  console.log('  ----------------------------------------------------------------')
  console.log('  // 1. Derive a GaslessTransactionSigner from your vault wallet')
  console.log('  // 2. Call gasStation.createAccount({ newAccountPubkey, lamports, space, signer })')
  console.log('  //    → SDK builds SystemProgram.createAccount instruction (feePayer as payer)')
  console.log('  //    → SDK partial-signs with the new account signer')
  console.log('  //    → SDK relays partially-signed tx; relay adds feePayer signature')
  console.log('')
  console.log('  Example — close a token account:')
  console.log('  ----------------------------------------------------------------')
  console.log('  // When feePayer is the close authority (set at creation):')
  console.log('  //   gasStation.closeAccount({ accountAddress, destination })')
  console.log('  // When the user is the close authority:')
  console.log('  //   gasStation.closeAccount({ accountAddress, destination, signer })')
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})

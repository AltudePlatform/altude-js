/**
 * @altude/vault — integration tests
 *
 * Full lifecycle: create wallet → create API key → sign with agent token
 * → verify policy denial → revoke key → verify token useless.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AltudeVault } from '../src/vault.js'
import type { OWSPolicy } from '@altude/core'

let vaultPath: string
let vault: AltudeVault

beforeEach(async () => {
  vaultPath = await mkdtemp(join(tmpdir(), 'altude-vault-test-'))
  vault = new AltudeVault(vaultPath)
})

afterEach(async () => {
  await rm(vaultPath, { recursive: true, force: true })
})

describe('wallet lifecycle', () => {
  it('creates and lists a wallet', async () => {
    const wallet = await vault.createWallet({ name: 'test-wallet' })
    expect(wallet.name).toBe('test-wallet')
    expect(wallet.accounts).toHaveLength(1)
    expect(wallet.accounts[0]?.chainId).toContain('solana')

    const all = await vault.listWallets()
    expect(all).toHaveLength(1)
    expect(all[0]?.id).toBe(wallet.id)
  })

  it('looks up a wallet by name', async () => {
    const created = await vault.createWallet({ name: 'lookup-test' })
    const found = await vault.getWallet('lookup-test')
    expect(found.id).toBe(created.id)
  })

  it('renames a wallet', async () => {
    await vault.createWallet({ name: 'old-name' })
    const renamed = await vault.renameWallet('old-name', 'new-name')
    expect(renamed.name).toBe('new-name')
    const found = await vault.getWallet('new-name')
    expect(found.name).toBe('new-name')
  })

  it('deletes a wallet', async () => {
    await vault.createWallet({ name: 'to-delete' })
    await vault.deleteWallet('to-delete')
    const all = await vault.listWallets()
    expect(all).toHaveLength(0)
  })

  it('exports and re-imports a mnemonic wallet', async () => {
    const passphrase = 'test-passphrase-123'
    await vault.createWallet({ name: 'export-test', passphrase, words: 12 })
    const mnemonic = await vault.exportWallet('export-test', passphrase)
    expect(mnemonic.split(' ')).toHaveLength(12)

    const imported = await vault.importWalletMnemonic('reimported', mnemonic, passphrase)
    expect(imported.accounts[0]?.address).toBe(
      (await vault.getWallet('export-test')).accounts[0]?.address,
    )
  })

  it('fails to export with wrong passphrase', async () => {
    await vault.createWallet({ name: 'locked', passphrase: 'correct' })
    await expect(vault.exportWallet('locked', 'wrong')).rejects.toThrow()
  })
})

describe('API key management', () => {
  it('creates and revokes an API key', async () => {
    const passphrase = 'vault-pass'
    const wallet = await vault.createWallet({ name: 'key-test', passphrase })
    const { keyInfo, token } = await vault.createApiKey({
      name: 'agent-key',
      walletId: wallet.id,
      passphrase,
    })

    expect(token).toMatch(/^ows_key_[0-9a-f]{64}$/)
    expect(keyInfo.wallet_ids).toContain(wallet.id)

    const keys = await vault.listApiKeys()
    expect(keys).toHaveLength(1)

    await vault.revokeApiKey(keyInfo.id)
    const remaining = await vault.listApiKeys()
    expect(remaining).toHaveLength(0)
  })
})

describe('signing', () => {
  it('signs a message with passphrase (owner mode)', async () => {
    const passphrase = 'sign-pass'
    const wallet = await vault.createWallet({ name: 'signer', passphrase })

    const result = await vault.signMessage(wallet.id, 'hello altude', passphrase)
    expect(result.signature).toMatch(/^[0-9a-f]{128}$/)
  })

  it('signs a message with API token (agent mode, no policies)', async () => {
    const passphrase = 'sign-pass'
    const wallet = await vault.createWallet({ name: 'agent-signer', passphrase })
    const { token } = await vault.createApiKey({
      name: 'agent',
      walletId: wallet.id,
      passphrase,
    })

    const result = await vault.signMessage(wallet.id, 'hello', token)
    expect(result.signature).toMatch(/^[0-9a-f]{128}$/)
  })

  it('enforces allowed_chains policy', async () => {
    const passphrase = 'policy-pass'
    const wallet = await vault.createWallet({ name: 'policy-wallet', passphrase })

    const policy: OWSPolicy = {
      id: 'evm-only',
      name: 'EVM Only',
      version: 1,
      created_at: new Date().toISOString(),
      rules: [{ type: 'allowed_chains', chain_ids: ['eip155:1'] }],
      executable: null,
      config: null,
      action: 'deny',
    }
    await vault.savePolicy(policy)

    const { token } = await vault.createApiKey({
      name: 'restricted-agent',
      walletId: wallet.id,
      passphrase,
      policyIds: ['evm-only'],
    })

    // Solana chain should be denied
    await expect(vault.signMessage(wallet.id, 'hello', token)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    })
  })

  it('enforces expires_at policy', async () => {
    const passphrase = 'exp-pass'
    const wallet = await vault.createWallet({ name: 'exp-wallet', passphrase })

    const policy: OWSPolicy = {
      id: 'expired-policy',
      name: 'Expired',
      version: 1,
      created_at: new Date().toISOString(),
      rules: [{ type: 'expires_at', timestamp: '2020-01-01T00:00:00Z' }], // in the past
      executable: null,
      config: null,
      action: 'deny',
    }
    await vault.savePolicy(policy)

    const { token } = await vault.createApiKey({
      name: 'exp-agent',
      walletId: wallet.id,
      passphrase,
      policyIds: ['expired-policy'],
    })

    await expect(vault.signMessage(wallet.id, 'hello', token)).rejects.toThrow()
  })

  it('token is useless after key revocation', async () => {
    const passphrase = 'revoke-pass'
    const wallet = await vault.createWallet({ name: 'revoke-test', passphrase })
    const { token, keyInfo } = await vault.createApiKey({
      name: 'doomed-key',
      walletId: wallet.id,
      passphrase,
    })

    // Sign succeeds before revocation
    const sig = await vault.signMessage(wallet.id, 'pre-revoke', token)
    expect(sig.signature).toBeTruthy()

    // Revoke
    await vault.revokeApiKey(keyInfo.id)

    // Sign fails after revocation
    await expect(vault.signMessage(wallet.id, 'post-revoke', token)).rejects.toThrow()
  })
})

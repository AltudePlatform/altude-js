import { afterEach, describe, expect, it, vi } from 'vitest'
import { WALLET_EMBED_CHANNEL, WALLET_EMBED_VERSION, WalletEmbedProvider } from './embed.js'
import type { WalletEmbedEnvelope, WalletEmbedTransport } from './embed.js'

describe('WalletEmbedProvider', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('ignores messages from other origins and resolves only a matching wallet response', async () => {
    vi.stubGlobal('location', { origin: 'https://app.example.test' })
    let onMessage: ((message: unknown, origin: string) => void) | undefined
    const send = vi.fn()
    const transport: WalletEmbedTransport = {
      send,
      onMessage(handler) {
        onMessage = handler
        return () => {
          onMessage = undefined
        }
      },
    }
    const provider = new WalletEmbedProvider({
      walletUrl: 'https://wallet.example.test/embed',
      transport,
      crypto: globalThis.crypto,
    })
    const stateListener = vi.fn()
    provider.on('session.changed', stateListener)
    const statePromise = provider.init()
    const request = send.mock.calls[0]?.[0] as WalletEmbedEnvelope | undefined
    if (!request) throw new Error('Expected wallet initialization request.')
    const response: WalletEmbedEnvelope = {
      channel: WALLET_EMBED_CHANNEL,
      version: WALLET_EMBED_VERSION,
      id: request.id,
      type: 'wallet.ready',
      payload: { wallet: { address: '11111111111111111111111111111111' } },
    }

    onMessage?.(response, 'https://untrusted.example.test')
    expect(stateListener).not.toHaveBeenCalled()
    onMessage?.({ ...response, version: 2 }, 'https://wallet.example.test')
    onMessage?.(response, 'https://wallet.example.test')

    await expect(statePromise).resolves.toEqual({
      status: 'connected',
      address: '11111111111111111111111111111111',
    })
    expect(stateListener).not.toHaveBeenCalled()
    provider.destroy()
  })

  it('rejects unsafe wallet URLs and expires unanswered requests', async () => {
    const transport: WalletEmbedTransport = {
      send: vi.fn(),
      onMessage: () => () => {},
    }
    expect(
      () => new WalletEmbedProvider({ walletUrl: 'http://wallet.example.test', transport }),
    ).toThrow()

    const provider = new WalletEmbedProvider({
      walletUrl: 'https://wallet.example.test',
      transport,
      requestTimeoutMs: 1,
    })
    vi.stubGlobal('location', { origin: 'https://app.example.test' })
    await expect(provider.init()).rejects.toMatchObject({ code: 'SESSION' })
    provider.destroy()
  })
})

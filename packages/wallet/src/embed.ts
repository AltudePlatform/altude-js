import { AltudeWalletError } from './errors.js'
import type { WalletTransactionIntent, WalletTransactionResult } from './types.js'

export const WALLET_EMBED_CHANNEL = 'altude-embed'
export const WALLET_EMBED_VERSION = 1

export type WalletEmbedMessageType =
  | 'wallet.init'
  | 'wallet.ready'
  | 'session.changed'
  | 'transaction.request'
  | 'transaction.get'
  | 'transaction.status'
  | 'error'

export interface WalletEmbedEnvelope {
  channel: typeof WALLET_EMBED_CHANNEL
  version: typeof WALLET_EMBED_VERSION
  id: string
  type: WalletEmbedMessageType
  payload: unknown
}

export interface WalletEmbedTransport {
  send(envelope: WalletEmbedEnvelope): void
  onMessage(handler: (message: unknown, origin: string) => void): () => void
}

export interface WalletEmbedProviderOptions {
  walletUrl: string
  iframe?: HTMLIFrameElement
  transport?: WalletEmbedTransport
  requestTimeoutMs?: number
  crypto?: Crypto
}

export interface EmbeddedWalletState {
  status: 'disconnected' | 'connected' | 'locked'
  address: string | null
}

export type WalletEmbedEvent =
  | { type: 'session.changed'; state: EmbeddedWalletState }
  | { type: 'wallet.ready'; state: EmbeddedWalletState }
  | { type: 'error'; message: string }

interface PendingRequest {
  expectedType: 'wallet.ready' | 'transaction.status'
  resolve: (payload: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export function createIframeWalletTransport(
  iframe: HTMLIFrameElement,
  walletOrigin: string,
): WalletEmbedTransport {
  return {
    send(envelope) {
      const target = iframe.contentWindow
      if (!target)
        throw new AltudeWalletError('SESSION', 'The embedded wallet frame is not available.')
      target.postMessage(envelope, walletOrigin)
    },
    onMessage(handler) {
      const listener = (event: MessageEvent<unknown>) => {
        if (event.origin !== walletOrigin || event.source !== iframe.contentWindow) return
        handler(event.data, event.origin)
      }
      window.addEventListener('message', listener)
      return () => {
        window.removeEventListener('message', listener)
      }
    },
  }
}

export class WalletEmbedProvider {
  readonly #origin: string
  readonly #transport: WalletEmbedTransport
  readonly #crypto: Crypto
  readonly #timeoutMs: number
  readonly #pending = new Map<string, PendingRequest>()
  readonly #listeners = new Map<WalletEmbedEvent['type'], Set<(event: WalletEmbedEvent) => void>>()
  readonly #unsubscribe: () => void

  constructor(options: WalletEmbedProviderOptions) {
    let walletUrl: URL
    try {
      walletUrl = new URL(options.walletUrl)
    } catch {
      throw new AltudeWalletError('CONFIGURATION', 'walletUrl must be an absolute HTTP(S) URL.')
    }
    if (
      (walletUrl.protocol !== 'https:' &&
        walletUrl.hostname !== 'localhost' &&
        walletUrl.hostname !== '127.0.0.1') ||
      walletUrl.username ||
      walletUrl.password
    ) {
      throw new AltudeWalletError(
        'CONFIGURATION',
        'walletUrl must use HTTPS and must not contain credentials.',
      )
    }
    this.#origin = walletUrl.origin
    if (options.transport) {
      this.#transport = options.transport
    } else if (options.iframe) {
      this.#transport = createIframeWalletTransport(options.iframe, this.#origin)
    } else {
      throw new AltudeWalletError('CONFIGURATION', 'Provide an iframe or a WalletEmbedTransport.')
    }
    this.#crypto = options.crypto ?? globalThis.crypto
    this.#timeoutMs = options.requestTimeoutMs ?? 60_000
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new AltudeWalletError('CONFIGURATION', 'requestTimeoutMs must be a positive integer.')
    }
    this.#unsubscribe = this.#transport.onMessage((message, origin) => {
      this.#receive(message, origin)
    })
  }

  async init(): Promise<EmbeddedWalletState> {
    const location: unknown = Reflect.get(globalThis, 'location')
    const hostOrigin: unknown =
      typeof location === 'object' && location !== null ? Reflect.get(location, 'origin') : undefined
    if (typeof hostOrigin !== 'string' || !hostOrigin) {
      throw new AltudeWalletError(
        'CONFIGURATION',
        'Wallet embedding must be initialized from a browser origin.',
      )
    }
    const payload = await this.#request('wallet.init', { hostOrigin }, 'wallet.ready')
    return parseWalletState(payload)
  }

  async requestTransaction(intent: WalletTransactionIntent): Promise<WalletTransactionResult> {
    validateIntent(intent)
    const payload = await this.#request('transaction.request', { intent }, 'transaction.status')
    return parseTransactionResult(payload)
  }

  async getTransaction(signature: string): Promise<WalletTransactionResult> {
    if (!signature.trim())
      throw new AltudeWalletError('INVALID_INPUT', 'A transaction signature is required.')
    const payload = await this.#request('transaction.get', { signature }, 'transaction.status')
    return parseTransactionResult(payload)
  }

  on(type: WalletEmbedEvent['type'], listener: (event: WalletEmbedEvent) => void): () => void {
    const listeners = this.#listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.#listeners.set(type, listeners)
    return () => listeners.delete(listener)
  }

  destroy(): void {
    this.#unsubscribe()
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timeout)
      pending.reject(new AltudeWalletError('SESSION', 'The embedded wallet connection was closed.'))
      this.#pending.delete(id)
    }
    this.#listeners.clear()
  }

  #request(
    type: 'wallet.init' | 'transaction.request' | 'transaction.get',
    payload: unknown,
    expectedType: PendingRequest['expectedType'],
  ): Promise<unknown> {
    const id = this.#crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id)
        reject(
          new AltudeWalletError(
            'SESSION',
            'The embedded wallet did not respond before the request timed out.',
          ),
        )
      }, this.#timeoutMs)
      this.#pending.set(id, { expectedType, resolve, reject, timeout })
      try {
        this.#transport.send({
          channel: WALLET_EMBED_CHANNEL,
          version: WALLET_EMBED_VERSION,
          id,
          type,
          payload,
        })
      } catch (error) {
        clearTimeout(timeout)
        this.#pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  #receive(value: unknown, origin: string): void {
    if (origin !== this.#origin || !isEnvelope(value)) return
    if (value.type === 'error') {
      const message = readMessage(value.payload)
      const pending = this.#pending.get(value.id)
      if (pending) {
        clearTimeout(pending.timeout)
        this.#pending.delete(value.id)
        pending.reject(new AltudeWalletError('SESSION', message))
      } else {
        this.#emit({ type: 'error', message })
      }
      return
    }
    const pending = this.#pending.get(value.id)
    if (pending) {
      if (value.type !== pending.expectedType) return
      clearTimeout(pending.timeout)
      this.#pending.delete(value.id)
      pending.resolve(value.payload)
      return
    }
    if (value.type !== 'session.changed' && value.type !== 'wallet.ready') return
    try {
      this.#emit({ type: value.type, state: parseWalletState(value.payload) })
    } catch {
      return
    }
  }

  #emit(event: WalletEmbedEvent): void {
    this.#listeners.get(event.type)?.forEach((listener) => {
      listener(event)
    })
  }
}

function isEnvelope(value: unknown): value is WalletEmbedEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  return (
    message['channel'] === WALLET_EMBED_CHANNEL &&
    message['version'] === WALLET_EMBED_VERSION &&
    typeof message['id'] === 'string' &&
    typeof message['type'] === 'string' &&
    isMessageType(message['type'])
  )
}

function isMessageType(value: string): value is WalletEmbedMessageType {
  return [
    'wallet.init',
    'wallet.ready',
    'session.changed',
    'transaction.request',
    'transaction.get',
    'transaction.status',
    'error',
  ].includes(value)
}

function parseWalletState(value: unknown): EmbeddedWalletState {
  if (typeof value !== 'object' || value === null) {
    throw new AltudeWalletError(
      'INVALID_RESPONSE',
      'The embedded wallet returned an invalid state.',
    )
  }
  const payload = value as Record<string, unknown>
  if ('wallet' in payload) {
    const wallet = payload['wallet']
    if (wallet === null) return { status: 'disconnected', address: null }
    if (typeof wallet !== 'object') {
      throw new AltudeWalletError(
        'INVALID_RESPONSE',
        'The embedded wallet returned an invalid state.',
      )
    }
    const walletRecord = wallet as Record<string, unknown>
    if (typeof walletRecord['address'] !== 'string') {
      throw new AltudeWalletError(
        'INVALID_RESPONSE',
        'The embedded wallet returned an invalid state.',
      )
    }
    return { status: 'connected', address: walletRecord['address'] }
  }
  const status = payload['status']
  const address = payload['address']
  if (
    (status !== 'disconnected' && status !== 'connected' && status !== 'locked') ||
    (address !== null && typeof address !== 'string')
  ) {
    throw new AltudeWalletError(
      'INVALID_RESPONSE',
      'The embedded wallet returned an invalid state.',
    )
  }
  return { status, address }
}

function parseTransactionResult(value: unknown): WalletTransactionResult {
  if (typeof value !== 'object' || value === null) {
    throw new AltudeWalletError(
      'INVALID_RESPONSE',
      'The embedded wallet returned an invalid transaction result.',
    )
  }
  const payload = value as Record<string, unknown>
  const result =
    typeof payload['result'] === 'object' && payload['result'] !== null
      ? (payload['result'] as Record<string, unknown>)
      : payload
  const signature = result['signature']
  if (typeof signature !== 'string' || !signature) {
    throw new AltudeWalletError(
      'INVALID_RESPONSE',
      'The embedded wallet returned no transaction signature.',
    )
  }
  const status = result['status']
  const message = result['message']
  return {
    signature,
    ...(typeof status === 'string' ? { status } : {}),
    ...(typeof message === 'string' ? { message } : {}),
  }
}

function validateIntent(intent: WalletTransactionIntent): void {
  const candidate: unknown = intent
  if (typeof candidate !== 'object' || candidate === null) {
    throw new AltudeWalletError('INVALID_INPUT', 'A structured transfer intent is required.')
  }
  const fields = candidate as Record<string, unknown>
  const kind = fields['kind']
  const amount = fields['amount']
  const recipient = fields['recipient']
  if (kind !== 'sol-transfer' && kind !== 'spl-transfer') {
    throw new AltudeWalletError('INVALID_INPUT', 'Only SOL and standard SPL transfers are supported.')
  }
  if (
    typeof amount !== 'number' ||
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    typeof recipient !== 'string' ||
    !recipient.trim()
  ) {
    throw new AltudeWalletError(
      'INVALID_INPUT',
      'Only positive SOL or SPL transfer intents are supported.',
    )
  }
  if (kind === 'spl-transfer' && (typeof fields['mint'] !== 'string' || !fields['mint'].trim())) {
    throw new AltudeWalletError('INVALID_INPUT', 'An SPL transfer requires a token mint address.')
  }
}

function readMessage(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const message = (value as Record<string, unknown>)['message']
    if (typeof message === 'string' && message) return message
  }
  return 'The embedded wallet returned an error.'
}

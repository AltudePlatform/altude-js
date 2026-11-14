import { base64 } from '@scure/base'
import type { GaslessTransactionSigner } from '@altude/gasstation'
import type { NativeWalletClient } from './client.js'
import { NativeWalletError } from './errors.js'

export interface NativeWalletAccess {
  apiBaseUrl: string
  appId: string
  walletUserId: string
  identityKey: string
  walletAddress: string | null
  challengeId: string
  message: string
  expiresAt: number
}

export interface NativeWalletAccessSession {
  token: string
  appId: string
  walletUserId: string
  address: string
  expiresAt: number
}

export class NativeWalletSessionAdapter {
  readonly #auth: NativeWalletClient
  readonly #apiKey: string
  readonly #fetch: typeof fetch
  readonly #now: () => number

  constructor(
    auth: NativeWalletClient,
    options: { apiKey: string; fetch?: typeof fetch; now?: () => number },
  ) {
    this.#auth = auth
    this.#apiKey = options.apiKey
    this.#fetch = (options.fetch ?? globalThis.fetch).bind(globalThis)
    this.#now = options.now ?? Date.now
  }

  async lookup(): Promise<NativeWalletAccess> {
    const config = await this.#auth.getBrokerConfig()
    const value = await this.#request('/api/native-wallet/wallet')
    const rawAddress = value['WalletAddress']
    const walletAddress = nonempty(rawAddress)
    const userId = nonempty(value['UserId'])
    const identityKey = nonempty(value['IdentityKey'])
    const challengeId = nonempty(value['ChallengeId'])
    const message = nonempty(value['Message'])
    if (
      value['AppId'] !== config.appId ||
      !userId ||
      !identityKey ||
      !challengeId ||
      !message ||
      (rawAddress !== null && walletAddress === null)
    ) {
      throw new NativeWalletError(
        'INVALID_RESPONSE',
        'The wallet lookup returned invalid scope or challenge.',
      )
    }
    validateProofMessage(message, {
      issuer: config.issuer,
      appId: config.appId,
      walletUserId: userId,
      identityKey,
      challengeId,
      walletAddress,
    })
    return {
      apiBaseUrl: config.authorizationUrl.slice(0, -'/api/native-wallet/authorize'.length),
      appId: config.appId,
      walletUserId: userId,
      identityKey,
      walletAddress,
      challengeId,
      message,
      expiresAt: this.#expiry(value, 60),
    }
  }

  async establish(
    access: NativeWalletAccess,
    signer: GaslessTransactionSigner,
  ): Promise<NativeWalletAccessSession> {
    if (access.expiresAt <= this.#now()) {
      throw new NativeWalletError(
        'SESSION',
        'The wallet proof challenge expired. Restart wallet setup.',
      )
    }
    if (access.walletAddress !== null && access.walletAddress !== signer.address) {
      throw new NativeWalletError(
        'WALLET_CONFLICT',
        'The local key does not match the registered wallet.',
      )
    }
    if (!signer.signMessage)
      throw new NativeWalletError('LOCKED', 'A local message signer is required.')
    const signature = await signer.signMessage(utf8(access.message))
    const value = await this.#request('/api/native-wallet/wallet/session', {
      ChallengeId: access.challengeId,
      WalletAddress: signer.address,
      Signature: base64.encode(signature),
    })
    const user = object(value['User'])
    const token = nonempty(value['SessionToken'])
    if (
      value['Success'] !== true ||
      value['AppId'] !== access.appId ||
      value['UserId'] !== access.walletUserId ||
      !token ||
      user?.['Id'] !== access.walletUserId ||
      user['WalletAddress'] !== signer.address
    ) {
      throw new NativeWalletError(
        'INVALID_RESPONSE',
        'The wallet session did not match the approved wallet user and key.',
      )
    }
    return {
      token,
      appId: access.appId,
      walletUserId: access.walletUserId,
      address: signer.address,
      expiresAt: this.#expiry(value),
    }
  }

  async validate(session: NativeWalletAccessSession): Promise<void> {
    const config = await this.#auth.getBrokerConfig()
    if (session.appId !== config.appId) {
      throw new NativeWalletError('SESSION', 'The wallet session belongs to another application.')
    }
    if (session.expiresAt <= this.#now())
      throw new NativeWalletError('SESSION', 'The wallet session expired.')
    const value = await this.#request('/api/EmbeddedWallet/session', undefined, session.token)
    const user = object(value['User'] ?? value['user'])
    if (
      (value['IsAuthenticated'] ?? value['isAuthenticated']) !== true ||
      value['AppId'] !== session.appId ||
      value['UserId'] !== session.walletUserId ||
      (user?.['Id'] ?? user?.['id']) !== session.walletUserId ||
      (user?.['WalletAddress'] ?? user?.['walletAddress']) !== session.address
    ) {
      throw new NativeWalletError('SESSION', 'The scoped wallet session is no longer authorized.')
    }
  }

  #expiry(value: Record<string, unknown>, max = 30 * 24 * 60 * 60): number {
    const seconds = value['ExpiresIn']
    if (
      typeof seconds !== 'number' ||
      !Number.isSafeInteger(seconds) ||
      seconds <= 0 ||
      seconds > max
    ) {
      throw new NativeWalletError('INVALID_RESPONSE', 'The wallet response has an invalid expiry.')
    }
    return this.#now() + seconds * 1000
  }

  async #request(
    path: string,
    body?: Record<string, string>,
    sessionToken?: string,
  ): Promise<Record<string, unknown>> {
    // Native JWTs enter only the explicit bridge; opaque sessions enter only session validation.
    const config = await this.#auth.getBrokerConfig()
    const baseUrl = config.authorizationUrl.slice(0, -'/api/native-wallet/authorize'.length)
    const credential = sessionToken ?? (await this.#auth.getAccessToken())
    if (!credential) throw new NativeWalletError('AUTHENTICATION', 'Native sign-in is required.')
    let response: Response
    try {
      response = await this.#fetch(`${baseUrl}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          Accept: 'application/json',
          'X-API-Key': this.#apiKey,
          Authorization: `Bearer ${credential}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
      })
    } catch (cause) {
      throw new NativeWalletError(
        'NETWORK',
        'The wallet-access API could not be reached.',
        undefined,
        cause,
      )
    }
    let value: Record<string, unknown> | null
    try {
      value = object(await response.json())
    } catch (cause) {
      throw new NativeWalletError(
        'INVALID_RESPONSE',
        'The wallet-access API returned invalid JSON.',
        response.status,
        cause,
      )
    }
    if (!response.ok) {
      const code = value?.['Error']
      throw new NativeWalletError(
        code === 'wallet_conflict'
          ? 'WALLET_CONFLICT'
          : code === 'wallet_scope_migration_required'
            ? 'WALLET_SCOPE_MIGRATION_REQUIRED'
            : 'API',
        code === 'wallet_scope_migration_required'
          ? 'An operator must enroll the existing legacy wallet for this AppId before setup.'
          : `The wallet-access API rejected the request (HTTP ${String(response.status)}).`,
        response.status,
      )
    }
    if (!value)
      throw new NativeWalletError(
        'INVALID_RESPONSE',
        'The wallet-access API returned an invalid response.',
      )
    return value
  }
}

function validateProofMessage(
  message: string,
  expected: {
    issuer: string
    appId: string
    walletUserId: string
    identityKey: string
    challengeId: string
    walletAddress: string | null
  },
): void {
  const lines = message.split('\n')
  const prefixes = [
    'Issuer',
    'AppId',
    'TenantId',
    'UserId',
    'IdentityKey',
    'RefreshFamilyId',
    'Origin',
    'IdentityTicket',
    'ChallengeId',
    'WalletAddress',
    'Nonce',
  ]
  const fields = new Map<string, string>()
  if (lines.length !== prefixes.length + 1 || lines[0] !== 'Altude Wallet Access Binding v1') {
    throw new NativeWalletError(
      'INVALID_RESPONSE',
      'The wallet proof message has an invalid domain or format.',
    )
  }
  for (const [index, prefix] of prefixes.entries()) {
    const line = lines[index + 1]
    if (!line?.startsWith(`${prefix}: `) || line.includes('\r')) {
      throw new NativeWalletError(
        'INVALID_RESPONSE',
        'The wallet proof message has invalid binding fields.',
      )
    }
    fields.set(prefix, line.slice(prefix.length + 2))
  }
  if (
    fields.get('Issuer') !== expected.issuer ||
    fields.get('AppId') !== expected.appId ||
    fields.get('TenantId') !== expected.appId.split('.')[0] ||
    fields.get('UserId') !== expected.walletUserId ||
    fields.get('IdentityKey') !== expected.identityKey ||
    fields.get('ChallengeId') !== expected.challengeId ||
    fields.get('WalletAddress') !== (expected.walletAddress ?? '') ||
    fields.get('Origin') !== '' ||
    fields.get('IdentityTicket') !== '' ||
    !fields.get('RefreshFamilyId') ||
    fields.get('RefreshFamilyId') === 'browser' ||
    !fields.get('Nonce')
  ) {
    throw new NativeWalletError(
      'INVALID_RESPONSE',
      'The wallet proof message does not match the native wallet scope.',
    )
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonempty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function utf8(value: string): Uint8Array {
  // Hermes need not provide TextEncoder; encode the exact server message, including Unicode.
  const bytes: number[] = []
  for (const character of value) {
    const code = character.codePointAt(0)
    if (code === undefined) continue
    if (code >= 0xd800 && code <= 0xdfff) {
      throw new NativeWalletError(
        'INVALID_RESPONSE',
        'The server proof message contains invalid Unicode.',
      )
    }
    if (code <= 0x7f) bytes.push(code)
    else if (code <= 0x7ff) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code <= 0xffff)
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    else
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
  }
  return Uint8Array.from(bytes)
}

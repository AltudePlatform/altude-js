import { AltudeWalletError } from './errors.js'
import type { PasskeyAdapter } from './types.js'
import { randomBytes, toArrayBuffer } from './crypto.js'

interface PrfExtensionResults {
  prf?: { results?: { first?: ArrayBuffer | Uint8Array } }
}

function getCancellationError(error: unknown, ceremony: 'creation' | 'unlock'): AltudeWalletError | undefined {
  if (
    !error ||
    typeof error !== 'object' ||
    !('name' in error) ||
    (error.name !== 'NotAllowedError' && error.name !== 'AbortError')
  ) {
    return undefined
  }
  return new AltudeWalletError(
    'PASSKEY_CANCELLED',
    `Passkey ${ceremony} was cancelled.`,
    undefined,
    error,
  )
}

export class BrowserPasskeyAdapter implements PasskeyAdapter {
  async register(input: Parameters<PasskeyAdapter['register']>[0]) {
    this.#assertAvailable(input.rpId)
    let result: PublicKeyCredential | null
    try {
      result = (await navigator.credentials.create({
        publicKey: {
          challenge: toArrayBuffer(input.challenge),
          rp: { id: input.rpId, name: input.rpName },
          user: {
            id: toArrayBuffer(input.userId),
            name: input.userName,
            displayName: 'Altude Wallet',
          },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
          extensions: {
            prf: { eval: { first: toArrayBuffer(input.prfSalt) } },
          },
        },
      })) as PublicKeyCredential | null
    } catch (error) {
      const cancellation = getCancellationError(error, 'creation')
      if (cancellation) throw cancellation
      throw error
    }

    if (!result) {
      throw new AltudeWalletError('PASSKEY_CANCELLED', 'Passkey creation was cancelled.')
    }
    const kek = this.#getPrfOutput(result)
    return {
      credentialId: new Uint8Array(result.rawId),
      ...(kek ? { kek } : {}),
    }
  }

  async deriveKey(input: Parameters<PasskeyAdapter['deriveKey']>[0]): Promise<Uint8Array> {
    this.#assertAvailable(input.rpId)
    let result: PublicKeyCredential | null
    try {
      result = (await navigator.credentials.get({
        publicKey: {
          challenge: toArrayBuffer(input.challenge),
          rpId: input.rpId,
          userVerification: 'required',
          allowCredentials: [{ type: 'public-key', id: toArrayBuffer(input.credentialId) }],
          extensions: {
            prf: { eval: { first: toArrayBuffer(input.prfSalt) } },
          },
        },
      })) as PublicKeyCredential | null
    } catch (error) {
      const cancellation = getCancellationError(error, 'unlock')
      if (cancellation) throw cancellation
      throw error
    }

    if (!result) {
      throw new AltudeWalletError('PASSKEY_CANCELLED', 'Passkey unlock was cancelled.')
    }
    const output = this.#getPrfOutput(result)
    if (!output) {
      throw new AltudeWalletError(
        'PASSKEY_UNAVAILABLE',
        'This passkey did not return a PRF result. Use the original sign-in method or another registered passkey.',
      )
    }
    return output
  }

  #assertAvailable(rpId: string): void {
    const secureContext = Reflect.get(globalThis, 'isSecureContext')
    const browserNavigator = Reflect.get(globalThis, 'navigator') as Navigator | undefined
    const credentialConstructor = Reflect.get(globalThis, 'PublicKeyCredential')
    if (
      typeof secureContext !== 'boolean' ||
      !secureContext ||
      !browserNavigator ||
      typeof browserNavigator.credentials.get !== 'function' ||
      typeof credentialConstructor !== 'function'
    ) {
      throw new AltudeWalletError(
        'PASSKEY_UNAVAILABLE',
        'Passkeys require WebAuthn in a secure browser context.',
      )
    }
    const location = Reflect.get(globalThis, 'location') as Location | undefined
    const hostname = location?.hostname
    if (!hostname || (hostname !== rpId && !hostname.endsWith(`.${rpId}`))) {
      throw new AltudeWalletError(
        'CONFIGURATION',
        'The passkey relying-party ID does not match this origin.',
      )
    }
  }

  #getPrfOutput(credential: PublicKeyCredential): Uint8Array | undefined {
    const extensions: unknown = credential.getClientExtensionResults()
    if (!extensions || typeof extensions !== 'object') return undefined
    const output = (extensions as PrfExtensionResults).prf?.results?.first
    if (!output) return undefined
    const bytes = output instanceof Uint8Array ? output : new Uint8Array(output)
    if (bytes.length < 32) {
      throw new AltudeWalletError(
        'PASSKEY_UNAVAILABLE',
        'The authenticator returned an invalid PRF result.',
      )
    }
    return bytes.slice(0, 32)
  }
}

export function createPasskeyChallenge(cryptoProvider: Crypto): Uint8Array {
  return randomBytes(cryptoProvider, 32)
}

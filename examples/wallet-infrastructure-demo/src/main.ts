import { AltudeGasStation } from '@altude/gasstation'
import type {
  BalanceResponse,
  ConfigResponse,
  CreateAccountOptions,
  CreateAccountResponse,
  GaslessTransactionSigner,
  GetAccountInfoOptions,
  GetAccountInfoResponse,
  GetBalanceOptions,
  GetHistoryOptions,
  GetHistoryResponse,
  SendOptions,
  SendTransactionResponse,
  WalletUiConfiguration,
} from '@altude/gasstation'
import {
  AltudeWallet,
  createAuth0WalletAuth,
  createBrowserWalletAuth,
  mountWalletUI,
} from '@altude/wallet'
import type { ExternalWalletProvider } from '@altude/wallet'
import './styles.css'

const DEMO_CODE = '246810'

interface PhantomProvider {
  connect(): Promise<{ publicKey: { toString(): string } }>
  disconnect?(): Promise<void>
  isPhantom?: boolean
}

interface EthereumProvider {
  isMetaMask?: boolean
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>
}

declare global {
  interface Window {
    ethereum?: EthereumProvider
    phantom?: { solana?: PhantomProvider }
    solana?: PhantomProvider
  }
}

class DemoGasStation extends AltudeGasStation {
  constructor(apiKey: string) {
    super({
      apiKey,
      network: 'devnet',
      baseUrl: 'https://gas-station.demo.invalid',
    })
  }

  override async getConfig(_forceRefresh = false): Promise<ConfigResponse> {
    return {
      FeePayer: '11111111111111111111111111111111',
      RpcUrl: 'https://rpc.demo.invalid',
      Token: 'simulated-only',
      TokenExpiration: null,
      RpcEnvironment: 'devnet',
    }
  }

  private async simulate(
    signer: GaslessTransactionSigner | undefined,
    details: Record<string, unknown>,
    expectedNetwork?: string,
    beforeDispatch?: () => void,
  ): Promise<string> {
    if (expectedNetwork && expectedNetwork !== 'devnet') throw new Error('Simulated network is devnet.')
    const sign = signer?.signTransactionMessage ?? signer?.sign
    if (!sign || !signer) throw new Error('Simulation requires a transaction signer.')
    const message = new TextEncoder().encode(JSON.stringify({
      domain: 'altude-wallet-demo-simulation-v1',
      network: 'devnet',
      signer: signer.address,
      ...details,
    }))
    const signature = await sign.call(signer, message)
    beforeDispatch?.()
    return btoa(String.fromCharCode(...signature))
  }

  override async send(options: SendOptions): Promise<SendTransactionResponse> {
    if (options.signedTransaction) throw new Error('Pre-signed transactions are not supported in simulation.')
    if (options.account && options.account !== options.sourceSigner?.address)
      throw new Error('Simulation account must match the signer.')
    const signature = await this.simulate(options.sourceSigner, {
      operation: 'transfer',
      recipient: options.toAddress ?? options.to,
      amount: options.amount,
      token: options.token ?? null,
    }, options.expectedNetwork, options.beforeDispatch)
    return {
      Signature: signature,
      Status: 'Success',
      Message: 'Simulated only. No transaction was sent to Solana.',
    }
  }

  override async createAccount(
    options: CreateAccountOptions = {},
    signer?: GaslessTransactionSigner,
  ): Promise<CreateAccountResponse> {
    const selectedSigner = signer ?? options.signer
    if (options.account && options.account !== selectedSigner?.address)
      throw new Error('Simulation account must match the signer.')
    const signature = await this.simulate(selectedSigner, {
      operation: 'provision',
      tokens: options.tokens ?? [],
    }, options.expectedNetwork, options.beforeDispatch)
    return {
      Signature: signature,
      Status: 'Success',
      Message: 'Simulated token account creation. No transaction was sent to Solana.',
    }
  }

  override async getBalance(options: GetBalanceOptions): Promise<BalanceResponse> {
    return {
      address: options.address ?? options.account ?? '',
      lamports: 125_000_000,
      uiAmount: 0.125,
    }
  }

  override async getAccountInfo(options: GetAccountInfoOptions): Promise<GetAccountInfoResponse> {
    return { account: options.account ?? options.accountAddress ?? '', demo: true }
  }

  override async getHistory(options: GetHistoryOptions): Promise<GetHistoryResponse> {
    return {
      data: [],
      page: options.page ?? 1,
      pageSize: options.pageSize ?? 10,
      limit: options.limit ?? 10,
      offset: options.offset ?? 0,
      total: 0,
    }
  }
}

async function demoApiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.endsWith('/api/EmbeddedWallet/auth0')) {
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    const accessToken =
      typeof body === 'object' && body !== null && 'accessToken' in body
        ? body.accessToken
        : undefined
    const walletAddress =
      typeof body === 'object' && body !== null && 'walletAddress' in body
        ? body.walletAddress
        : undefined
    const userId =
      typeof accessToken === 'string' && accessToken.startsWith('demo-token:')
        ? `demo-user:${accessToken.slice('demo-token:'.length)}`
        : 'wallet-demo-user'
    const identifier =
      typeof accessToken === 'string' && accessToken.startsWith('demo-token:')
        ? decodeURIComponent(accessToken.slice('demo-token:'.length))
        : undefined
    const contact = identifier?.includes('@')
      ? { email: identifier }
      : identifier?.startsWith('+')
        ? { phoneNumber: identifier }
        : {}
    return jsonResponse({
      success: true,
      sessionToken: 'demo-only-session-token',
      user: { id: userId, walletAddress, ...contact },
    })
  }
  if (url.endsWith('/api/EmbeddedWallet/session')) {
    return jsonResponse({ isAuthenticated: false })
  }
  if (url.endsWith('/api/EmbeddedWallet/signout')) {
    return jsonResponse({ success: true })
  }
  throw new Error(`The demo API has no simulated response for ${url}.`)
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  })
}

export function createDemoWallet(
  apiKey: string,
  apiBaseUrl: string,
  externalWallets: readonly ExternalWalletProvider[],
): AltudeWallet {
  return new AltudeWallet({
    apiKey,
    apiBaseUrl,
    network: 'devnet',
    externalWallets,
    auth: {
      async startOtp() {
        // This demo never sends a real email or text message.
      },
      async verifyOtp(_channel, identifier, code) {
        if (code.trim() !== DEMO_CODE) {
          throw new Error(`Use the demo verification code ${DEMO_CODE}.`)
        }
        return {
          accessToken: `demo-token:${encodeURIComponent(identifier.trim().toLowerCase())}`,
          identityKey: `wallet-demo:${identifier.trim().toLowerCase()}`,
        }
      },
    },
    fetch: demoApiFetch,
    gasStation: new DemoGasStation(apiKey),
  })
}

function getInjectedWallets(enabled: boolean): ExternalWalletProvider[] {
  if (!enabled) return []
  return [
    {
      id: 'metamask',
      label: 'MetaMask',
      isAvailable: () => Boolean(window.ethereum?.isMetaMask),
      async connect() {
        const ethereum = window.ethereum
        if (!ethereum?.isMetaMask) {
          throw new Error('Install the MetaMask browser extension to connect.')
        }
        const accounts: unknown = await ethereum.request({ method: 'eth_requestAccounts' })
        if (!Array.isArray(accounts) || typeof accounts[0] !== 'string') {
          throw new Error('MetaMask did not return an account.')
        }
        return { address: accounts[0], chain: 'evm' }
      },
    },
    {
      id: 'phantom',
      label: 'Phantom',
      isAvailable: () =>
        Boolean(window.phantom?.solana ?? (window.solana?.isPhantom ? window.solana : undefined)),
      async connect() {
        const phantom =
          window.phantom?.solana ?? (window.solana?.isPhantom ? window.solana : undefined)
        if (!phantom) throw new Error('Install the Phantom browser extension to connect.')
        const result = await phantom.connect()
        return { address: result.publicKey.toString(), chain: 'solana' }
      },
      async disconnect() {
        const phantom =
          window.phantom?.solana ?? (window.solana?.isPhantom ? window.solana : undefined)
        await phantom?.disconnect?.()
      },
    },
  ]
}

async function createLiveWallet(input: {
  apiKey: string
  apiBaseUrl: string
  authMode: string
  auth0Domain: string
  auth0ClientId: string
  auth0Audience: string
  connections: Record<string, string>
  otpConnections: { email: string | null; sms: string | null }
  externalWallets: readonly ExternalWalletProvider[]
}): Promise<{ wallet: AltudeWallet; providers: string[] }> {
  const authentication =
    input.authMode === 'broker'
      ? await createBrowserWalletAuth({ apiKey: input.apiKey, apiBaseUrl: input.apiBaseUrl })
      : await createAuth0WalletAuth({
          domain: input.auth0Domain,
          clientId: input.auth0ClientId,
          apiKey: input.apiKey,
          audience: input.auth0Audience,
          connections: input.connections,
          otpConnections: input.otpConnections,
          redirectUri: window.location.origin,
        })

  return {
    providers: [...authentication.socialProviders],
    wallet: new AltudeWallet({
      apiKey: input.apiKey,
      apiBaseUrl: input.apiBaseUrl,
      network: 'devnet',
      externalWallets: input.externalWallets,
      auth: authentication.auth,
    }),
  }
}

const root = document.querySelector<HTMLElement>('#root')
if (!root) throw new Error('Could not find the application root.')

root.innerHTML = `
  <div class="demo-shell">
    <header class="topbar">
      <a class="brand" href="#" aria-label="Altude wallet demo">
        <span class="brand-mark" aria-hidden="true">A</span>
        <span class="brand-copy"><strong>Altude</strong><small>Embedded wallet demo</small></span>
      </a>
      <span class="topbar-badge"><i></i> SDK-managed UI</span>
    </header>
    <main class="demo-main">
      <section class="wallet-card" aria-labelledby="page-title">
        <div class="card-heading">
          <div>
            <p class="eyebrow">SELF-CUSTODY · SOLANA</p>
            <h1 id="page-title">Embedded wallet</h1>
          </div>
          <span class="network-badge"><i></i> Devnet demo</span>
        </div>
        <p class="description">
          Try the simulated flow, or connect a client-safe API key and Auth0 SPA app to exercise
          the live wallet session API.
        </p>
        <label class="api-key-field" for="connection-mode">
          <span>Connection mode</span>
          <select id="connection-mode" name="connection-mode">
            <option value="simulated">Simulated demo</option>
            <option value="live">Live backend</option>
          </select>
        </label>
        <label class="api-key-field" for="api-key">
          <span>Client-safe Altude API key</span>
          <input
            id="api-key"
            name="api-key"
            type="password"
            value="demo-only-api-key"
            autocomplete="off"
            spellcheck="false"
            aria-describedby="api-key-help api-key-status"
          />
        </label>
        <p id="api-key-help" class="api-key-help">
          In simulated mode this placeholder is not sent anywhere. Live mode sends it to the
          configured API in the X-API-Key header. Use only a publishable browser key; never enter
          a server secret.
        </p>
        <fieldset class="method-controls" aria-label="Wallet login methods">
          <label class="toggle-row" for="enable-web3-wallets">
            <span><strong>Web3 wallets</strong><small>Show Phantom and MetaMask options; install a matching browser extension to connect.</small></span>
            <input id="enable-web3-wallets" type="checkbox" role="switch" />
          </label>
          <p id="web3-wallet-status" class="api-key-help" role="status" aria-live="polite"></p>
        </fieldset>
        <div id="live-settings" class="live-settings" hidden>
          <label class="api-key-field" for="api-base-url">
            <span>Altude API base URL</span>
            <input id="api-base-url" type="url" value="https://api.altude.so" autocomplete="url" />
          </label>
          <label class="api-key-field" for="auth-mode">
            <span>Authentication</span>
            <select id="auth-mode">
              <option value="broker">Altude browser broker (recommended)</option>
              <option value="direct">Direct Auth0 SPA (advanced)</option>
            </select>
          </label>
          <p id="broker-help" class="api-key-help">
            The SDK discovers sign-in methods from Altude using your API key. Keep your own
            email/SMS code screen without registering this site as an Auth0 callback.
            An operator must enroll this exact origin with the deployed browser broker.
          </p>
          <div id="direct-auth0-settings" class="social-settings" hidden>
          <label class="api-key-field" for="auth0-domain">
            <span>Auth0 domain</span>
            <input id="auth0-domain" type="text" placeholder="your-tenant.auth0.com" autocomplete="off" />
          </label>
          <label class="api-key-field" for="auth0-client-id">
            <span>Auth0 SPA client ID</span>
            <input id="auth0-client-id" type="text" autocomplete="off" />
          </label>
          <label class="api-key-field" for="auth0-audience">
            <span>Auth0 API audience</span>
            <input id="auth0-audience" type="text" value="https://api.altude.so" placeholder="Your Auth0 API identifier" autocomplete="off" aria-describedby="auth0-audience-help" />
          </label>
          <p id="auth0-audience-help" class="api-key-help">
            Public API identifier, not a secret. Must match the API configured in Auth0 and
            the audience accepted by the Altude backend; it can differ from the API base URL.
            Changing this does not change the backend's token validation.
          </p>
          <p class="api-key-help">
            Configure this origin in Auth0 Allowed Callback URLs and Allowed Web Origins.
            Passwordless connections default to <code>email</code> and <code>sms</code>;
            no client secret belongs in this browser app.
          </p>
          <label class="api-key-field" for="email-connection">
            <span>Email passwordless connection</span>
            <input id="email-connection" type="text" value="email" autocomplete="off" />
          </label>
          <label class="api-key-field" for="sms-connection">
            <span>SMS passwordless connection</span>
            <input id="sms-connection" type="text" value="sms" autocomplete="off" />
          </label>
          </div>
          <label class="toggle-row" for="enable-social-login">
            <span><strong>Social login</strong><small>Use broker-discovered providers, or explicit direct Auth0 connections.</small></span>
            <input id="enable-social-login" type="checkbox" role="switch" checked />
          </label>
          <p class="api-key-help">
            API wallet UI settings always take precedence. Only when absent do the demo switches
            provide explicit fallback methods and SMS consent copy.
          </p>
          <div id="social-settings" class="social-settings" hidden>
            <label class="api-key-field" for="google-connection">
              <span>Google connection (optional)</span>
              <input id="google-connection" type="text" placeholder="google-oauth2" autocomplete="off" />
            </label>
            <label class="api-key-field" for="apple-connection">
              <span>Apple connection (optional)</span>
              <input id="apple-connection" type="text" placeholder="apple" autocomplete="off" />
            </label>
          </div>
          <p class="api-key-help">
            Web3 connections use browser-injected wallets only. Phantom is exposed as a Solana
            address; MetaMask is exposed as an EVM address. These external wallets do not create
            an Altude session or support sponsored transfers in this demo.
          </p>
        </div>
        <p id="api-key-status" class="api-key-status" role="alert" aria-live="polite"></p>
        <button class="open-button" type="button">Open wallet</button>
        <div class="demo-code" id="demo-code">
          <span>Demo one-time code</span><code>${DEMO_CODE}</code>
        </div>
      </section>
      <section class="integration-card" aria-labelledby="integration-title">
        <div>
          <h2 id="integration-title">Add the SDK UI to your app</h2>
          <p>Pass your client-safe API key when configuring the wallet, then mount its modal.</p>
        </div>
        <pre><code>const apiBaseUrl = 'https://api.altude.so'
const { auth, socialProviders } =
  await createBrowserWalletAuth({ apiKey, apiBaseUrl })

const wallet = new AltudeWallet({
  apiKey,
  apiBaseUrl,
  auth,
})

mountWalletUI(document.body, wallet, {
  presentation: 'modal',
  socialProviders,
  walletUi: await wallet.getWalletUiConfiguration(),
  authMethods: { emailOtp: true, smsOtp: true, socialProviders },
  legal: { smsConsentText: 'I agree to receive a one-time sign-in code by SMS. Message and data rates may apply.' },
})</code></pre>
      </section>
      <p class="simulation-note">
        Simulated mode intercepts SDK API requests and does not contact Altude. Social login is
        available only in live mode; Web3 options appear only for enabled, installed browser
        wallets. External wallet connections remain separate from Altude wallet sessions.
      </p>
    </main>
  </div>
`

const openButton = root.querySelector<HTMLButtonElement>('.open-button')
if (!openButton) throw new Error('Could not find the open wallet button.')

const apiKeyInput = root.querySelector<HTMLInputElement>('#api-key')
const apiKeyStatus = root.querySelector<HTMLElement>('#api-key-status')
const modeInput = root.querySelector<HTMLSelectElement>('#connection-mode')
const liveSettings = root.querySelector<HTMLElement>('#live-settings')
const demoCode = root.querySelector<HTMLElement>('#demo-code')
const apiBaseUrlInput = root.querySelector<HTMLInputElement>('#api-base-url')
const authModeInput = root.querySelector<HTMLSelectElement>('#auth-mode')
const directAuth0Settings = root.querySelector<HTMLElement>('#direct-auth0-settings')
const brokerHelp = root.querySelector<HTMLElement>('#broker-help')
const auth0DomainInput = root.querySelector<HTMLInputElement>('#auth0-domain')
const auth0ClientIdInput = root.querySelector<HTMLInputElement>('#auth0-client-id')
const auth0AudienceInput = root.querySelector<HTMLInputElement>('#auth0-audience')
const emailConnectionInput = root.querySelector<HTMLInputElement>('#email-connection')
const smsConnectionInput = root.querySelector<HTMLInputElement>('#sms-connection')
const googleConnectionInput = root.querySelector<HTMLInputElement>('#google-connection')
const appleConnectionInput = root.querySelector<HTMLInputElement>('#apple-connection')
const socialLoginInput = root.querySelector<HTMLInputElement>('#enable-social-login')
const web3WalletsInput = root.querySelector<HTMLInputElement>('#enable-web3-wallets')
const socialSettings = root.querySelector<HTMLElement>('#social-settings')
const web3WalletStatus = root.querySelector<HTMLElement>('#web3-wallet-status')
if (
  !apiKeyInput ||
  !apiKeyStatus ||
  !modeInput ||
  !liveSettings ||
  !demoCode ||
  !apiBaseUrlInput ||
  !authModeInput ||
  !directAuth0Settings ||
  !brokerHelp ||
  !auth0DomainInput ||
  !auth0ClientIdInput ||
  !auth0AudienceInput ||
  !emailConnectionInput ||
  !smsConnectionInput ||
  !googleConnectionInput ||
  !appleConnectionInput ||
  !socialLoginInput ||
  !web3WalletsInput ||
  !socialSettings ||
  !web3WalletStatus
) {
  throw new Error('Could not find the wallet demo configuration controls.')
}

let wallet: AltudeWallet | undefined
let configuredWalletKey: string | undefined
let socialProviders: string[] = []
let unmountWalletUi: (() => void) | undefined

modeInput.addEventListener('change', () => {
  const simulated = modeInput.value === 'simulated'
  liveSettings.hidden = simulated
  demoCode.hidden = !simulated
  socialLoginInput.checked = true
  apiKeyInput.value = simulated ? 'demo-only-api-key' : ''
  apiKeyStatus.textContent = ''
  wallet = undefined
  configuredWalletKey = undefined
  updateAuthSettings()
})
const updateAuthSettings = () => {
  const direct = authModeInput.value === 'direct'
  directAuth0Settings.hidden = !direct
  brokerHelp.hidden = direct
  socialSettings.hidden = !direct || !socialLoginInput.checked
}
socialLoginInput.addEventListener('change', updateAuthSettings)
authModeInput.addEventListener('change', updateAuthSettings)
updateAuthSettings()
const updateWeb3WalletStatus = () => {
  const available = getInjectedWallets(true)
    .filter((provider) => provider.isAvailable?.())
    .map(({ label }) => label)
  web3WalletStatus.textContent = web3WalletsInput.checked
    ? available.length > 0
      ? `Detected in this browser: ${available.join(', ')}. API wallet settings can filter enabled options.`
      : 'Phantom and MetaMask are enabled here; install either extension to connect. API settings can filter them.'
    : available.length > 0
      ? `${available.join(', ')} detected; enable this switch to show them in the wallet.`
      : 'Enable this switch to show supported injected wallets when installed.'
}
web3WalletsInput.addEventListener('change', updateWeb3WalletStatus)
updateWeb3WalletStatus()
const closeWalletUi = () => {
  unmountWalletUi?.()
  unmountWalletUi = undefined
  apiKeyInput.disabled = false
  modeInput.disabled = false
}

openButton.addEventListener('click', () => {
  if (unmountWalletUi) return
  const apiKey = apiKeyInput.value.trim()
  if (!apiKey) {
    apiKeyStatus.textContent = 'Enter an API key to configure the wallet.'
    apiKeyInput.focus()
    return
  }

  apiKeyStatus.textContent = ''
  const mode = modeInput.value
  openButton.disabled = true
  void (async () => {
    try {
      const apiBaseUrl = apiBaseUrlInput.value.trim()
      const authMode = authModeInput.value
      const auth0Domain = auth0DomainInput.value.trim()
      const auth0ClientId = auth0ClientIdInput.value.trim()
      const auth0Audience = auth0AudienceInput.value.trim()
      const otpConnections = {
        email: emailConnectionInput.value.trim() || null,
        sms: smsConnectionInput.value.trim() || null,
      }
      const connections = socialLoginInput.checked
        ? {
            ...(googleConnectionInput.value.trim()
              ? { Google: googleConnectionInput.value.trim() }
              : {}),
            ...(appleConnectionInput.value.trim()
              ? { Apple: appleConnectionInput.value.trim() }
              : {}),
          }
        : {}
      const externalWallets = getInjectedWallets(web3WalletsInput.checked)
      const walletKey = JSON.stringify({
        mode,
        authMode,
        socialEnabled: socialLoginInput.checked,
        apiKey,
        apiBaseUrl,
        auth0Domain,
        auth0ClientId,
        auth0Audience,
        connections,
        otpConnections,
        externalWallets: externalWallets.map(({ id }) => id),
      })

      if (!wallet || walletKey !== configuredWalletKey) {
        if (mode === 'simulated') {
          wallet = createDemoWallet(apiKey, 'https://wallet-api.demo.invalid', externalWallets)
          socialProviders = []
        } else {
          if (authMode === 'direct' && (!auth0Domain || !auth0ClientId)) {
            throw new Error('Enter the Auth0 domain and SPA client ID for live mode.')
          }
          if (authMode === 'direct' && !auth0Audience) {
            throw new Error('Enter the Auth0 API audience for live mode.')
          }
          const live = await createLiveWallet({
            apiKey,
            apiBaseUrl,
            authMode,
            auth0Domain,
            auth0ClientId,
            auth0Audience,
            connections,
            otpConnections,
            externalWallets,
          })
          wallet = live.wallet
          socialProviders = live.providers
        }
        configuredWalletKey = walletKey
      }

      if (!wallet) throw new Error('The wallet could not be configured.')
      const configuredSocialProviders = socialLoginInput.checked ? socialProviders : []
      const serverWalletUi = mode === 'live' ? await wallet.getWalletUiConfiguration() : null
      const fallbackWalletUi = {
        branding: { appName: 'Altude' },
        legal: {
          smsConsentText:
            'I agree to receive a one-time sign-in code by SMS. Message and data rates may apply.',
        },
        authMethods: {
          emailOtp: true,
          smsOtp: true,
          socialProviders: configuredSocialProviders,
          passkey: false,
          externalWallets: externalWallets.map(({ id }) => id),
        },
      } satisfies WalletUiConfiguration
      apiKeyInput.disabled = true
      modeInput.disabled = true
      unmountWalletUi = mountWalletUI(document.body, wallet, {
        presentation: 'modal',
        title: 'Altude Demo',
        socialProviders: configuredSocialProviders,
        walletUi: serverWalletUi,
        authMethods: fallbackWalletUi.authMethods,
        legal: fallbackWalletUi.legal,
        onClose: closeWalletUi,
      })
    } catch (error) {
      apiKeyStatus.textContent =
        error instanceof Error ? error.message : 'Could not open the wallet.'
    } finally {
      openButton.disabled = false
    }
  })()
})

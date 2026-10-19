import { AltudeGasStation } from '@altude/gasstation'
import type {
  BalanceResponse,
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
} from '@altude/gasstation'
import { AltudeWallet, mountWalletUI } from '@altude/wallet'
import './styles.css'

const DEMO_CODE = '246810'

class DemoGasStation extends AltudeGasStation {
  constructor() {
    super({
      apiKey: 'demo-only-api-key',
      network: 'devnet',
      baseUrl: 'https://gas-station.demo.invalid',
    })
  }

  override async send(_options: SendOptions): Promise<SendTransactionResponse> {
    return {
      Signature: `simulated-${crypto.randomUUID()}`,
      Status: 'Success',
      Message: 'Simulated only. No transaction was sent to Solana.',
    }
  }

  override async createAccount(
    _options: CreateAccountOptions = {},
    _signer?: GaslessTransactionSigner,
  ): Promise<CreateAccountResponse> {
    return {
      Signature: `simulated-${crypto.randomUUID()}`,
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
    return jsonResponse({
      success: true,
      sessionToken: 'demo-only-session-token',
      user: { id: userId, walletAddress },
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

const wallet = new AltudeWallet({
  apiKey: 'demo-only-api-key',
  apiBaseUrl: 'https://wallet-api.demo.invalid',
  network: 'devnet',
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
  gasStation: new DemoGasStation(),
})

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
          The wallet interface is provided by <code>@altude/wallet</code>. Open it to try the
          built-in sign-in and wallet experience.
        </p>
        <button class="open-button" type="button">Open wallet</button>
        <div class="demo-code"><span>Demo one-time code</span><code>${DEMO_CODE}</code></div>
      </section>
      <section class="integration-card" aria-labelledby="integration-title">
        <div>
          <h2 id="integration-title">Add the SDK UI to your app</h2>
          <p>Configure your wallet, then mount its modal.</p>
        </div>
        <pre><code>mountWalletUI(document.body, wallet, {
  presentation: 'modal',
})</code></pre>
      </section>
      <p class="simulation-note">
        Demo mode: identity, API, and Gas Station responses are simulated. No real sign-in or
        on-chain transaction occurs.
      </p>
    </main>
  </div>
`

const openButton = root.querySelector<HTMLButtonElement>('.open-button')
if (!openButton) throw new Error('Could not find the open wallet button.')

let unmountWalletUi: (() => void) | undefined
const closeWalletUi = () => {
  unmountWalletUi?.()
  unmountWalletUi = undefined
}

openButton.addEventListener('click', () => {
  if (unmountWalletUi) return
  unmountWalletUi = mountWalletUI(document.body, wallet, {
    presentation: 'modal',
    title: 'Wallet access',
    onClose: closeWalletUi,
  })
})

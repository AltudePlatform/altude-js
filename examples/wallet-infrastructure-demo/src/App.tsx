import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
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
import { AltudeWallet } from '@altude/wallet'
import type { ExternalWalletProvider, WalletTransactionIntent, WalletState } from '@altude/wallet'

interface PhantomApi {
  connect(): Promise<{ publicKey: { toBase58(): string } }>
  disconnect(): Promise<void>
}

interface EthereumApi {
  request(input: { method: string }): Promise<unknown>
}

declare global {
  interface Window {
    phantom?: { solana?: PhantomApi }
    ethereum?: EthereumApi
  }
}

const DEMO_CODE = '246810'
const DEMO_RECIPIENT = 'Vote111111111111111111111111111111111111111'

const demoAuth = {
  async startOtp(): Promise<void> {
    await Promise.resolve()
  },
  async verifyOtp(_channel: 'email' | 'sms', identifier: string, code: string) {
    if (code.trim() !== DEMO_CODE) {
      throw new Error(`Use the demo verification code ${DEMO_CODE}.`)
    }
    return {
      accessToken: `demo-only-access-token:${encodeURIComponent(identifier.trim().toLowerCase())}`,
      identityKey: `wallet-demo:${identifier.trim().toLowerCase()}`,
    }
  },
}

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

const phantomProvider: ExternalWalletProvider = {
  id: 'phantom',
  label: 'Phantom',
  async connect() {
    const phantom = window.phantom?.solana
    if (!phantom) throw new Error('Install Phantom to connect an external Solana wallet.')
    const result = await phantom.connect()
    return { address: result.publicKey.toBase58(), chain: 'solana' }
  },
  async disconnect() {
    await window.phantom?.solana?.disconnect()
  },
}

const metamaskProvider: ExternalWalletProvider = {
  id: 'metamask',
  label: 'MetaMask',
  async connect() {
    if (!window.ethereum) throw new Error('Install MetaMask to connect an external EVM wallet.')
    const accounts: unknown = await window.ethereum.request({ method: 'eth_requestAccounts' })
    if (!Array.isArray(accounts) || typeof accounts[0] !== 'string') {
      throw new Error('MetaMask did not return an account.')
    }
    return { address: accounts[0], chain: 'evm' }
  },
}

async function demoApiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.endsWith('/api/EmbeddedWallet/auth0')) {
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    const addressValue =
      typeof body === 'object' && body !== null && 'walletAddress' in body
        ? body.walletAddress
        : undefined
    const tokenValue =
      typeof body === 'object' && body !== null && 'accessToken' in body
        ? body.accessToken
        : undefined
    const address = typeof addressValue === 'string' ? addressValue : ''
    const userId =
      typeof tokenValue === 'string' && tokenValue.startsWith('demo-only-access-token:')
        ? `demo-user:${tokenValue.slice('demo-only-access-token:'.length)}`
        : 'wallet-demo-user'
    return jsonResponse({
      success: true,
      sessionToken: 'demo-only-session-token',
      user: { id: userId, walletAddress: address },
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

export function App() {
  const wallet = useMemo(
    () =>
      new AltudeWallet({
        apiKey: 'demo-only-api-key',
        apiBaseUrl: 'https://wallet-api.demo.invalid',
        network: 'devnet',
        auth: demoAuth,
        externalWallets: [phantomProvider, metamaskProvider],
        fetch: demoApiFetch,
        gasStation: new DemoGasStation(),
      }),
    [],
  )
  const [walletState, setWalletState] = useState<WalletState>(wallet.state)
  const [recipient, setRecipient] = useState(DEMO_RECIPIENT)
  const [amount, setAmount] = useState('1000')
  const [pending, setPending] = useState<{
    id: string
    intent: WalletTransactionIntent
  } | null>(null)
  const [activity, setActivity] = useState('Ready. Try the demo sign-in code 246810.')
  const [busy, setBusy] = useState(false)
  const [otpChannel, setOtpChannel] = useState<'email' | 'sms'>('email')
  const [identifier, setIdentifier] = useState('')
  const [otpStarted, setOtpStarted] = useState(false)
  const [otpCode, setOtpCode] = useState('')

  useEffect(() => {
    const unsubscribe = wallet.onEvent((event) => {
      if (event.type === 'state') setWalletState(event.state)
      if (event.type === 'transaction:confirmation') {
        setPending({ id: event.id, intent: event.intent })
        setActivity('Review the transfer details before approving.')
      }
      if (event.type === 'transaction:complete') {
        setPending(null)
        setActivity(`Simulated transfer complete · ${event.result.signature}`)
      }
      if (event.type === 'transaction:error') {
        setPending(null)
        setActivity(event.error.message)
      }
    })
    return unsubscribe
  }, [wallet])

  const submitIdentity = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    try {
      if (!otpStarted) {
        await wallet.startOtp(otpChannel, identifier)
        setOtpStarted(true)
        setActivity(`Demo code ${DEMO_CODE} is ready. No message was sent.`)
      } else {
        await wallet.verifyOtp(otpChannel, identifier, otpCode)
        setOtpStarted(false)
        setOtpCode('')
        setActivity('Embedded wallet connected. The key was created in this browser.')
      }
    } catch (error) {
      setActivity(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const runWalletAction = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
    } catch (error) {
      setActivity(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const requestTransfer = () => {
    const parsedAmount = Number(amount)
    if (!Number.isSafeInteger(parsedAmount) || parsedAmount <= 0) {
      setActivity('Enter a positive whole-number amount in lamports.')
      return
    }
    try {
      const result = wallet.requestTransaction({
        kind: 'sol-transfer',
        recipient: recipient.trim(),
        amount: parsedAmount,
        network: 'devnet',
      })
      void result.catch((error: unknown) => {
        if (error instanceof Error) setActivity(error.message)
      })
    } catch (error) {
      setActivity(error instanceof Error ? error.message : String(error))
    }
  }

  const approveTransfer = async () => {
    if (!pending) return
    setBusy(true)
    try {
      await wallet.approveTransaction(pending.id)
    } catch (error) {
      setActivity(error instanceof Error ? error.message : String(error))
      setPending(null)
    } finally {
      setBusy(false)
    }
  }

  const rejectTransfer = () => {
    if (!pending) return
    wallet.rejectTransaction(pending.id)
    setPending(null)
    setActivity('Transfer cancelled. Nothing was submitted.')
  }

  const connected = walletState.status !== 'disconnected'
  const embedded = walletState.custody === 'embedded'
  const external = walletState.custody === 'external'
  const canTransfer = embedded && walletState.status === 'connected'

  return (
    <main className="demo-shell">
      <header className="topbar">
        <a className="wordmark" href="#" aria-label="Altude home">
          ALT<span>UDE</span>
        </a>
        <div className="topbar-meta">
          <span className="environment">
            <i /> Local simulation
          </span>
          <span className="version-label">@altude/wallet · 0.1.0</span>
        </div>
      </header>

      <section className="intro">
        <div>
          <p className="eyebrow">BROWSER WALLET INFRASTRUCTURE / PLAYGROUND</p>
          <h1>
            Your keys.
            <br />
            <em>Your call.</em>
          </h1>
          <p className="intro-copy">
            Explore a self-custodial wallet flow: the key stays in this browser, the user approves
            each transfer, and the relay is a replaceable boundary.
          </p>
        </div>
        <div
          className="diagram"
          aria-label="Transaction flow: browser signs, Gas Station relays, Solana receives"
        >
          <div className="diagram-node active-node">
            <span className="node-glyph">⌘</span>
            <b>Browser</b>
            <small>key + approval</small>
          </div>
          <span className="diagram-link">
            <i />
          </span>
          <div className="diagram-node">
            <span className="node-glyph">↗</span>
            <b>Gas Station</b>
            <small>sponsor + relay</small>
          </div>
          <span className="diagram-link">
            <i />
          </span>
          <div className="diagram-node">
            <span className="node-glyph solana-glyph">◎</span>
            <b>Solana</b>
            <small>devnet</small>
          </div>
          <p className="boundary-note">Private key never crosses the browser boundary</p>
        </div>
      </section>

      <div className="simulation-notice" role="note">
        <span className="notice-mark">i</span>
        <p>
          <strong>Safe to explore.</strong> Identity, API, and relay responses are simulated. No
          real sign-in or on-chain transaction occurs.
        </p>
      </div>

      <section className="workspace">
        <div className="access-column">
          <div className="section-heading">
            <div>
              <span className="section-kicker">ACCESS</span>
              <h2>Connect a wallet</h2>
            </div>
            <span
              className={`connection-indicator ${walletState.status === 'connected' ? 'is-connected' : walletState.status === 'locked' ? 'is-locked' : ''}`}
            >
              <i />{' '}
              {walletState.status === 'locked'
                ? 'Locked'
                : connected
                  ? 'Connected'
                  : 'Not connected'}
            </span>
          </div>
          {!connected ? (
            <>
              <form className="access-form" onSubmit={(event) => void submitIdentity(event)}>
                {!otpStarted ? (
                  <>
                    <label>
                      Sign-in method
                      <select
                        value={otpChannel}
                        onChange={(event) => setOtpChannel(event.target.value as 'email' | 'sms')}
                      >
                        <option value="email">Email</option>
                        <option value="sms">Text message</option>
                      </select>
                    </label>
                    <label>
                      {otpChannel === 'email' ? 'Email address' : 'Phone number'}
                      <input
                        autoComplete={otpChannel === 'email' ? 'email' : 'tel'}
                        required
                        value={identifier}
                        onChange={(event) => setIdentifier(event.target.value)}
                        placeholder={otpChannel === 'email' ? 'you@example.com' : '+1 555 010 1234'}
                      />
                    </label>
                  </>
                ) : (
                  <label>
                    One-time code
                    <input
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      required
                      value={otpCode}
                      onChange={(event) => setOtpCode(event.target.value)}
                      placeholder="6-digit demo code"
                    />
                  </label>
                )}
                <button className="primary-button" disabled={busy} type="submit">
                  {busy ? 'Working…' : otpStarted ? 'Verify & connect' : 'Send demo code'}
                  <span aria-hidden="true">↗</span>
                </button>
                {otpStarted && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => {
                      setOtpStarted(false)
                      setOtpCode('')
                    }}
                    type="button"
                  >
                    Use a different method
                  </button>
                )}
              </form>
              <p className="demo-code">
                <span>SIMULATED OTP</span>
                <code>{DEMO_CODE}</code>
              </p>
              <div className="external-connect">
                <span>OR USE AN INJECTED WALLET</span>
                <div>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() =>
                      void runWalletAction(() => wallet.connectExternalWallet('phantom'))
                    }
                  >
                    Phantom
                  </button>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() =>
                      void runWalletAction(() => wallet.connectExternalWallet('metamask'))
                    }
                  >
                    MetaMask
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="connected-actions">
              {walletState.status === 'locked' ? (
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() =>
                    void runWalletAction(() =>
                      walletState.protection === 'passkey'
                        ? wallet.unlockWithPasskey()
                        : wallet.unlock(),
                    )
                  }
                >
                  {walletState.protection === 'passkey' ? 'Unlock with passkey' : 'Unlock wallet'}
                  <span aria-hidden="true">↗</span>
                </button>
              ) : (
                <>
                  {walletState.externalChain !== 'evm' && (
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() =>
                        void runWalletAction(async () => {
                          const balance = await wallet.getBalance()
                          setActivity(`Simulated balance · ${String(balance.uiAmount)} SOL`)
                        })
                      }
                    >
                      Read balance
                    </button>
                  )}
                  {embedded && walletState.protection === 'device-local' && (
                    <>
                      <button
                        className="secondary-button"
                        disabled={busy}
                        onClick={() =>
                          void runWalletAction(async () => {
                            await wallet.protectWithPasskey()
                            setActivity('Local key protected with this device’s passkey.')
                          })
                        }
                      >
                        Protect with passkey
                      </button>
                      <button
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => wallet.lock()}
                      >
                        Lock
                      </button>
                    </>
                  )}
                  {embedded && walletState.protection === 'passkey' && (
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => wallet.lock()}
                    >
                      Lock
                    </button>
                  )}
                </>
              )}
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void runWalletAction(() => wallet.signOut())}
              >
                {external ? 'Disconnect wallet' : 'Sign out'}
              </button>
            </div>
          )}
          <div className="adapter-note">
            <strong>External adapters</strong>
            <p>
              Phantom and MetaMask connect through their injected browser APIs. External EVM is
              identity-only; external Solana needs a compatible signer adapter for transfers.
            </p>
          </div>
        </div>

        <div className="details-column">
          <div className="section-heading">
            <div>
              <span className="section-kicker">CUSTODY</span>
              <h2>Wallet state</h2>
            </div>
            <span className="network-chip">DEVNET</span>
          </div>
          <div className="state-panel">
            <div className="state-line">
              <span>Mode</span>
              <strong>{walletState.custody ?? '—'}</strong>
            </div>
            <div className="state-line">
              <span>Provider</span>
              <strong>{walletState.externalProviderId ?? (embedded ? 'Local key' : '—')}</strong>
            </div>
            <div className="state-line address-line">
              <span>Address</span>
              <code>{walletState.address ?? 'Connect to generate or select an address'}</code>
            </div>
            <div className="state-line">
              <span>API session</span>
              <strong>
                {walletState.session ? 'Simulated' : external ? 'None · external custody' : '—'}
              </strong>
            </div>
            <div className="state-line">
              <span>Local protection</span>
              <strong>{walletState.protection ?? (external ? 'Not applicable' : '—')}</strong>
            </div>
          </div>

          <div className="section-heading transaction-heading">
            <div>
              <span className="section-kicker">USER APPROVAL</span>
              <h2>Transfer preview</h2>
            </div>
            <span className="simulated-chip">SIMULATED</span>
          </div>
          {canTransfer ? (
            <div className="transfer-panel">
              <label>
                Recipient
                <input value={recipient} onChange={(event) => setRecipient(event.target.value)} />
              </label>
              <label>
                Amount <span className="unit">lamports</span>
                <input
                  inputMode="numeric"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
              </label>
              {!pending ? (
                <button className="primary-button" disabled={busy} onClick={requestTransfer}>
                  Request transfer <span aria-hidden="true">↗</span>
                </button>
              ) : (
                <div className="approval-box">
                  <p>Approve {pending.intent.amount.toLocaleString()} lamports to</p>
                  <code>{pending.intent.recipient}</code>
                  <div className="approval-actions">
                    <button
                      className="primary-button"
                      disabled={busy}
                      onClick={() => void approveTransfer()}
                    >
                      Approve &amp; simulate
                    </button>
                    <button className="text-button" disabled={busy} onClick={rejectTransfer}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              <p className="action-footnote">
                The SDK emits a confirmation request before the mock relay runs.
              </p>
            </div>
          ) : (
            <div className="empty-panel">
              <span className="empty-glyph">{external ? '⇄' : '·'}</span>
              <p>
                {external
                  ? 'This connection is external. Sponsored transfers require an adapter-provided Solana signer.'
                  : walletState.status === 'locked'
                    ? 'Unlock the embedded wallet before reviewing a transfer.'
                    : 'Connect an embedded wallet to preview the explicit approval flow.'}
              </p>
            </div>
          )}

          <div className="activity-panel" aria-live="polite">
            <span className="section-kicker">ACTIVITY</span>
            <p>{activity}</p>
          </div>
        </div>
      </section>
      <footer className="footer">
        <span>REFERENCE APP · NOT A PRODUCTION AUTH FLOW</span>
        <a href="https://github.com/AltudePlatform/altude-js/tree/main/packages/wallet">
          SDK README ↗
        </a>
      </footer>
    </main>
  )
}

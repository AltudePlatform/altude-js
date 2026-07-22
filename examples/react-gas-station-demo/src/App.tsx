import { useCallback, useEffect, useMemo, useState } from 'react'
import { AltudeGasStation } from '@altude/gasstation'
import type {
  BalanceResponse,
  BlockhashResponse,
  ConfigResponse,
  CreateAccountResponse,
  GetAccountInfoResponse,
  GetHistoryResponse,
  SendTransactionResponse,
  SwapResponse,
} from '@altude/gasstation'
import { ed25519 } from '@noble/curves/ed25519.js'
import { base58 } from '@scure/base'

type Network = 'devnet' | 'mainnet-beta'

const DEFAULT_ADDRESS = 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71'
const DEFAULT_MINT_SOL = 'So11111111111111111111111111111111111111112'
const DEFAULT_MINT_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

export function App() {
  const [ownerPublicKey, setOwnerPublicKey] = useState('')
  const [ownerPrivateKeyHex, setOwnerPrivateKeyHex] = useState('')
  const [ownerPrivateKeyBytes, setOwnerPrivateKeyBytes] = useState<Uint8Array | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [network, setNetwork] = useState<Network>('devnet')
  const [address, setAddress] = useState(DEFAULT_ADDRESS)
  const [baseUrl, setBaseUrl] = useState('')
  const [balanceMint, setBalanceMint] = useState('')

  const [sendTo, setSendTo] = useState(DEFAULT_ADDRESS)
  const [sendAmount, setSendAmount] = useState('1000000')
  const [sendToken, setSendToken] = useState('')
  const [sendCommitment, setSendCommitment] = useState('')
  const [sendComputeUnitLimit, setSendComputeUnitLimit] = useState('')
  const [sendComputeUnitPrice, setSendComputeUnitPrice] = useState('')
  const [sendHeapFrameBytes, setSendHeapFrameBytes] = useState('')

  const [createTokens, setCreateTokens] = useState(DEFAULT_MINT_USDC)
  const [createReference, setCreateReference] = useState('')
  const [createComputeUnitLimit, setCreateComputeUnitLimit] = useState('')
  const [createComputeUnitPrice, setCreateComputeUnitPrice] = useState('')
  const [createHeapFrameBytes, setCreateHeapFrameBytes] = useState('')
  const [closeMode, setCloseMode] = useState<'direct' | 'wallet'>('direct')
  const [closeAccountAddress, setCloseAccountAddress] = useState(DEFAULT_ADDRESS)
  const [closeDestination, setCloseDestination] = useState(DEFAULT_ADDRESS)
  const [closeWalletAddress, setCloseWalletAddress] = useState(DEFAULT_ADDRESS)
  const [closeTokens, setCloseTokens] = useState(DEFAULT_MINT_USDC)
  const [closeReference, setCloseReference] = useState('')
  const [closeComputeUnitLimit, setCloseComputeUnitLimit] = useState('')
  const [closeComputeUnitPrice, setCloseComputeUnitPrice] = useState('')
  const [closeHeapFrameBytes, setCloseHeapFrameBytes] = useState('')
  const [closeUseOwnerSigner, setCloseUseOwnerSigner] = useState(true)
  const [accountInfoAddress, setAccountInfoAddress] = useState(DEFAULT_ADDRESS)
  const [historyWalletAddress, setHistoryWalletAddress] = useState(DEFAULT_ADDRESS)
  const [historyPage, setHistoryPage] = useState('1')
  const [historyPageSize, setHistoryPageSize] = useState('10')
  const [inputMint, setInputMint] = useState(DEFAULT_MINT_SOL)
  const [outputMint, setOutputMint] = useState(DEFAULT_MINT_USDC)
  const [swapAmount, setSwapAmount] = useState('1000000')
  const [slippageBps, setSlippageBps] = useState('50')
  const [swapUserPublicKey, setSwapUserPublicKey] = useState(DEFAULT_ADDRESS)
  const [initResult, setInitResult] = useState<ConfigResponse | null>(null)
  const [blockhashResult, setBlockhashResult] = useState<BlockhashResponse | null>(null)
  const [balanceResult, setBalanceResult] = useState<BalanceResponse | null>(null)
  const [sendResult, setSendResult] = useState<SendTransactionResponse | null>(null)
  const [createAccountResult, setCreateAccountResult] = useState<CreateAccountResponse | null>(null)
  const [closeAccountResult, setCloseAccountResult] = useState<SendTransactionResponse | null>(null)
  const [accountInfoResult, setAccountInfoResult] = useState<GetAccountInfoResponse | null>(null)
  const [historyResult, setHistoryResult] = useState<GetHistoryResponse | null>(null)
  const [swapResult, setSwapResult] = useState<SwapResponse | null>(null)
  const [output, setOutput] = useState('Ready.')
  const [busy, setBusy] = useState(false)

  const generateOwnerKeypair = useCallback(() => {
    const privateKey = crypto.getRandomValues(new Uint8Array(32))
    const publicKey = ed25519.getPublicKey(privateKey)
    const publicKeyBase58 = base58.encode(publicKey)
    const privateKeyHex = Array.from(privateKey)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')

    setOwnerPublicKey(publicKeyBase58)
    setOwnerPrivateKeyHex(privateKeyHex)
    setOwnerPrivateKeyBytes(privateKey)

    // Keep sender-owner fields aligned with the generated owner identity.
    setAddress(publicKeyBase58)
    setSwapUserPublicKey(publicKeyBase58)
  }, [])

  useEffect(() => {
    generateOwnerKeypair()
  }, [generateOwnerKeypair])

  const gasStation = useMemo(() => {
    return new AltudeGasStation({
      network,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
    })
  }, [apiKey, baseUrl, network])

  const ownerSigner = useMemo(() => {
    if (!ownerPrivateKeyBytes || !ownerPublicKey) {
      return null
    }

    return {
      address: ownerPublicKey,
      async signTransactionMessage(txBytes: Uint8Array): Promise<Uint8Array> {
        return ed25519.sign(txBytes, ownerPrivateKeyBytes)
      },
      async signMessage(message: Uint8Array): Promise<Uint8Array> {
        return ed25519.sign(message, ownerPrivateKeyBytes)
      },
    }
  }, [ownerPrivateKeyBytes, ownerPublicKey])

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      const result = await fn()
      setOutput(`${label}\n${JSON.stringify(result, null, 2)}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setOutput(`${label}\nError: ${message}`)
    } finally {
      setBusy(false)
    }
  }

  const buildComputeOptions = (computeUnitLimit: string, computeUnitPriceMicroLamports: string, heapFrameBytes: string) => {
    const options = {
      ...(computeUnitLimit.trim() ? { computeUnitLimit: Number(computeUnitLimit) } : {}),
      ...(computeUnitPriceMicroLamports.trim()
        ? { computeUnitPriceMicroLamports: Number(computeUnitPriceMicroLamports) }
        : {}),
      ...(heapFrameBytes.trim() ? { heapFrameBytes: Number(heapFrameBytes) } : {}),
    }

    return Object.keys(options).length > 0 ? options : undefined
  }

  const renderTransactionResult = (title: string, result: SendTransactionResponse | CreateAccountResponse | SwapResponse) => {
    const signature = result.Signature ?? '-'
    const status = result.Status ?? '-'
    const message = result.Message ?? '-'
    return (
      <div className="result-card">
        <h3 className="result-title">{title}</h3>
        <dl className="result-grid">
          <div>
            <dt>Signature</dt>
            <dd className="mono">{signature}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{status}</dd>
          </div>
          <div>
            <dt>Message</dt>
            <dd>{message}</dd>
          </div>
        </dl>
        <pre className="result-json">{JSON.stringify(result, null, 2)}</pre>
      </div>
    )
  }

  return (
    <main className="page">
      <section className="panel">
        <p className="badge">Altude SDK Browser Demo</p>
        <h1>Gas Station Test Console</h1>
        <p className="lede">
          Test the SDK from an actual React page. Leave API key empty for mock mode.
        </p>

        <h2 className="section-title">Owner Keypair</h2>
        <p className="hint">Auto-generated in browser. Public key is used as sender owner by default.</p>
        <div className="keypair-card">
          <div>
            <strong>Public Key</strong>
            <p className="mono">{ownerPublicKey || '(generating...)'}</p>
          </div>
          <div>
            <strong>Private Key (hex)</strong>
            <p className="mono">{ownerPrivateKeyHex || '(generating...)'}</p>
          </div>
          <div className="actions">
            <button type="button" disabled={busy} onClick={generateOwnerKeypair}>
              Regenerate Keypair
            </button>
          </div>
        </div>

        <div className="grid">
          <label>
            API Key
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="ALTUDE API key (optional)"
            />
          </label>

          <label>
            Network
            <select value={network} onChange={(e) => setNetwork(e.target.value as Network)}>
              <option value="devnet">devnet</option>
              <option value="mainnet-beta">mainnet-beta</option>
            </select>
          </label>

          <label className="wide">
            Base URL (optional)
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://your-relay.example.com"
            />
          </label>

          <label className="wide">
            Address
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Wallet address"
            />
          </label>

          <label className="wide">
            Balance Mint (optional)
            <input
              value={balanceMint}
              onChange={(e) => setBalanceMint(e.target.value)}
              placeholder="SPL mint address for token balance"
            />
          </label>
        </div>

        <h2 className="section-title">SDK Init and Blockhash</h2>
        <p className="hint">Init loads relay config and RPC client. Blockhash fetches a fresh recent blockhash.</p>
        <div className="actions">
          <button
            disabled={busy}
            onClick={() =>
              run('init()', async () => {
                const result = await gasStation.init()
                setInitResult(result)
                return result
              })
            }
          >
            Init SDK
          </button>
          <button
            disabled={busy}
            onClick={() =>
              run('getBlockhash()', async () => {
                const result = await gasStation.getBlockhash()
                setBlockhashResult(result)
                return result
              })
            }
          >
            Get Blockhash
          </button>
        </div>
        {initResult && (
          <div className="result-card">
            <h3 className="result-title">Latest Init Result</h3>
            <dl className="result-grid">
              <div>
                <dt>Fee Payer</dt>
                <dd className="mono">{initResult.FeePayer}</dd>
              </div>
              <div>
                <dt>RPC URL</dt>
                <dd className="mono">{initResult.RpcUrl}</dd>
              </div>
              <div>
                <dt>Environment</dt>
                <dd>{initResult.RpcEnvironment}</dd>
              </div>
            </dl>
            <pre className="result-json">{JSON.stringify(initResult, null, 2)}</pre>
          </div>
        )}
        {blockhashResult && (
          <div className="result-card">
            <h3 className="result-title">Latest Blockhash Result</h3>
            <dl className="result-grid">
              <div>
                <dt>Blockhash</dt>
                <dd className="mono">{blockhashResult.Blockhash}</dd>
              </div>
            </dl>
            <pre className="result-json">{JSON.stringify(blockhashResult, null, 2)}</pre>
          </div>
        )}

        <h2 className="section-title">getBalance</h2>
        <p className="hint">Inputs match GetBalanceOptions: address, mint(optional).</p>
        <div className="actions">
          <button
            disabled={busy}
            onClick={() =>
              run('getBalance()', async () => {
                const result = await gasStation.getBalance({
                  address: address.trim() || DEFAULT_ADDRESS,
                  ...(balanceMint.trim() ? { mint: balanceMint.trim() } : {}),
                })
                setBalanceResult(result)
                return result
              })
            }
          >
            Get Balance
          </button>
        </div>
        {balanceResult && (
          <div className="result-card">
            <h3 className="result-title">Latest Balance Result</h3>
            <dl className="result-grid">
              <div>
                <dt>Address</dt>
                <dd className="mono">{balanceResult.address}</dd>
              </div>
              <div>
                <dt>Lamports</dt>
                <dd>{balanceResult.lamports ?? '-'}</dd>
              </div>
              <div>
                <dt>Amount</dt>
                <dd>{balanceResult.amount ?? '-'}</dd>
              </div>
              <div>
                <dt>Decimals</dt>
                <dd>{balanceResult.decimals ?? '-'}</dd>
              </div>
              <div>
                <dt>UI Amount</dt>
                <dd>{balanceResult.uiAmount ?? '-'}</dd>
              </div>
            </dl>
            <pre className="result-json">{JSON.stringify(balanceResult, null, 2)}</pre>
          </div>
        )}

        <h2 className="section-title">sendTransaction</h2>
        <p className="hint">Uses the updated SDK send flow with `account`, `toAddress`, optional token mint, and client-side partial signing.</p>
        <div className="grid">
          <label>
            To Address
            <input value={sendTo} onChange={(e) => setSendTo(e.target.value)} placeholder="Recipient address" />
          </label>
          <label>
            Amount
            <input value={sendAmount} onChange={(e) => setSendAmount(e.target.value)} placeholder="1000000" />
          </label>
          <label>
            Token (optional)
            <input value={sendToken} onChange={(e) => setSendToken(e.target.value)} placeholder="SPL mint address" />
          </label>
          <label>
            Commitment (optional)
            <select value={sendCommitment} onChange={(e) => setSendCommitment(e.target.value)}>
              <option value="">(none)</option>
              <option value="confirmed">confirmed</option>
              <option value="finalized">finalized</option>
            </select>
          </label>
          <label>
            Compute Unit Limit
            <input value={sendComputeUnitLimit} onChange={(e) => setSendComputeUnitLimit(e.target.value)} placeholder="400000" />
          </label>
          <label>
            Priority Fee (micro-lamports)
            <input value={sendComputeUnitPrice} onChange={(e) => setSendComputeUnitPrice(e.target.value)} placeholder="1000" />
          </label>
          <label>
            Heap Frame (bytes)
            <input value={sendHeapFrameBytes} onChange={(e) => setSendHeapFrameBytes(e.target.value)} placeholder="32768" />
          </label>
        </div>
        <div className="actions">
          <button
            disabled={busy || !ownerSigner}
            onClick={() =>
              run('send()', async () => {
                const computeOptions = buildComputeOptions(
                  sendComputeUnitLimit,
                  sendComputeUnitPrice,
                  sendHeapFrameBytes,
                )
                const result = await gasStation.send({
                  account: ownerPublicKey,
                  sourceSigner: ownerSigner as NonNullable<typeof ownerSigner>,
                  toAddress: sendTo.trim() || DEFAULT_ADDRESS,
                  amount: Number(sendAmount || '0'),
                  ...(sendToken.trim() ? { token: sendToken.trim() } : {}),
                  ...(sendCommitment ? { commitment: sendCommitment as 'confirmed' | 'finalized' } : {}),
                  ...(computeOptions ? { computeOptions } : {}),
                })
                setSendResult(result)
                return result
              })
            }
          >
            Send via SDK
          </button>
        </div>
        {sendResult && renderTransactionResult('Latest Send Result', sendResult)}

        <h2 className="section-title">createAccount</h2>
        <p className="hint">Creates sponsored associated token accounts for the selected token mints using the generated signer.</p>
        <div className="grid">
          <label className="wide">
            Account (from owner signer)
            <input value={ownerPublicKey} readOnly />
          </label>
          <label className="wide">
            Token Mints (comma separated)
            <input
              value={createTokens}
              onChange={(e) => setCreateTokens(e.target.value)}
              placeholder="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
            />
          </label>
          <label className="wide">
            Reference (optional)
            <input
              value={createReference}
              onChange={(e) => setCreateReference(e.target.value)}
              placeholder="custom reference"
            />
          </label>
          <label>
            Compute Unit Limit
            <input value={createComputeUnitLimit} onChange={(e) => setCreateComputeUnitLimit(e.target.value)} placeholder="400000" />
          </label>
          <label>
            Priority Fee (micro-lamports)
            <input value={createComputeUnitPrice} onChange={(e) => setCreateComputeUnitPrice(e.target.value)} placeholder="1000" />
          </label>
          <label>
            Heap Frame (bytes)
            <input value={createHeapFrameBytes} onChange={(e) => setCreateHeapFrameBytes(e.target.value)} placeholder="32768" />
          </label>
        </div>
        <div className="actions">
          <button
            disabled={busy || !ownerSigner || !ownerPublicKey}
            onClick={() =>
              run('createAccount()', async () => {
                const tokens = createTokens
                  .split(',')
                  .map((mint) => mint.trim())
                  .filter(Boolean)
                const computeOptions = buildComputeOptions(
                  createComputeUnitLimit,
                  createComputeUnitPrice,
                  createHeapFrameBytes,
                )

                const result = await gasStation.createAccount({
                  account: ownerPublicKey,
                  signer: ownerSigner as NonNullable<typeof ownerSigner>,
                  ...(tokens.length ? { tokens } : {}),
                  ...(createReference.trim() ? { reference: createReference.trim() } : {}),
                  ...(computeOptions ? { computeOptions } : {}),
                })
                setCreateAccountResult(result)
                return result
              })
            }
          >
            Create Account via SDK
          </button>
        </div>
        {createAccountResult && renderTransactionResult('Latest Create Account Result', createAccountResult)}

        <h2 className="section-title">closeAccount</h2>
        <p className="hint">Use direct mode for a known token account, or wallet mode to auto-discover associated token accounts by mint.</p>
        <div className="grid">
          <label>
            Close Mode
            <select value={closeMode} onChange={(e) => setCloseMode(e.target.value as 'direct' | 'wallet')}>
              <option value="direct">Direct token account</option>
              <option value="wallet">Wallet + token mints</option>
            </select>
          </label>
          {closeMode === 'direct' ? (
            <>
              <label>
                Account Address
                <input
                  value={closeAccountAddress}
                  onChange={(e) => setCloseAccountAddress(e.target.value)}
                  placeholder="Token account address"
                />
              </label>
              <label>
                Destination
                <input
                  value={closeDestination}
                  onChange={(e) => setCloseDestination(e.target.value)}
                  placeholder="Rent destination address"
                />
              </label>
            </>
          ) : (
            <>
              <label className="wide">
                Wallet Address
                <input
                  value={closeWalletAddress}
                  onChange={(e) => setCloseWalletAddress(e.target.value)}
                  placeholder="Wallet address"
                />
              </label>
              <label className="wide">
                Token Mints (comma separated)
                <input
                  value={closeTokens}
                  onChange={(e) => setCloseTokens(e.target.value)}
                  placeholder="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
                />
              </label>
              <label className="wide">
                Reference (optional)
                <input
                  value={closeReference}
                  onChange={(e) => setCloseReference(e.target.value)}
                  placeholder="custom reference"
                />
              </label>
            </>
          )}
          <label>
            Compute Unit Limit
            <input value={closeComputeUnitLimit} onChange={(e) => setCloseComputeUnitLimit(e.target.value)} placeholder="400000" />
          </label>
          <label>
            Priority Fee (micro-lamports)
            <input value={closeComputeUnitPrice} onChange={(e) => setCloseComputeUnitPrice(e.target.value)} placeholder="1000" />
          </label>
          <label>
            Heap Frame (bytes)
            <input value={closeHeapFrameBytes} onChange={(e) => setCloseHeapFrameBytes(e.target.value)} placeholder="32768" />
          </label>
          <label className="wide">
            <input
              type="checkbox"
              checked={closeUseOwnerSigner}
              onChange={(e) => setCloseUseOwnerSigner(e.target.checked)}
            />{' '}
            Use owner signer as close authority
          </label>
        </div>
        <div className="actions">
          <button
            disabled={busy || (closeUseOwnerSigner && !ownerSigner)}
            onClick={() =>
              run('closeAccount()', async () => {
                const tokens = closeTokens
                  .split(',')
                  .map((mint) => mint.trim())
                  .filter(Boolean)
                const computeOptions = buildComputeOptions(
                  closeComputeUnitLimit,
                  closeComputeUnitPrice,
                  closeHeapFrameBytes,
                )

                const result = await gasStation.closeAccount({
                  ...(closeMode === 'direct'
                    ? {
                        accountAddress: closeAccountAddress.trim() || DEFAULT_ADDRESS,
                        destination: closeDestination.trim() || DEFAULT_ADDRESS,
                      }
                    : {
                        account: closeWalletAddress.trim() || ownerPublicKey || DEFAULT_ADDRESS,
                        ...(tokens.length ? { tokens } : {}),
                        ...(closeReference.trim() ? { reference: closeReference.trim() } : {}),
                      }),
                  ...(computeOptions ? { computeOptions } : {}),
                  ...(closeUseOwnerSigner && ownerSigner
                    ? { signer: ownerSigner as NonNullable<typeof ownerSigner> }
                    : {}),
                })
                setCloseAccountResult(result)
                return result
              })
            }
          >
            Close Account via SDK
          </button>
        </div>
        {closeAccountResult && renderTransactionResult('Latest Close Account Result', closeAccountResult)}

        <h2 className="section-title">getAccountInfo</h2>
        <div className="grid">
          <label className="wide">
            Account Address
            <input
              value={accountInfoAddress}
              onChange={(e) => setAccountInfoAddress(e.target.value)}
              placeholder="Wallet or account address"
            />
          </label>
        </div>
        <div className="actions">
          <button
            disabled={busy}
            onClick={() =>
              run('getAccountInfo()', async () => {
                const result = await gasStation.getAccountInfo({ accountAddress: accountInfoAddress.trim() || DEFAULT_ADDRESS })
                setAccountInfoResult(result)
                return result
              })
            }
          >
            Get Account Info
          </button>
        </div>
        {accountInfoResult && (
          <div className="result-card">
            <h3 className="result-title">Latest Account Info Result</h3>
            <pre className="result-json">{JSON.stringify(accountInfoResult, null, 2)}</pre>
          </div>
        )}

        <h2 className="section-title">getHistory</h2>
        <div className="grid">
          <label>
            Page
            <input value={historyPage} onChange={(e) => setHistoryPage(e.target.value)} placeholder="1" />
          </label>
          <label>
            Page Size
            <input value={historyPageSize} onChange={(e) => setHistoryPageSize(e.target.value)} placeholder="10" />
          </label>
          <label className="wide">
            Wallet Address
            <input
              value={historyWalletAddress}
              onChange={(e) => setHistoryWalletAddress(e.target.value)}
              placeholder="Wallet address"
            />
          </label>
        </div>
        <div className="actions">
          <button
            disabled={busy}
            onClick={() =>
              run('getHistory()', async () => {
                const result = await gasStation.getHistory({
                  page: Number(historyPage || '1'),
                  pageSize: Number(historyPageSize || '10'),
                  walletAddress: historyWalletAddress.trim() || DEFAULT_ADDRESS,
                })
                setHistoryResult(result)
                return result
              })
            }
          >
            Get History
          </button>
        </div>
        {historyResult && (
          <div className="result-card">
            <h3 className="result-title">Latest History Result</h3>
            <pre className="result-json">{JSON.stringify(historyResult, null, 2)}</pre>
          </div>
        )}

        <h2 className="section-title">swap</h2>
        <div className="grid">
          <label>
            Input Mint
            <input value={inputMint} onChange={(e) => setInputMint(e.target.value)} />
          </label>
          <label>
            Output Mint
            <input value={outputMint} onChange={(e) => setOutputMint(e.target.value)} />
          </label>
          <label>
            Amount (smallest unit)
            <input value={swapAmount} onChange={(e) => setSwapAmount(e.target.value)} />
          </label>
          <label>
            Slippage (bps)
            <input value={slippageBps} onChange={(e) => setSlippageBps(e.target.value)} />
          </label>
          <label className="wide">
            User Public Key
            <input value={swapUserPublicKey} onChange={(e) => setSwapUserPublicKey(e.target.value)} />
          </label>
        </div>
        <div className="actions">
          <button
            disabled={busy}
            onClick={() =>
              run('swap()', async () => {
                const result = await gasStation.swap({
                  inputMint: inputMint.trim(),
                  outputMint: outputMint.trim(),
                  amount: Number(swapAmount || '0'),
                  userPublicKey: swapUserPublicKey.trim() || DEFAULT_ADDRESS,
                  slippageBps: Number(slippageBps || '50'),
                })
                setSwapResult(result)
                return result
              })
            }
          >
            Run Swap
          </button>
        </div>
        {swapResult && renderTransactionResult('Latest Swap Result', swapResult)}

        <pre className="output" aria-live="polite">
          {busy ? 'Running request...' : output}
        </pre>
      </section>
    </main>
  )
}

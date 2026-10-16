// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountWalletUI } from './ui.js'
import type { AltudeWallet } from './wallet.js'
import type { WalletEvent, WalletState } from './types.js'

describe('mountWalletUI', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('scopes every mounted stylesheet selector to the wallet UI root', () => {
    const state: WalletState = {
      status: 'disconnected',
      session: null,
      address: null,
      protection: null,
      custody: null,
      externalProviderId: null,
      externalChain: null,
    }
    const wallet = {
      state,
      canStartOtp: false,
      canSignInWithSocial: false,
      canSignInWithPasskey: false,
      externalWalletProviders: [],
      onEvent: () => () => {},
      restoreSession: () => Promise.resolve(state),
    } as unknown as AltudeWallet
    const container = document.createElement('div')
    const hostElements = document.createElement('div')
    hostElements.innerHTML = '<button></button><input><p></p><div class="panel overlay"></div>'
    document.body.append(container, hostElements)

    const unmount = mountWalletUI(container, wallet)
    const root = container.querySelector('.altude-wallet-ui')
    const stylesheet = root?.querySelector('style')?.sheet
    if (!root || !stylesheet) throw new Error('Expected the mounted wallet stylesheet.')

    const selectors = getSelectors(stylesheet.cssRules)
    expect(selectors.length).toBeGreaterThan(0)
    for (const selector of selectors) {
      expect(selector.startsWith('.altude-wallet-ui')).toBe(true)
      for (const element of hostElements.children) {
        expect(element.matches(selector)).toBe(false)
      }
    }

    unmount()
  })

  it('renders an accessible dialog and confirms only the structured transaction request', async () => {
    let listener: ((event: WalletEvent) => void) | undefined
    const state: WalletState = {
      status: 'connected',
      session: { user: { id: 'user-1' } },
      address: '11111111111111111111111111111111',
      protection: 'device-local',
      custody: 'embedded',
      externalProviderId: null,
      externalChain: null,
    }
    const approveTransaction = vi.fn(() => Promise.resolve({ signature: 'signature' }))
    const wallet = {
      state,
      canStartOtp: false,
      canSignInWithSocial: false,
      canSignInWithPasskey: false,
      externalWalletProviders: [],
      onEvent: (handler: (event: WalletEvent) => void) => {
        listener = handler
        return () => {
          listener = undefined
        }
      },
      restoreSession: () => Promise.resolve(state),
      getBalance: () => Promise.resolve({ address: state.address ?? '', uiAmount: 1 }),
      createAccount: () => Promise.resolve({ Signature: 'account-signature' }),
      protectWithPasskey: () => Promise.resolve(state),
      signOut: () => Promise.resolve(),
      approveTransaction,
      rejectTransaction: vi.fn(),
    } as unknown as AltudeWallet
    const previousFocus = document.createElement('button')
    document.body.append(previousFocus)
    previousFocus.focus()
    const container = document.createElement('div')
    document.body.append(container)
    const unmount = mountWalletUI(container, wallet, { presentation: 'modal' })

    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(dialog?.getAttribute('aria-label')).toBe('Altude wallet')

    listener?.({
      type: 'transaction:confirmation',
      id: 'request-1',
      intent: {
        kind: 'spl-transfer',
        recipient: '11111111111111111111111111111111',
        mint: 'So11111111111111111111111111111111111111112',
        amount: 1_250_000,
      },
    })
    expect(dialog?.textContent).toContain('So11111111111111111111111111111111111111112')
    const confirm = [...(dialog?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Confirm and submit',
    )
    if (!confirm) throw new Error('Expected a transaction confirmation button.')
    confirm.click()
    await Promise.resolve()
    await Promise.resolve()
    expect(approveTransaction).toHaveBeenCalledWith('request-1')

    unmount()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(previousFocus)
  })

  it('keeps overlapping confirmations independently actionable through out-of-order results', async () => {
    let listener: ((event: WalletEvent) => void) | undefined
    const state: WalletState = {
      status: 'connected',
      session: { user: { id: 'user-1' } },
      address: '11111111111111111111111111111111',
      protection: 'device-local',
      custody: 'embedded',
      externalProviderId: null,
      externalChain: null,
    }
    const approvals = new Map<
      string,
      { resolve: (result: { signature: string }) => void; reject: (error: Error) => void }
    >()
    const approveTransaction = vi.fn(
      (id: string) =>
        new Promise<{ signature: string }>((resolve, reject) => {
          approvals.set(id, { resolve, reject })
        }),
    )
    const rejectTransaction = vi.fn()
    const wallet = {
      state,
      canStartOtp: false,
      canSignInWithSocial: false,
      canSignInWithPasskey: false,
      externalWalletProviders: [],
      onEvent: (handler: (event: WalletEvent) => void) => {
        listener = handler
        return () => {
          listener = undefined
        }
      },
      restoreSession: () => Promise.resolve(state),
      getBalance: () => Promise.resolve({ address: state.address ?? '', uiAmount: 1 }),
      createAccount: () => Promise.resolve({ Signature: 'account-signature' }),
      protectWithPasskey: () => Promise.resolve(state),
      signOut: () => Promise.resolve(),
      approveTransaction,
      rejectTransaction,
    } as unknown as AltudeWallet
    const container = document.createElement('div')
    document.body.append(container)
    const unmount = mountWalletUI(container, wallet, { presentation: 'modal' })

    const requests = ['request-a', 'request-b', 'request-c']
    for (const id of requests) {
      listener?.({
        type: 'transaction:confirmation',
        id,
        intent: {
          kind: 'sol-transfer',
          recipient: '11111111111111111111111111111111',
          amount: 100,
        },
      })
    }

    const dialog = container.querySelector('[role="dialog"]')
    const group = (id: string) =>
      dialog?.querySelector(`[role="group"][aria-label="Transaction confirmation ${id}"]`)
    expect(requests.map((id) => group(id)).every(Boolean)).toBe(true)

    const action = (id: string, label: string) => {
      const control = [...(group(id)?.querySelectorAll('button') ?? [])].find(
        (button) => button.textContent === label,
      )
      if (!control) throw new Error(`Expected ${label} for ${id}.`)
      control.click()
    }
    action('request-a', 'Confirm and submit')
    action('request-b', 'Confirm and submit')
    action('request-c', 'Cancel')
    expect(approveTransaction.mock.calls.map(([id]) => id)).toEqual(['request-a', 'request-b'])
    expect(rejectTransaction).toHaveBeenCalledWith('request-c')
    expect(group('request-a')).not.toBeNull()
    expect(group('request-b')).not.toBeNull()
    expect(group('request-c')).toBeNull()

    listener?.({
      type: 'transaction:complete',
      id: 'request-b',
      result: { signature: 'signature-b' },
    })
    expect(group('request-b')).toBeNull()
    expect(group('request-a')).not.toBeNull()

    const failure = new Error('request-a failed')
    listener?.({ type: 'transaction:error', id: 'request-a', error: failure })
    expect(group('request-a')).toBeNull()
    expect(dialog?.querySelector('[role="alert"]')?.textContent).toBe(failure.message)

    approvals.get('request-a')?.reject(failure)
    approvals.get('request-b')?.resolve({ signature: 'signature-b' })
    await Promise.resolve()
    await Promise.resolve()
    unmount()
  })

  it('offers external providers and avoids embedded-wallet actions for EVM custody', async () => {
    let listener: ((event: WalletEvent) => void) | undefined
    let state: WalletState = {
      status: 'disconnected',
      session: null,
      address: null,
      protection: null,
      custody: null,
      externalProviderId: null,
      externalChain: null,
    }
    const connectExternalWallet = vi.fn(() => {
      state = {
        status: 'connected',
        session: null,
        address: '0x1234567890123456789012345678901234567890',
        protection: null,
        custody: 'external',
        externalProviderId: 'metamask',
        externalChain: 'evm',
      }
      listener?.({ type: 'state', state })
      return Promise.resolve(state)
    })
    const wallet = {
      get state() {
        return state
      },
      canStartOtp: false,
      canSignInWithSocial: false,
      canSignInWithPasskey: false,
      externalWalletProviders: [{ id: 'metamask', label: 'MetaMask' }],
      connectExternalWallet,
      onEvent: (handler: (event: WalletEvent) => void) => {
        listener = handler
        return () => {
          listener = undefined
        }
      },
      restoreSession: () => Promise.resolve(state),
      signOut: () => Promise.resolve(),
    } as unknown as AltudeWallet
    const container = document.createElement('div')
    document.body.append(container)
    const unmount = mountWalletUI(container, wallet, { presentation: 'inline' })

    const connect = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Connect MetaMask',
    )
    expect(connect).toBeDefined()
    connect?.click()
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Connected with MetaMask · EVM')
    })
    expect(connectExternalWallet).toHaveBeenCalledWith('metamask')
    expect(container.textContent).toContain(
      'Solana balance and transaction actions are unavailable.',
    )
    expect(container.textContent).not.toContain('Create token account')
    expect(container.textContent).not.toContain('Protect with passkey')
    expect(container.textContent).toContain('Disconnect wallet')

    unmount()
  })
})

function getSelectors(rules: CSSRuleList): string[] {
  return [...rules].flatMap((rule) => {
    if ('selectorText' in rule) {
      return (rule as CSSStyleRule).selectorText.split(',').map((selector) => selector.trim())
    }
    if ('cssRules' in rule) return getSelectors((rule as CSSGroupingRule).cssRules)
    return []
  })
}

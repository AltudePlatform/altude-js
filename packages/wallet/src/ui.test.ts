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
    }
    const wallet = {
      state,
      canStartOtp: false,
      canSignInWithSocial: false,
      canSignInWithPasskey: false,
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
    }
    const approveTransaction = vi.fn(() => Promise.resolve({ signature: 'signature' }))
    const wallet = {
      state,
      canStartOtp: false,
      canSignInWithSocial: false,
      canSignInWithPasskey: false,
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

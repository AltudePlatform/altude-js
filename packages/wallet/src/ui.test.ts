// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountWalletUI } from './ui.js'
import type { AltudeWallet } from './wallet.js'
import type { WalletEvent, WalletState } from './types.js'

describe('mountWalletUI', () => {
  afterEach(() => {
    document.body.replaceChildren()
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

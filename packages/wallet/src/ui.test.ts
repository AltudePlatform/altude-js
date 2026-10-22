// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountWalletUI } from './ui.js'
import type { AltudeWallet } from './wallet.js'
import type { WalletEvent, WalletState } from './types.js'

describe('mountWalletUI', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('renders the embedded-wallet sign-in flow in the managed UI', async () => {
    const state: WalletState = {
      status: 'disconnected',
      session: null,
      address: null,
      protection: null,
      custody: null,
      externalProviderId: null,
      externalChain: null,
    }
    const startOtp = vi.fn(() => Promise.resolve())
    const verifyOtp = vi.fn(() => Promise.resolve(state))
    const wallet = {
      get state() {
        return state
      },
      canStartOtp: true,
      canSignInWithSocial: false,
      canSignInWithPasskey: false,
      externalWalletProviders: [],
      onEvent: () => () => {},
      restoreSession: () => Promise.resolve(state),
      startOtp,
      verifyOtp,
    } as unknown as AltudeWallet
    const container = document.createElement('div')
    document.body.append(container)
    const unmount = mountWalletUI(container, wallet, {
      presentation: 'modal',
      title: 'Embedded wallet',
      onClose: vi.fn(),
    })

    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Sign in to Embedded wallet')
    expect(dialog?.textContent).not.toContain('or continue with')
    expect(dialog?.textContent).not.toContain('a passkey')
    expect(dialog?.querySelector('.wallet-group')).toBeNull()
    expect(dialog?.querySelector('[aria-label="Email address"]')).not.toBeNull()
    expect(dialog?.querySelector('select')).toBeNull()
    expect(dialog?.querySelector('[aria-label="Close wallet"]')).not.toBeNull()

    const email = dialog?.querySelector<HTMLInputElement>('[aria-label="Email address"]')
    const form = email?.closest('form')
    if (!email || !form) throw new Error('Expected the primary email sign-in form.')
    email.value = 'wallet@example.test'
    email.dispatchEvent(new Event('input', { bubbles: true }))
    expect(form.querySelector('button')?.disabled).toBe(false)
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => {
      expect(startOtp).toHaveBeenCalledWith('email', 'wallet@example.test')
      expect(dialog?.textContent).toContain('Check your email')
    })

    const code = dialog?.querySelector<HTMLInputElement>('[autocomplete="one-time-code"]')
    if (!code) throw new Error('Expected the one-time code field.')
    code.value = '246810'
    code.dispatchEvent(new Event('input', { bubbles: true }))
    const verify = [...(dialog?.querySelectorAll('button') ?? [])].find(
      (control) => control.textContent === 'Verify and continue',
    )
    if (!verify) throw new Error('Expected the verification button.')
    verify.click()
    await vi.waitFor(() => {
      expect(verifyOtp).toHaveBeenCalledWith('email', 'wallet@example.test', '246810')
    })

    unmount()
  })

  it('uses the Auth0-hosted OTP service instead of rendering a local code step', async () => {
    const state: WalletState = {
      status: 'disconnected',
      session: null,
      address: null,
      protection: null,
      custody: null,
      externalProviderId: null,
      externalChain: null,
    }
    const signInWithOtp = vi.fn(() => Promise.resolve(state))
    const startOtp = vi.fn(() => Promise.resolve())
    const wallet = {
      state,
      canStartOtp: true,
      usesHostedOtp: true,
      canSignInWithOtp: (channel: 'email' | 'sms') => channel === 'email',
      canSignInWithSocial: false,
      canSignInWithPasskey: false,
      externalWalletProviders: [],
      onEvent: () => () => {},
      restoreSession: () => Promise.resolve(state),
      signInWithOtp,
      startOtp,
    } as unknown as AltudeWallet
    const container = document.createElement('div')
    document.body.append(container)
    const unmount = mountWalletUI(container, wallet, {
      walletUi: { enabledMethods: { emailOtp: true, smsOtp: true } },
    })

    expect(container.querySelector('[aria-label="Email address"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Phone number including country code"]')).toBeNull()
    const email = container.querySelector<HTMLInputElement>('[aria-label="Email address"]')
    const form = email?.closest('form')
    if (!email || !form) throw new Error('Expected the hosted email sign-in form.')
    email.value = 'wallet@example.test'
    email.dispatchEvent(new Event('input', { bubbles: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => {
      expect(signInWithOtp).toHaveBeenCalledWith('email', 'wallet@example.test')
    })
    expect(startOtp).not.toHaveBeenCalled()
    expect(container.querySelector('[autocomplete="one-time-code"]')).toBeNull()

    unmount()
  })

  it('shows wallet setup progress and returns to sign-in options after a login failure', async () => {
    const state: WalletState = {
      status: 'disconnected',
      session: null,
      address: null,
      protection: null,
      custody: null,
      externalProviderId: null,
      externalChain: null,
    }
    let listener: ((event: WalletEvent) => void) | undefined
    let rejectSignIn: ((error: Error) => void) | undefined
    const wallet = {
      state,
      canStartOtp: false,
      canSignInWithSocial: true,
      canSignInWithPasskey: false,
      externalWalletProviders: [],
      onEvent: (handler: (event: WalletEvent) => void) => {
        listener = handler
        return () => {
          listener = undefined
        }
      },
      restoreSession: () => Promise.resolve(state),
      signInWithSocial: vi.fn(
        () =>
          new Promise<WalletState>((_resolve, reject) => {
            rejectSignIn = reject
          }),
      ),
    } as unknown as AltudeWallet
    const container = document.createElement('div')
    document.body.append(container)
    const unmount = mountWalletUI(container, wallet, {
      presentation: 'inline',
      socialProviders: ['Google'],
    })

    const socialSignIn = [...container.querySelectorAll('button')].find((control) =>
      control.textContent.includes('Continue with Google'),
    )
    if (!socialSignIn) throw new Error('Expected the Google sign-in button.')
    socialSignIn.click()
    expect(container.querySelector('.login-progress')?.textContent).toContain(
      'Confirming your sign-in',
    )

    listener?.({ type: 'setup:progress', stage: 'connecting-account' })
    expect(container.querySelector('.login-progress h2')?.textContent).toBe(
      'Connecting your account',
    )
    rejectSignIn?.(new Error('The wallet API could not create your session.'))
    await vi.waitFor(() => {
      expect(container.querySelector('.login-error h2')?.textContent).toBe('Something went wrong')
    })
    expect(container.querySelector('.login-error')?.textContent).toContain(
      'The wallet API could not create your session.',
    )

    const retry = [...container.querySelectorAll('button')].find(
      (control) => control.textContent === 'Try again',
    )
    if (!retry) throw new Error('Expected a Try again button.')
    retry.click()
    expect(container.querySelector('.login-error')).toBeNull()
    expect(container.querySelector('.login-progress')).toBeNull()
    expect(container.querySelector('h2')?.textContent).toBe('Sign in to Altude')
    expect(container.textContent).toContain('Continue with Google')

    unmount()
  })

  it('shows the embedded account summary after a successful sign-in', () => {
    const state: WalletState = {
      status: 'connected',
      session: {
        user: {
          id: 'user-1',
          email: 'chenard09@gmail.com',
        },
      },
      address: 'EuNK1234567890abcdef3HQV',
      protection: 'device-local',
      custody: 'embedded',
      externalProviderId: null,
      externalChain: null,
    }
    const wallet = {
      state,
      network: 'devnet',
      externalWalletProviders: [],
      onEvent: () => () => {},
      restoreSession: () => Promise.resolve(state),
      signOut: vi.fn(() => Promise.resolve()),
    } as unknown as AltudeWallet
    const container = document.createElement('div')
    document.body.append(container)
    const unmount = mountWalletUI(container, wallet, {
      presentation: 'inline',
      title: 'Altude Demo',
    })

    expect(container.querySelector('.account-contact strong')?.textContent).toBe(
      'chenard09@gmail.com',
    )
    expect(container.querySelector('.account-protection')?.textContent).toContain(
      'Stored on this device',
    )
    expect(container.querySelector('.account-row')?.textContent).toContain('EuNK…3HQV')
    expect(container.querySelector('.recovery-status')?.textContent).toBe('Not set up')
    expect(container.textContent).toContain('Altude Demo')
    const explorer = container.querySelector<HTMLAnchorElement>('.account-explorer')
    expect(explorer?.textContent).toContain('View devnet explorer')
    expect(explorer?.href).toContain('?cluster=devnet')
    expect(container.querySelector<HTMLButtonElement>('.account-actions button')?.disabled).toBe(
      true,
    )
    expect(
      [...container.querySelectorAll('button')].find(
        (control) => control.textContent === 'Sign out',
      ),
    ).toBeDefined()

    unmount()
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
      externalWalletProviders: [{ id: 'metamask', label: 'MetaMask', isAvailable: () => true }],
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

    const walletToggle = [...container.querySelectorAll('button')].find((button) =>
      button.textContent.includes('Connect a Web3 wallet'),
    )
    if (!walletToggle) throw new Error('Expected the Web3 wallet disclosure.')
    expect(walletToggle.getAttribute('aria-expanded')).toBe('false')
    const collapsedList = container.querySelector<HTMLElement>('.wallet-provider-list')
    if (!collapsedList) throw new Error('Expected the provider list.')
    expect(collapsedList.hidden).toBe(true)
    walletToggle.click()

    const expandedToggle = [...container.querySelectorAll('button')].find((button) =>
      button.textContent.includes('Connect a Web3 wallet'),
    )
    if (!expandedToggle) throw new Error('Expected the expanded Web3 wallet disclosure.')
    expect(expandedToggle.getAttribute('aria-expanded')).toBe('true')
    expect(expandedToggle.getAttribute('aria-controls')).toBe(
      container.querySelector('.wallet-provider-list')?.id,
    )
    const expandedList = container.querySelector<HTMLElement>('.wallet-provider-list')
    if (!expandedList) throw new Error('Expected the expanded provider list.')
    expect(expandedList.hidden).toBe(false)
    expect(expandedList.querySelector('.wallet-provider-card')?.textContent).toContain('DETECTED')
    const connect = [...container.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === 'Connect MetaMask',
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

  it('shows only login methods enabled by the supplied wallet and UI configuration', () => {
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
      canSignInWithSocial: true,
      canSignInWithPasskey: true,
      externalWalletProviders: [{ id: 'phantom', label: 'Phantom' }],
      onEvent: () => () => {},
      restoreSession: () => Promise.resolve(state),
    } as unknown as AltudeWallet
    const container = document.createElement('div')
    document.body.append(container)
    const unmount = mountWalletUI(container, wallet, {
      socialProviders: ['Google'],
    })

    expect(container.textContent).toContain('Continue with Google')
    expect(container.textContent).toContain('Passkey')
    expect(container.textContent).toContain('Connect a Web3 wallet')
    expect(container.textContent).not.toContain('Continue with Apple')
    expect(container.querySelector('[aria-label="Email address"]')).toBeNull()
    expect(container.querySelector('.provider-glyph')?.textContent).toBe('G')

    unmount()
  })

  it('treats transaction config methods as an allowlist', () => {
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
      canStartOtp: true,
      canSignInWithSocial: true,
      canSignInWithPasskey: true,
      externalWalletProviders: [
        { id: 'phantom', label: 'Phantom' },
        { id: 'metamask', label: 'MetaMask' },
      ],
      onEvent: () => () => {},
      restoreSession: () => Promise.resolve(state),
    } as unknown as AltudeWallet
    const container = document.createElement('div')
    document.body.append(container)
    const unmount = mountWalletUI(container, wallet, {
      socialProviders: ['Google', 'Apple'],
      walletUi: {
        enabledMethods: {
          emailOtp: false,
          smsOtp: false,
          socialProviders: ['google-oauth2'],
          passkey: false,
          externalWalletProviders: ['phantom'],
        },
      },
    })

    expect(container.querySelector('[aria-label="Email address"]')).toBeNull()
    expect(container.querySelector('button.provider-method')?.textContent).toContain('Google')
    expect(container.querySelectorAll('button.provider-method')).toHaveLength(1)
    expect(container.querySelector('.passkey-action')).toBeNull()
    expect(container.textContent).toContain('Connect a Web3 wallet')
    expect(container.textContent).toContain('Phantom')
    expect(container.textContent).not.toContain('MetaMask')
    const content = container.querySelector('.content')
    const socialMethods = content?.querySelector('.method-list')
    const divider = content?.querySelector('.or-divider')
    const web3Wallets = content?.querySelector('.wallet-group')
    if (!socialMethods || !divider || !web3Wallets) {
      throw new Error('Expected the configured sign-in methods in the reference layout.')
    }
    expect(
      socialMethods.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      divider.compareDocumentPosition(web3Wallets) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

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

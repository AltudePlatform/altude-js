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
      canSignInWithOtp: (channel: 'email' | 'sms') => channel === 'email',
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
      authMethods: { emailOtp: true },
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
      expect(dialog?.textContent).toContain('Check your inbox')
      expect(dialog?.querySelector('.subtitle strong')?.textContent).toBe('wallet@example.test')
    })

    const codes = [...(dialog?.querySelectorAll<HTMLInputElement>('.otp-fields input') ?? [])]
    const codeAt = (index: number) => {
      const field = codes[index]
      if (!field) throw new Error('Expected a code digit input.')
      return field
    }
    expect(codes).toHaveLength(6)
    expect(document.activeElement).toBe(codes[0])
    const verify = [...(dialog?.querySelectorAll('button') ?? [])].find(
      (control) => control.textContent === 'Verify and continue',
    )
    if (!verify) throw new Error('Expected the verification button.')
    expect(verify.disabled).toBe(true)
    expect(verify.hidden).toBe(true)
    expect(dialog?.querySelector('.otp-resend')?.textContent).toContain("Didn't get it?Resend code")
    for (const [index, digit] of ['2', '4', '6', '8', '1'].entries()) {
      const field = codeAt(index)
      expect(field.inputMode).toBe('numeric')
      expect(field.getAttribute('aria-label')).toBe(`Digit ${String(index + 1)} of 6`)
      field.value = digit
      field.dispatchEvent(new Event('input', { bubbles: true }))
      expect(document.activeElement).toBe(codes[index + 1])
    }
    expect(verifyOtp).not.toHaveBeenCalled()
    codeAt(5).dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }))
    expect(document.activeElement).toBe(codes[4])
    expect(codeAt(4).value).toBe('')
    codeAt(4).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(document.activeElement).toBe(codes[3])
    codeAt(3).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.activeElement).toBe(codes[4])
    codeAt(4).value = 'x'
    codeAt(4).dispatchEvent(new Event('input', { bubbles: true }))
    expect(codeAt(4).value).toBe('')
    codeAt(4).value = '1'
    codeAt(4).dispatchEvent(new Event('input', { bubbles: true }))
    codeAt(5).value = '0'
    codeAt(5).dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => {
      expect(verifyOtp).toHaveBeenCalledWith('email', 'wallet@example.test', '246810')
    })

    unmount()
  })

  it.each(['email', 'sms'] as const)('accepts pasted and autofilled six-digit %s codes', async (channel) => {
    const state: WalletState = {
      status: 'disconnected', session: null, address: null, protection: null,
      custody: null, externalProviderId: null, externalChain: null,
    }
    const verifyOtp = vi.fn(() => Promise.resolve(state))
    const wallet = {
      state, canStartOtp: true, canSignInWithSocial: false,
      canSignInWithPasskey: false, externalWalletProviders: [],
      onEvent: () => () => {}, restoreSession: () => Promise.resolve(state),
      startOtp: vi.fn(() => Promise.resolve()), verifyOtp,
    } as unknown as AltudeWallet
    const container = document.createElement('div')
    document.body.append(container)
    const unmount = mountWalletUI(container, wallet, {
      walletUi: {
        authMethods: { emailOtp: channel === 'email', smsOtp: channel === 'sms' },
        legal: { smsConsentText: 'I agree to receive a sign-in code by SMS.' },
      },
    })
    const identifier = channel === 'email' ? 'wallet@example.test' : '+12025550123'
    const identity = container.querySelector<HTMLInputElement>('.magic input')
    const form = identity?.closest('form')
    if (!identity || !form) throw new Error('Expected an identifier form.')
    identity.value = identifier
    identity.dispatchEvent(new Event('input', { bubbles: true }))
    const consent = container.querySelector<HTMLInputElement>('.sms-consent input')
    if (consent) {
      consent.checked = true
      consent.dispatchEvent(new Event('change', { bubbles: true }))
    }
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => {
      expect(container.querySelectorAll('.otp-fields input')).toHaveLength(6)
    })
    const digits = container.querySelectorAll<HTMLInputElement>('.otp-fields input')
    const first = digits[0]
    const third = digits[2]
    if (!first || !third) throw new Error('Expected six code inputs.')
    if (channel === 'email') {
      const paste = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(paste, 'clipboardData', { value: { getData: () => '246 810' } })
      third.dispatchEvent(paste)
      expect(paste.defaultPrevented).toBe(true)
    } else {
      first.value = '246810'
      first.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await vi.waitFor(() => {
      expect(verifyOtp).toHaveBeenCalledWith(channel, identifier, '246810')
    })
    expect(verifyOtp).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('keeps OTP errors inline and resends to the same identifier without changing the method', async () => {
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
    const verifyOtp = vi.fn(() => Promise.reject(new Error('That code has expired. Request a new one.')))
    const wallet = {
      state,
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
      authMethods: { emailOtp: true, smsOtp: true },
      legal: { smsConsentText: 'I agree to receive a sign-in code by SMS.' },
    })
    const phone = container.querySelector<HTMLButtonElement>('[aria-label="Continue with phone"]')
    if (!phone) throw new Error('Expected the phone sign-in action.')
    expect(phone.querySelector('svg')).not.toBeNull()
    phone.click()
    const identity = container.querySelector<HTMLInputElement>('.magic input')
    const form = identity?.closest('form')
    if (!identity || !form) throw new Error('Expected the phone identifier form.')
    identity.value = '+12025550123'
    identity.dispatchEvent(new Event('input', { bubbles: true }))
    const consent = container.querySelector<HTMLInputElement>('.sms-consent input')
    if (!consent) throw new Error('Expected SMS consent.')
    consent.checked = true
    consent.dispatchEvent(new Event('change', { bubbles: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => {
      expect(container.querySelector('h2')?.textContent).toBe('Check your messages')
    })
    const digit = container.querySelector<HTMLInputElement>('.otp-fields input')
    if (!digit) throw new Error('Expected the OTP form.')
    digit.value = '246810'
    digit.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('That code has expired.')
    })
    expect(container.querySelector('.login-error')).toBeNull()
    expect(container.querySelectorAll('.otp-fields input')).toHaveLength(6)
    const resend = [...container.querySelectorAll('button')].find((control) => control.textContent === 'Resend code')
    if (!resend) throw new Error('Expected the resend action.')
    resend.click()
    await vi.waitFor(() => {
      expect(startOtp).toHaveBeenCalledTimes(2)
      expect(container.querySelector('[role="status"]')?.textContent).toBe('We sent a fresh code to your phone.')
    })
    expect(startOtp).toHaveBeenLastCalledWith('sms', '+12025550123')
    expect([...container.querySelectorAll<HTMLInputElement>('.otp-fields input')].map((field) => field.value)).toEqual(['', '', '', '', '', ''])
    expect(container.querySelector('[role="alert"]')).toBeNull()
    const back = container.querySelector<HTMLButtonElement>('[aria-label="Back to sign-in"]')
    if (!back) throw new Error('Expected back navigation.')
    back.click()
    expect(container.querySelector<HTMLInputElement>('.magic input')?.value).toBe('+12025550123')
    expect(container.querySelector('.otp-fields')).toBeNull()
    unmount()
  })

  it('supports explicitly hosted OTP adapters without rendering a local code step', async () => {
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
      walletUi: { authMethods: { emailOtp: true, smsOtp: true } },
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
      authMethods: { socialProviders: ['Google'] },
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

  it('rejects unsubmitted confirmations on unmount without cancelling a submission', async () => {
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
    let resolveSubmitting!: (result: { signature: string }) => void
    const submitting = new Promise<{ signature: string }>((resolve) => {
      resolveSubmitting = resolve
    })
    const approveTransaction = vi.fn(() => submitting)
    let rejectUnsubmitted!: (error: Error) => void
    const unsubmittedResult = new Promise<void>((_resolve, reject) => {
      rejectUnsubmitted = reject
    })
    const rejectTransaction = vi.fn((id: string) => {
      if (id === 'unsubmitted-request') {
        rejectUnsubmitted(new Error('The wallet user rejected this transaction.'))
      }
    })
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
      approveTransaction,
      rejectTransaction,
    } as unknown as AltudeWallet
    const container = document.createElement('div')
    document.body.append(container)
    const unmount = mountWalletUI(container, wallet, { presentation: 'modal' })

    for (const id of ['unsubmitted-request', 'submitting-request']) {
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
    const submittingGroup = container.querySelector(
      '[aria-label="Transaction confirmation submitting-request"]',
    )
    const confirm = [...(submittingGroup?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Confirm and submit',
    )
    if (!confirm) throw new Error('Expected a transaction confirmation button.')
    confirm.click()
    expect(approveTransaction).toHaveBeenCalledWith('submitting-request')

    const unsubmittedRejection = expect(unsubmittedResult).rejects.toThrow(
      'The wallet user rejected this transaction.',
    )
    unmount()

    await unsubmittedRejection
    expect(rejectTransaction).toHaveBeenCalledTimes(1)
    expect(rejectTransaction).toHaveBeenCalledWith('unsubmitted-request')
    expect(rejectTransaction).not.toHaveBeenCalledWith('submitting-request')
    resolveSubmitting({ signature: 'signature' })
    await Promise.resolve()
    await Promise.resolve()
  })

  it('keeps external-wallet confirmations actionable after an unchanged connected-state event', () => {
    let listener: ((event: WalletEvent) => void) | undefined
    const state: WalletState = {
      status: 'connected',
      session: null,
      address: '0x1234567890123456789012345678901234567890',
      protection: null,
      custody: 'external',
      externalProviderId: 'metamask',
      externalChain: 'evm',
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
      signOut: () => Promise.resolve(),
      lock: () => listener?.({ type: 'state', state }),
      approveTransaction,
      rejectTransaction: vi.fn(),
    } as unknown as AltudeWallet
    const container = document.createElement('div')
    document.body.append(container)
    const unmount = mountWalletUI(container, wallet, { presentation: 'modal' })

    listener?.({
      type: 'transaction:confirmation',
      id: 'external-request',
      intent: {
        kind: 'sol-transfer',
        recipient: '11111111111111111111111111111111',
        amount: 100,
      },
    })
    wallet.lock()

    const group = container.querySelector(
      '[role="group"][aria-label="Transaction confirmation external-request"]',
    )
    expect(group).not.toBeNull()
    const confirm = [...(group?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Confirm and submit',
    )
    expect(confirm).toBeDefined()
    confirm?.click()
    expect(approveTransaction).toHaveBeenCalledWith('external-request')

    listener?.({
      type: 'state',
      state: {
        ...state,
        session: { user: { id: 'changed-user' } },
        protection: 'device-local',
        custody: 'embedded',
        externalProviderId: null,
        externalChain: null,
      },
    })
    expect(
      container.querySelector(
        '[role="group"][aria-label="Transaction confirmation external-request"]',
      ),
    ).toBeNull()

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
    const unmount = mountWalletUI(container, wallet, {
      presentation: 'inline',
      authMethods: { externalWallets: ['metamask'] },
    })

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
    expect(expandedList.querySelector('.wallet-provider-card')?.textContent).toContain('Detected')
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
      authMethods: { socialProviders: ['Google'], passkey: true, externalWallets: ['phantom'] },
    })

    expect(container.textContent).toContain('Continue with Google')
    expect(container.querySelector('.passkey-action')?.getAttribute('aria-label')).toBe('Use a passkey')
    expect(container.textContent).toContain('Connect a Web3 wallet')
    expect(container.textContent).not.toContain('Continue with Apple')
    expect(container.querySelector('[aria-label="Email address"]')).toBeNull()
    expect(container.querySelector('.provider-glyph svg')).not.toBeNull()
    expect(container.querySelector('.provider-method')?.getAttribute('aria-label')).toBe('Continue with Google')

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
        branding: { appName: 'Example Pay', tagline: 'Your wallet, your control' },
        legal: {
          termsUrl: 'https://example.test/terms',
          privacyUrl: 'https://example.test/privacy',
        },
        trust: { ikaRecoveryVerified: false, soc2Verified: true },
        authMethods: {
          emailOtp: false,
          smsOtp: false,
          socialProviders: ['google-oauth2'],
          passkey: false,
          externalWallets: ['phantom'],
        },
      },
    })

    expect(container.querySelector('[aria-label="Email address"]')).toBeNull()
    expect(container.querySelector('button.provider-method')?.textContent).toContain('Google')
    expect(container.querySelectorAll('button.provider-method')).toHaveLength(1)
    expect(container.querySelector('.passkey-action')).toBeNull()
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(
      'Example Pay',
    )
    expect(container.textContent).toContain('Your wallet, your control')
    expect(container.querySelector('a[href="https://example.test/terms"]')).not.toBeNull()
    expect(container.querySelector('a[href="https://example.test/privacy"]')).not.toBeNull()
    expect(container.textContent).toContain('SOC 2')
    expect(container.textContent).not.toContain('Secure recovery by Ika')
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

  it('renders API SMS consent as text and does not infer unavailable auth methods', () => {
    const wallet = {
      state: {
        status: 'disconnected',
        session: null,
        address: null,
        protection: null,
        custody: null,
        externalProviderId: null,
        externalChain: null,
      },
      canStartOtp: true,
      canSignInWithSocial: true,
      canSignInWithPasskey: true,
      externalWalletProviders: [],
      onEvent: () => () => {},
      restoreSession: () => Promise.resolve(),
    } as unknown as AltudeWallet
    const container = document.createElement('div')
    document.body.append(container)
    const unmount = mountWalletUI(container, wallet, {
      socialProviders: ['Google'],
      walletUi: {
        legal: { smsConsentText: 'Receive a sign-in code. <script>not markup</script>' },
        authMethods: { smsOtp: true, socialProviders: ['unconfigured-provider'] },
      },
    })
    expect(container.querySelector('[aria-label="Email address"]')).toBeNull()
    expect(
      container.querySelector('[aria-label="Phone number including country code"]'),
    ).not.toBeNull()
    expect(container.textContent).toContain('<script>not markup</script>')
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('.passkey-action')).toBeNull()
    expect(container.querySelector('.provider-method')).toBeNull()
    expect(container.textContent).not.toContain('SOC 2')
    expect(container.textContent).not.toContain('Secure recovery by Ika')
    unmount()
  })

  it('requires explicit SMS consent, rejects bypassed submits, and resets consent on number/channel changes', () => {
    const { wallet, mocks, container } = createUiHarness()
    const unmount = mountWalletUI(container, wallet, {
      authMethods: { emailOtp: true, smsOtp: true },
      legal: { smsConsentText: 'I agree to receive a sign-in code by SMS.' },
    })
    clickControl(container, 'Continue with phone')
    const phone = requireInput(container, '.magic input')
    const form = requireElement(container, '.magic')
    const send = findControl(form, 'Send code')
    const consent = requireInput(container, '.sms-consent input')
    expect(consent.type).toBe('checkbox')
    expect(consent.checked).toBe(false)
    phone.value = '+12025550123'
    phone.dispatchEvent(new Event('input'))
    expect(send.disabled).toBe(true)
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    expect(mocks.startOtp).not.toHaveBeenCalled()
    consent.checked = true
    consent.dispatchEvent(new Event('change'))
    expect(send.disabled).toBe(false)
    phone.value = '+12025550124'
    phone.dispatchEvent(new Event('input'))
    expect(consent.checked).toBe(false)
    expect(send.disabled).toBe(true)
    consent.checked = true
    consent.dispatchEvent(new Event('change'))
    clickControl(container, 'Use email instead')
    clickControl(container, 'Continue with phone')
    expect(container.querySelector<HTMLInputElement>('.sms-consent input')?.checked).toBe(false)
    expect(container.querySelector<HTMLButtonElement>('.magic button')?.disabled).toBe(true)
    unmount()
  })

  it('gates SMS resend on the same explicit consent and allows consent to be withdrawn', async () => {
    const { wallet, mocks, container } = createUiHarness()
    const unmount = mountWalletUI(container, wallet, {
      authMethods: { smsOtp: true },
      legal: { smsConsentText: 'I agree to receive a sign-in code by SMS.' },
    })
    const phone = requireInput(container, '.magic input')
    phone.value = '+12025550123'
    phone.dispatchEvent(new Event('input'))
    const consent = requireInput(container, '.sms-consent input')
    consent.checked = true
    consent.dispatchEvent(new Event('change'))
    requireElement(container, '.magic').dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => { expect(container.querySelector('.otp-fields')).not.toBeNull(); })
    const otpConsent = requireInput(container, '.sms-consent input')
    expect(otpConsent.checked).toBe(true)
    otpConsent.checked = false
    otpConsent.dispatchEvent(new Event('change'))
    const resend = findControl(container, 'Resend code')
    expect(resend.disabled).toBe(true)
    resend.click()
    expect(mocks.startOtp).toHaveBeenCalledTimes(1)
    otpConsent.checked = true
    otpConsent.dispatchEvent(new Event('change'))
    expect(resend.disabled).toBe(false)
    resend.click()
    await vi.waitFor(() => { expect(mocks.startOtp).toHaveBeenCalledTimes(2); })
    expect(mocks.startOtp).toHaveBeenLastCalledWith('sms', '+12025550123')
    unmount()
  })

  it.each([undefined, '', '   '])('blocks SMS delivery without configured consent text (%s)', (smsConsentText) => {
    const { wallet, mocks, container } = createUiHarness()
    const unmount = mountWalletUI(container, wallet, {
      authMethods: { smsOtp: true },
      legal: smsConsentText === undefined ? {} : { smsConsentText },
    })
    const phone = requireInput(container, '.magic input')
    phone.value = '+12025550123'
    phone.dispatchEvent(new Event('input'))
    expect(container.querySelector('.sms-consent')).toBeNull()
    expect(container.querySelector<HTMLButtonElement>('.magic button')?.disabled).toBe(true)
    requireElement(container, '.magic').dispatchEvent(new Event('submit', { cancelable: true }))
    expect(mocks.startOtp).not.toHaveBeenCalled()
    unmount()
  })

  it('offers no guessed methods even when every adapter is available', () => {
    const { wallet, mocks, container } = createUiHarness()
    mocks.canSignInWithSocial = true
    mocks.canSignInWithPasskey = true
    mocks.externalWalletProviders = [{ id: 'phantom', label: 'Phantom', isAvailable: () => true }]
    const unmount = mountWalletUI(container, wallet, { socialProviders: ['Google'] })
    expect(container.querySelector('.content')?.textContent).toContain('No sign-in methods are configured')
    expect(container.querySelector('.magic,.method-list,.wallet-group')).toBeNull()
    unmount()
  })

  it('gives incomplete server settings full precedence over explicit method and legal fallbacks', () => {
    const { wallet, container } = createUiHarness()
    const fallback = {
      authMethods: { emailOtp: true, smsOtp: true },
      legal: { smsConsentText: 'Fallback consent', termsUrl: 'https://example.test/terms' },
    }
    let unmount = mountWalletUI(container, wallet, { ...fallback, walletUi: {} })
    expect(container.querySelector('.magic')).toBeNull()
    expect(container.querySelector('.legal-links')).toBeNull()
    unmount()
    unmount = mountWalletUI(container, wallet, {
      ...fallback,
      walletUi: { authMethods: { smsOtp: true } },
    })
    expect(container.querySelector('.magic input[type="tel"]')).not.toBeNull()
    expect(container.querySelector('.sms-consent')).toBeNull()
    expect(container.querySelector<HTMLButtonElement>('.magic button')?.disabled).toBe(true)
    expect(container.querySelector('.legal-links')).toBeNull()
    unmount()
  })

  it('hides unavailable external wallets without attempting to connect', () => {
    const { wallet, mocks, container } = createUiHarness()
    mocks.externalWalletProviders = [{ id: 'phantom', label: 'Phantom', isAvailable: () => false }]
    const unmount = mountWalletUI(container, wallet, {
      authMethods: { externalWallets: ['phantom'] },
    })
    expect(container.querySelector('[aria-label="Connect Phantom"]')).toBeNull()
    expect(container.querySelector('.wallet-group-toggle')).toBeNull()
    expect(mocks.connectExternalWallet).not.toHaveBeenCalled()
    unmount()
  })

  it('focuses the modal on mount, loops legal anchors and enabled controls, and restores exit focus', () => {
    const { wallet, container } = createUiHarness()
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const onClose = vi.fn()
    const unmount = mountWalletUI(container, wallet, {
      onClose, authMethods: { emailOtp: true },
      legal: { termsUrl: 'https://example.test/terms', privacyUrl: 'https://example.test/privacy' },
    })
    const dialog = requireElement(container, '[role="dialog"]')
    const close = requireElement(dialog, '[aria-label="Close wallet"]')
    const last = requireElement(dialog, '.legal-links a:last-child')
    expect(document.activeElement).toBe(close)
    const excluded = document.createElement('a')
    excluded.href = 'https://example.test/hidden'
    excluded.setAttribute('tabindex', '-1')
    dialog.append(excluded)
    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(last)
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(close)
    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(onClose).toHaveBeenCalledOnce()
    unmount()
    expect(document.activeElement).toBe(opener)
  })

  it('focuses an otherwise empty dialog and contains Tab when there are no eligible controls', () => {
    const { wallet, container } = createUiHarness()
    const unmount = mountWalletUI(container, wallet)
    const dialog = requireElement(container, '[role="dialog"]')
    expect(document.activeElement).toBe(dialog)
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    dialog.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(dialog)
    const css = requireElement(container, 'style').textContent
    expect(css).toContain('@media(prefers-reduced-motion:reduce){.altude-wallet-ui *,.altude-wallet-ui *::before,.altude-wallet-ui *::after')
    unmount()
  })

  it.each(['embedded', 'local'] as const)('exposes managed actions for %s custody without implying a local API session', async (custody) => {
    const { wallet, mocks, container, setState } = createUiHarness(connectedUiState(custody))
    mocks.canUseLocalPasskey = true
    const unmount = mountWalletUI(container, wallet)
    if (custody === 'local') {
      expect(wallet.state.session).toBeNull()
      expect(container.querySelector('.account-contact')?.textContent).toContain('Local wallet')
    }
    expect(findControl(container, 'Create token account').disabled).toBe(false)
    clickControl(container, 'Check balance')
    await vi.waitFor(() => { expect(container.querySelector('[role="status"]')?.textContent).toBe('Balance: 1 SOL'); })
    clickControl(container, 'Protect with passkey')
    await vi.waitFor(() => { expect(mocks.protectWithPasskey).toHaveBeenCalledOnce(); })
    await vi.waitFor(() => { expect(findControl(container, 'Lock wallet').disabled).toBe(false); })
    clickControl(container, 'Lock wallet')
    expect(mocks.lock).toHaveBeenCalledOnce()
    setState({ ...wallet.state, status: 'locked', protection: 'passkey' })
    clickControl(container, 'Unlock with passkey')
    await vi.waitFor(() => { expect(mocks.unlockWithPasskey).toHaveBeenCalledOnce(); })
    await vi.waitFor(() => { expect(findControl(container, 'Sign out').disabled).toBe(false); })
    clickControl(container, 'Sign out')
    await vi.waitFor(() => { expect(mocks.signOut).toHaveBeenCalledOnce(); })
    unmount()
  })

  it('refreshes passkey capability before showing protection and ignores a late refresh after unmount', async () => {
    const { wallet, mocks, container } = createUiHarness(connectedUiState())
    let resolve!: (available: boolean) => void
    const getPasskeyAvailability = vi.fn(() => new Promise<boolean>((done) => { resolve = done }))
    Object.assign(mocks, { getPasskeyAvailability })
    const unmount = mountWalletUI(container, wallet)
    expect(getPasskeyAvailability).toHaveBeenCalledOnce()
    expect(container.querySelector('.actions')?.textContent).not.toContain('Protect with passkey')
    mocks.canUseLocalPasskey = true
    resolve(true)
    await vi.waitFor(() => { expect(findControl(container, 'Protect with passkey')).toBeDefined(); })
    unmount()
    const unmountAgain = mountWalletUI(container, wallet)
    unmountAgain()
    resolve(false)
    await Promise.resolve()
    expect(container.childElementCount).toBe(0)
  })

  it('reports passkey capability refresh failures without enabling unsupported actions', async () => {
    const { wallet, mocks, container } = createUiHarness(connectedUiState())
    Object.assign(mocks, { getPasskeyAvailability: vi.fn(() => Promise.reject(new Error('Passkey detection failed.'))) })
    const unmount = mountWalletUI(container, wallet)
    await vi.waitFor(() => { expect(container.querySelector('[role="alert"]')?.textContent).toBe('Passkey detection failed.'); })
    expect(container.querySelector('.actions')?.textContent).not.toContain('Protect with passkey')
    unmount()
  })

  it('creates a local-only passkey wallet and exposes a copyable public handle', async () => {
    const { wallet, mocks, container, setState } = createUiHarness()
    mocks.canUseLocalPasskey = true
    const localState = { ...connectedUiState('local'), protection: 'passkey' as const }
    mocks.createLocalWallet.mockImplementation(() => {
      setState(localState)
      return Promise.resolve(localState)
    })
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    const unmount = mountWalletUI(container, wallet, { authMethods: { passkey: true } })
    expect(container.querySelector('.local-wallet')?.textContent).toContain('does not sign you in')
    expect(container.querySelector('.passkey-action')).toBeNull()
    clickControl(container, 'Create local wallet')
    await vi.waitFor(() => { expect(container.querySelector('.local-handle')?.textContent).toBe('local:identity'); })
    expect(mocks.createLocalWallet).toHaveBeenCalledOnce()
    expect(wallet.state.session).toBeNull()
    expect(container.querySelector('.note')?.textContent).toContain('no Altude API session')
    await vi.waitFor(() => { expect(findControl(container, 'Copy local wallet handle').disabled).toBe(false); })
    clickControl(container, 'Copy local wallet handle')
    await vi.waitFor(() => { expect(copy).toHaveBeenCalledWith('local:identity'); })
    copy.mockRestore()
    unmount()
  })

  it('reopens a local wallet by its explicitly entered handle without authenticated passkey login', async () => {
    const { wallet, mocks, container, setState } = createUiHarness()
    mocks.canUseLocalPasskey = true
    const localState = { ...connectedUiState('local'), protection: 'passkey' as const }
    mocks.openLocalWallet.mockImplementation((_handle) => {
      setState(localState)
      return Promise.resolve(localState)
    })
    const unmount = mountWalletUI(container, wallet, { authMethods: { passkey: true } })
    const input = requireInput(container, '.local-wallet-return input')
    expect(input.closest('label')?.textContent).toContain('Local wallet handle')
    expect(findControl(container, 'Open local wallet').disabled).toBe(true)
    requireElement(container, '.local-wallet-return').dispatchEvent(new Event('submit', { cancelable: true }))
    expect(mocks.openLocalWallet).not.toHaveBeenCalled()
    input.value = '  altude:local:v1:my-public-handle  '
    input.dispatchEvent(new Event('input'))
    clickControl(container, 'Open local wallet')
    await vi.waitFor(() => { expect(mocks.openLocalWallet).toHaveBeenCalledWith('altude:local:v1:my-public-handle'); })
    expect(wallet.state.session).toBeNull()
    expect(container.querySelector('.local-handle')?.textContent).toBe('local:identity')
    unmount()
  })

  it('requires both explicit passkey configuration and local passkey capability', async () => {
    const { wallet, mocks, container } = createUiHarness()
    let resolve!: (available: boolean) => void
    Object.assign(mocks, { getPasskeyAvailability: vi.fn(() => new Promise<boolean>((done) => { resolve = done })) })
    let unmount = mountWalletUI(container, wallet, { authMethods: { passkey: true } })
    expect(container.querySelector('.local-wallet')).toBeNull()
    resolve(false)
    await Promise.resolve()
    expect(container.querySelector('.local-wallet')).toBeNull()
    unmount()
    mocks.canUseLocalPasskey = true
    unmount = mountWalletUI(container, wallet, { authMethods: { passkey: true }, walletUi: {} })
    expect(container.querySelector('.local-wallet')).toBeNull()
    expect(mocks.createLocalWallet).not.toHaveBeenCalled()
    expect(mocks.openLocalWallet).not.toHaveBeenCalled()
    unmount()
  })

  it('keeps API-authenticated passkey login separate from local wallet actions', () => {
    const { wallet, mocks, container } = createUiHarness()
    mocks.canSignInWithPasskey = true
    mocks.canUseLocalPasskey = true
    const unmount = mountWalletUI(container, wallet, { authMethods: { passkey: true } })
    expect(container.querySelector('.passkey-action')?.getAttribute('aria-label')).toBe('Use a passkey')
    expect(findControl(container, 'Create local wallet')).toBeDefined()
    expect(findControl(container, 'Open local wallet')).toBeDefined()
    unmount()
  })

  it('keeps the entered handle available after a failed local wallet open', async () => {
    const { wallet, mocks, container } = createUiHarness()
    mocks.canUseLocalPasskey = true
    mocks.openLocalWallet.mockRejectedValue(new Error('Local wallet not found.'))
    const unmount = mountWalletUI(container, wallet, { authMethods: { passkey: true } })
    const input = requireInput(container, '.local-wallet-return input')
    input.value = 'altude:local:v1:missing'
    input.dispatchEvent(new Event('input'))
    clickControl(container, 'Open local wallet')
    await vi.waitFor(() => { expect(container.querySelector('[role="alert"]')?.textContent).toBe('Local wallet not found.'); })
    expect(requireInput(container, '.local-wallet-return input').value).toBe('altude:local:v1:missing')
    unmount()
  })

  it.each(['embedded', 'local', 'external'] as const)('checks SOL or a selected SPL token balance for %s wallets', async (custody) => {
    const state: WalletState = custody === 'external'
      ? { ...connectedUiState(), custody: 'external', session: null, externalChain: 'solana', externalProviderId: 'phantom' }
      : connectedUiState(custody)
    const { wallet, mocks, container } = createUiHarness(state)
    const unmount = mountWalletUI(container, wallet)
    const mint = requireInput(container, '.balance-form input')
    expect(mint.closest('label')?.textContent).toContain('Token mint')
    clickControl(container, 'Check balance')
    await vi.waitFor(() => { expect(container.querySelector('[role="status"]')?.textContent).toBe('Balance: 1 SOL'); })
    expect(mocks.getBalance).toHaveBeenLastCalledWith(undefined)
    const nextMint = requireInput(container, '.balance-form input')
    nextMint.value = '  token-mint-123  '
    nextMint.dispatchEvent(new Event('input'))
    clickControl(container, 'Check balance')
    await vi.waitFor(() => { expect(container.querySelector('[role="status"]')?.textContent).toBe('Balance: 1 tokens (mint: token-mint-123)'); })
    expect(mocks.getBalance).toHaveBeenLastCalledWith('token-mint-123')
    unmount()
  })

  it('aborts its provisioning request on teardown before confirmation arrives', async () => {
    const { wallet, mocks, container } = createUiHarness(connectedUiState())
    let captured: AbortSignal | undefined
    mocks.createAccount.mockImplementation((_tokens, signal) => {
      captured = signal
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(new Error('Cancelled.')) }, { once: true })
      })
    })
    const unmount = mountWalletUI(container, wallet)
    clickControl(container, 'Create token account')
    expect(captured?.aborted).toBe(false)
    unmount()
    expect(captured?.aborted).toBe(true)
    await Promise.resolve()
    expect(container.childElementCount).toBe(0)
    expect(mocks.approveProvisioning).not.toHaveBeenCalled()
  })

  it('keeps provisioning confirmation actionable while createAccount awaits explicit approval', async () => {
    const { wallet, mocks, container, emit } = createUiHarness(connectedUiState())
    let finish!: (result: typeof accountResult) => void
    mocks.createAccount.mockImplementation(() => {
      emit({ type: 'provisioning:confirmation', id: 'create-1', tokens: ['mint-1', 'mint-2'], network: 'devnet' })
      return new Promise((resolve) => { finish = resolve })
    })
    mocks.approveProvisioning.mockImplementation(() => {
      emit({ type: 'provisioning:complete', id: 'create-1', result: accountResult })
      finish(accountResult)
      return Promise.resolve(accountResult)
    })
    const unmount = mountWalletUI(container, wallet)
    clickControl(container, 'Create token account')
    const confirmation = requireElement(container, '[aria-label="Token account confirmation create-1"]')
    expect(confirmation.textContent).toContain('devnet')
    expect(confirmation.textContent).toContain('mint-1, mint-2')
    expect(findControl(confirmation, 'Confirm and create').disabled).toBe(false)
    expect(findControl(confirmation, 'Cancel').disabled).toBe(false)
    expect(mocks.approveProvisioning).not.toHaveBeenCalled()
    clickControl(confirmation, 'Confirm and create')
    await vi.waitFor(() => { expect(container.querySelector('[role="status"]')?.textContent).toBe(accountResult.Message); })
    expect(mocks.approveProvisioning).toHaveBeenCalledTimes(1)
    expect(mocks.approveProvisioning).toHaveBeenCalledWith('create-1')
    await vi.waitFor(() => { expect(findControl(container, 'Create token account').disabled).toBe(false); })
    expect(container.querySelector('.confirm')).toBeNull()
    unmount()
  })

  it('handles provisioning rejection and failure without leaving controls busy', async () => {
    const { wallet, mocks, container, emit } = createUiHarness(connectedUiState())
    let reject!: (error: Error) => void
    mocks.createAccount.mockImplementation(() => {
      emit({ type: 'provisioning:confirmation', id: 'create-1', tokens: ['mint'], network: 'testnet' })
      return new Promise((_resolve, fail) => { reject = fail })
    })
    mocks.rejectProvisioning.mockImplementation(() => { reject(new Error('Cancelled.')); })
    const unmount = mountWalletUI(container, wallet)
    clickControl(container, 'Create token account')
    clickControl(requireElement(container, '.confirm'), 'Cancel')
    await vi.waitFor(() => { expect(findControl(container, 'Create token account').disabled).toBe(false); })
    expect(mocks.rejectProvisioning).toHaveBeenCalledWith('create-1')
    expect(mocks.approveProvisioning).not.toHaveBeenCalled()
    clickControl(container, 'Create token account')
    mocks.approveProvisioning.mockImplementation(() => {
      const error = new Error('Provisioning failed.')
      emit({ type: 'provisioning:error', id: 'create-1', error })
      reject(error)
      return Promise.reject(error)
    })
    clickControl(requireElement(container, '.confirm'), 'Confirm and create')
    await vi.waitFor(() => { expect(container.querySelector('[role="alert"]')?.textContent).toBe('Provisioning failed.'); })
    expect(findControl(container, 'Create token account').disabled).toBe(false)
    expect(container.querySelector('.confirm')).toBeNull()
    unmount()
  })

  it('cancels only unsubmitted provisioning on unmount and discards results from a previous identity', async () => {
    const { wallet, mocks, container, emit, setState } = createUiHarness(connectedUiState('local'))
    let finish!: (result: typeof accountResult) => void
    mocks.approveProvisioning.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const unmount = mountWalletUI(container, wallet)
    for (const id of ['unsubmitted', 'submitting']) {
      emit({ type: 'provisioning:confirmation', id, tokens: ['mint'], network: 'devnet' })
    }
    clickControl(requireElement(container, '[aria-label="Token account confirmation submitting"]'), 'Confirm and create')
    setState({ ...wallet.state, localIdentityKey: 'local:new-identity' })
    expect(container.querySelector('.confirm')).toBeNull()
    emit({ type: 'provisioning:complete', id: 'submitting', result: accountResult })
    expect(container.querySelector('[role="status"]')).toBeNull()
    emit({ type: 'provisioning:confirmation', id: 'current', tokens: ['mint'], network: 'devnet' })
    unmount()
    expect(mocks.rejectProvisioning).toHaveBeenCalledTimes(1)
    expect(mocks.rejectProvisioning).toHaveBeenCalledWith('current')
    finish(accountResult)
    await Promise.resolve()
    expect(container.childElementCount).toBe(0)
  })

  it('rejects unsubmitted provisioning on unmount but leaves an already submitting request alone', async () => {
    const { wallet, mocks, container, emit } = createUiHarness(connectedUiState())
    let finish!: (result: typeof accountResult) => void
    mocks.approveProvisioning.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const unmount = mountWalletUI(container, wallet)
    for (const id of ['unsubmitted', 'submitting']) {
      emit({ type: 'provisioning:confirmation', id, tokens: ['mint'], network: 'devnet' })
    }
    clickControl(requireElement(container, '[aria-label="Token account confirmation submitting"]'), 'Confirm and create')
    unmount()
    expect(mocks.rejectProvisioning).toHaveBeenCalledTimes(1)
    expect(mocks.rejectProvisioning).toHaveBeenCalledWith('unsubmitted')
    finish(accountResult)
    await Promise.resolve()
  })
})

const accountResult = { Signature: 'account-signature', Status: 'Success', Message: 'Token accounts created.' }

function connectedUiState(custody: 'embedded' | 'local' = 'embedded'): WalletState {
  return {
    status: 'connected', address: '11111111111111111111111111111111',
    session: custody === 'embedded' ? { user: { id: 'user-1' } } : null,
    protection: 'device-local', custody, externalProviderId: null, externalChain: null,
    ...(custody === 'local' ? { localIdentityKey: 'local:identity' } : {}),
  }
}

function createUiHarness(initial?: WalletState) {
  let state: WalletState = initial ?? {
    status: 'disconnected', session: null, address: null, protection: null,
    custody: null, externalProviderId: null, externalChain: null,
  }
  let listener: ((event: WalletEvent) => void) | undefined
  const mocks = {
    get state() { return state },
    network: 'devnet',
    canStartOtp: true, canSignInWithSocial: false, canSignInWithPasskey: false,
    canUseLocalPasskey: false,
    externalWalletProviders: [] as { id: string; label: string; isAvailable: () => boolean }[],
    onEvent(handler: (event: WalletEvent) => void) {
      listener = handler
      return () => { listener = undefined }
    },
    restoreSession: vi.fn(() => Promise.resolve(state)),
    startOtp: vi.fn(() => Promise.resolve()),
    verifyOtp: vi.fn(() => Promise.resolve(state)),
    connectExternalWallet: vi.fn(() => Promise.resolve(state)),
    getBalance: vi.fn((_token?: string) => Promise.resolve({ uiAmount: 1 })),
    createLocalWallet: vi.fn(() => Promise.resolve(state)),
    openLocalWallet: vi.fn((_handle: string) => Promise.resolve(state)),
    protectWithPasskey: vi.fn(() => Promise.resolve(state)),
    lock: vi.fn(),
    unlockWithPasskey: vi.fn(() => Promise.resolve(state)),
    signOut: vi.fn(() => Promise.resolve()),
    createAccount: vi.fn((_tokens?: string[], _signal?: AbortSignal) => Promise.resolve(accountResult)),
    approveProvisioning: vi.fn(() => Promise.resolve(accountResult)),
    rejectProvisioning: vi.fn((_id: string) => {}),
  }
  const container = document.createElement('div')
  document.body.append(container)
  return {
    wallet: mocks as unknown as AltudeWallet, mocks, container,
    emit: (event: WalletEvent) => listener?.(event),
    setState: (next: WalletState) => {
      state = next
      listener?.({ type: 'state', state })
    },
  }
}

function findControl(container: ParentNode, text: string, partial = false): HTMLButtonElement {
  const control = [...container.querySelectorAll('button')].find((button) =>
    partial ? button.textContent.includes(text) : button.textContent === text)
  if (!control) throw new Error(`Expected action: ${text}`)
  return control
}

function requireElement(container: ParentNode, selector: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(selector)
  if (!element) throw new Error(`Expected element: ${selector}`)
  return element
}

function requireInput(container: ParentNode, selector: string): HTMLInputElement {
  const element = requireElement(container, selector)
  if (!(element instanceof HTMLInputElement)) throw new Error(`Expected input: ${selector}`)
  return element
}

function clickControl(container: ParentNode, text: string, partial = false): void {
  findControl(container, text, partial).click()
}

function getSelectors(rules: CSSRuleList): string[] {
  return [...rules].flatMap((rule) => {
    if ('selectorText' in rule) {
      return (rule as CSSStyleRule).selectorText.split(',').map((selector) => selector.trim())
    }
    if ('cssRules' in rule) return getSelectors((rule as CSSGroupingRule).cssRules)
    return []
  })
}

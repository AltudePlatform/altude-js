import type { WalletEvent, WalletUiOptions } from './types.js'
import type { AltudeWallet } from './wallet.js'

const styles = `
.altude-wallet-ui{font:14px/1.5 Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#0f172a}
.altude-wallet-ui *{box-sizing:border-box}
.altude-wallet-ui .overlay{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:20px;background:rgba(15,23,42,.56)}
.altude-wallet-ui .panel{width:min(100%,440px);max-height:min(90vh,760px);overflow:auto;padding:24px;background:linear-gradient(180deg,#fff 0%,#fbfcfe 100%);border:1px solid rgba(15,23,42,.08);border-radius:22px;box-shadow:0 1px 0 #fff inset,0 40px 80px -24px rgba(15,23,42,.28),0 18px 36px -18px rgba(15,23,42,.18),0 6px 14px -8px rgba(37,99,235,.12)}
.altude-wallet-ui .inline{width:100%;max-width:480px;margin:auto;padding:24px 28px 28px;background:linear-gradient(180deg,#fff 0%,#fbfcfe 100%);border:1px solid rgba(15,23,42,.08);border-radius:22px;box-shadow:0 1px 0 #fff inset,0 18px 36px -18px rgba(15,23,42,.16)}
.altude-wallet-ui .fullscreen{position:fixed;inset:0;z-index:2147483000;overflow:auto;padding:24px;background:#f8fafc}
.altude-wallet-ui .header{position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;min-height:32px;margin-bottom:22px}
.altude-wallet-ui .brand{display:inline-flex;align-items:center;gap:9px;color:#0f172a;font-size:13px;font-weight:700;letter-spacing:-.01em}
.altude-wallet-ui .brand-mark{display:grid;width:24px;height:24px;place-items:center;color:#071922}
.altude-wallet-ui .brand-mark svg{width:18px;height:18px}
.altude-wallet-ui .header-actions{display:flex;gap:8px}
.altude-wallet-ui .icon-button{display:grid;width:32px;height:32px;min-height:32px;margin:0;padding:0;place-items:center;border:0;border-radius:999px;background:#f1f5f9;color:#334155;cursor:pointer}
.altude-wallet-ui .icon-button:hover{background:#e2e8f0}
.altude-wallet-ui .icon-button svg{width:15px;height:15px}
.altude-wallet-ui .content{display:flex;flex-direction:column;gap:16px}
.altude-wallet-ui h2{margin:0;color:#0f172a;font-size:24px;line-height:1.2;font-weight:700;letter-spacing:-.025em}
.altude-wallet-ui p{margin:0;color:#64748b}
.altude-wallet-ui .headline{display:flex;flex-direction:column;gap:6px}
.altude-wallet-ui .subtitle{font-size:14px;line-height:1.55}
.altude-wallet-ui .magic{display:grid;grid-template-columns:20px minmax(0,1fr) auto;align-items:center;gap:8px;padding:7px 7px 7px 13px;background:linear-gradient(180deg,#fff,#fbfcfe);border:1px solid #cbd5e1;border-radius:14px;box-shadow:0 1px 0 #fff inset,0 1px 2px rgba(15,23,42,.04),0 8px 24px -16px rgba(15,23,42,.08)}
.altude-wallet-ui .field-icon{display:grid;place-items:center;color:#64748b}
.altude-wallet-ui .field-icon svg{width:17px;height:17px}
.altude-wallet-ui input{width:100%;min-width:0;min-height:40px;padding:8px 4px;border:0;background:transparent;color:#0f172a;font:inherit;outline:none}
.altude-wallet-ui input::placeholder{color:#94a3b8}
.altude-wallet-ui .magic:focus-within{border-color:#93c5fd;box-shadow:0 0 0 3px rgba(59,130,246,.12)}
.altude-wallet-ui button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:40px;margin:0;padding:9px 14px;border:1px solid transparent;border-radius:11px;background:#2563eb;color:#fff;font:600 13px/1.2 Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;transition:background 160ms ease,border-color 160ms ease,transform 160ms ease}
.altude-wallet-ui button:hover:not(:disabled){background:#1d4ed8}
.altude-wallet-ui button:active:not(:disabled){transform:translateY(1px)}
.altude-wallet-ui button:disabled{opacity:.5;cursor:not-allowed}
.altude-wallet-ui button.secondary{border-color:#e2e8f0;background:#fff;color:#334155}
.altude-wallet-ui button.secondary:hover:not(:disabled){border-color:#cbd5e1;background:#f8fafc}
.altude-wallet-ui .magic-cta{min-height:38px;padding:8px 12px;border-radius:9px}
.altude-wallet-ui .divider{display:flex;align-items:center;gap:12px;color:#94a3b8;font-size:11px}
.altude-wallet-ui .divider:before,.altude-wallet-ui .divider:after{height:1px;flex:1;background:#e2e8f0;content:""}
.altude-wallet-ui .method-list{display:flex;flex-wrap:wrap;gap:8px}
.altude-wallet-ui .method-list button{flex:1 1 auto}
.altude-wallet-ui .pill{min-height:38px;padding:8px 12px;border-color:#e2e8f0;background:#fff;color:#334155}
.altude-wallet-ui .pill:hover:not(:disabled){border-color:#bfdbfe;background:#fbfdff;color:#1d4ed8}
.altude-wallet-ui .otp-field{display:flex;flex-direction:column;gap:7px;color:#334155;font-size:12px;font-weight:600}
.altude-wallet-ui .otp-field input{min-height:46px;padding:10px 12px;border:1px solid #cbd5e1;border-radius:11px;background:#fff;font-size:16px;letter-spacing:.16em}
.altude-wallet-ui .otp-field input:focus{border-color:#60a5fa;box-shadow:0 0 0 3px rgba(59,130,246,.12)}
.altude-wallet-ui .actions{display:flex;flex-direction:column;gap:8px}
.altude-wallet-ui .actions button{width:100%;justify-content:flex-start}
.altude-wallet-ui .status-card{padding:14px;border:1px solid #e2e8f0;border-radius:14px;background:#fff}
.altude-wallet-ui .status-label{margin-bottom:5px;color:#64748b;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em}
.altude-wallet-ui .status{overflow-wrap:anywhere;color:#0f172a;font-size:13px;font-weight:550}
.altude-wallet-ui .note{padding:11px 12px;border:1px solid #dbeafe;border-radius:10px;background:#eff6ff;color:#1e40af;font-size:12px}
.altude-wallet-ui .error{padding:11px 12px;border:1px solid #fecaca;border-radius:10px;background:#fef2f2;color:#b91c1c;font-size:12px}
.altude-wallet-ui .confirm{display:flex;flex-direction:column;gap:10px;margin-top:4px;padding:14px;border:1px solid #dbeafe;border-radius:14px;background:#eff6ff}
.altude-wallet-ui .confirm p{color:#1e3a8a}
.altude-wallet-ui .footer{display:flex;justify-content:center;margin-top:18px;padding-top:14px;border-top:1px solid #f1f5f9}
.altude-wallet-ui .footer span{color:#94a3b8;font-size:11px}
.altude-wallet-ui button:focus-visible,.altude-wallet-ui input:focus-visible{outline:3px solid #60a5fa;outline-offset:2px}
@media(max-width:480px){.altude-wallet-ui .panel{padding:20px;border-radius:18px}.altude-wallet-ui .inline{padding:20px}.altude-wallet-ui .magic{grid-template-columns:18px minmax(0,1fr);}.altude-wallet-ui .magic-cta{grid-column:1/-1;width:100%}}
@media(prefers-reduced-motion:reduce){.altude-wallet-ui *{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
`

export function mountWalletUI(
  container: HTMLElement,
  wallet: AltudeWallet,
  options: WalletUiOptions = {},
): () => void {
  const root = document.createElement('div')
  root.className = 'altude-wallet-ui'
  container.append(root)
  const previousFocus = document.activeElement
  const presentation = options.presentation ?? 'modal'
  const shell = document.createElement('div')
  shell.className = presentation === 'modal' ? 'overlay' : presentation
  if (presentation === 'modal') {
    shell.setAttribute('role', 'presentation')
    shell.addEventListener('click', (event) => {
      if (event.target === shell) options.onClose?.()
    })
  }
  const panel = document.createElement('section')
  panel.className = presentation === 'inline' ? 'inline' : 'panel'
  panel.setAttribute('role', presentation === 'modal' ? 'dialog' : 'region')
  if (presentation === 'modal') panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', options.title ?? 'Altude wallet')
  if (presentation === 'modal') {
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        options.onClose?.()
      } else if (event.key === 'Tab') {
        const focusable = [
          ...panel.querySelectorAll<HTMLElement>('button:not(:disabled),input,select'),
        ]
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }
    })
  }
  shell.append(panel)
  const style = document.createElement('style')
  style.textContent = styles
  root.replaceChildren(style, shell)

  let otpChannel: 'email' | 'sms' = 'email'
  let otpIdentifier = ''
  let otpCode = ''
  let otpStarted = false
  let busy = false
  let message = ''
  let errorMessage = ''
  type ConfirmationEvent = Extract<WalletEvent, { type: 'transaction:confirmation' }>
  const pending = new Map<
    string,
    { event: ConfirmationEvent; userId: string | null; address: string | null }
  >()
  const submitting = new Set<string>()
  const events = wallet.onEvent((event) => {
    if (event.type === 'transaction:confirmation') {
      pending.set(event.id, {
        event,
        userId: wallet.state.session?.user.id ?? null,
        address: wallet.state.address,
      })
    }
    if (event.type === 'transaction:complete') {
      pending.delete(event.id)
      message = `Transaction submitted: ${event.result.signature}`
    }
    if (event.type === 'transaction:error') {
      pending.delete(event.id)
      errorMessage = event.error.message
    }
    if (event.type === 'state') {
      if (event.state.status === 'disconnected') {
        pending.clear()
      } else if (event.state.status === 'connected') {
        for (const [id, request] of pending) {
          if (
            request.userId !== event.state.session?.user.id ||
            request.address !== event.state.address
          ) {
            pending.delete(id)
          }
        }
      }
    }
    render()
  })

  const render = () => {
    panel.replaceChildren()
    const header = document.createElement('header')
    header.className = 'header'
    const brand = document.createElement('div')
    brand.className = 'brand'
    const mark = document.createElement('span')
    mark.className = 'brand-mark'
    mark.setAttribute('aria-hidden', 'true')
    mark.innerHTML =
      '<svg viewBox="0 0 18 18" fill="currentColor"><rect width="8.7" height="8.7"/><rect x="8.7" y="8.7" width="8.7" height="8.7"/></svg>'
    const brandName = document.createElement('span')
    brandName.textContent = 'Altude'
    brand.append(mark, brandName)
    header.append(brand)
    const headerActions = document.createElement('div')
    headerActions.className = 'header-actions'
    if (otpStarted) {
      headerActions.append(
        iconButton('Back to sign-in', 'back', () => {
          otpStarted = false
          otpCode = ''
          message = ''
          render()
        }),
      )
    }
    if (options.onClose) headerActions.append(iconButton('Close wallet', 'close', options.onClose))
    if (headerActions.childElementCount > 0) header.append(headerActions)
    panel.append(header)

    const content = document.createElement('div')
    content.className = 'content'
    panel.append(content)
    const state = wallet.state

    if (state.status === 'disconnected') {
      const headline = document.createElement('div')
      headline.className = 'headline'
      const title = document.createElement('h2')
      title.textContent = otpStarted
        ? `Check your ${otpChannel === 'email' ? 'email' : 'phone'}`
        : `Sign in to ${options.title ?? 'your wallet'}`
      const intro = document.createElement('p')
      intro.className = 'subtitle'
      const socialProviders =
        wallet.canSignInWithSocial && options.socialProviders ? options.socialProviders : []
      const signInOptions = [
        ...(wallet.canStartOtp ? ['email or text message'] : []),
        ...(socialProviders.length > 0 ? ['a social account'] : []),
        ...(wallet.canSignInWithPasskey ? ['a passkey'] : []),
        ...(wallet.externalWalletProviders.length > 0 ? ['an external wallet'] : []),
      ]
      intro.textContent = otpStarted
        ? `Enter the one-time code sent to ${otpIdentifier}.`
        : signInOptions.length > 0
          ? `Continue with ${joinWithOr(signInOptions)}.`
          : 'No sign-in methods are configured for this wallet.'
      headline.append(title, intro)
      content.append(headline)

      const hasAlternatives =
        socialProviders.length > 0 ||
        wallet.canSignInWithPasskey ||
        wallet.externalWalletProviders.length > 0
      if (!otpStarted && wallet.canStartOtp) {
        const form = document.createElement('form')
        form.className = 'magic'
        form.addEventListener('submit', (event) => {
          event.preventDefault()
          const identity = form.querySelector<HTMLInputElement>('input')
          if (!identity) return
          otpIdentifier = identity.value
          void run(async () => {
            await wallet.startOtp(otpChannel, otpIdentifier)
            otpStarted = true
            message = `Check your ${otpChannel === 'email' ? 'inbox' : 'phone'} for the verification code.`
          })
        })
        const fieldIcon = document.createElement('span')
        fieldIcon.className = 'field-icon'
        fieldIcon.setAttribute('aria-hidden', 'true')
        fieldIcon.innerHTML = iconSvg(otpChannel === 'email' ? 'email' : 'phone')
        const identity = document.createElement('input')
        identity.type = otpChannel === 'email' ? 'email' : 'tel'
        identity.autocomplete = otpChannel === 'email' ? 'email' : 'tel'
        identity.required = true
        identity.placeholder = otpChannel === 'email' ? 'you@company.com' : '+1 202 555 0123'
        identity.setAttribute(
          'aria-label',
          otpChannel === 'email' ? 'Email address' : 'Phone number including country code',
        )
        identity.value = otpIdentifier
        const submit = document.createElement('button')
        submit.className = 'magic-cta'
        submit.type = 'submit'
        submit.textContent = 'Continue'
        const isIdentityValid = () =>
          otpChannel === 'email'
            ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.value.trim())
            : /^\+?[\d\s().-]{7,}$/.test(identity.value.trim())
        submit.disabled = !isIdentityValid()
        identity.addEventListener('input', () => {
          otpIdentifier = identity.value
          submit.disabled = !isIdentityValid()
        })
        form.append(fieldIcon, identity, submit)
        content.append(form)
      }

      if (!otpStarted && wallet.canStartOtp) {
        const divider = document.createElement('div')
        divider.className = 'divider'
        divider.textContent = 'or continue with'
        content.append(divider)
      }
      if (!otpStarted && (wallet.canStartOtp || hasAlternatives)) {
        const methods = document.createElement('div')
        methods.className = 'method-list'
        if (wallet.canStartOtp) {
          methods.append(
            button(
              otpChannel === 'email' ? 'Text message' : 'Email',
              () => {
                otpChannel = otpChannel === 'email' ? 'sms' : 'email'
                otpIdentifier = ''
                errorMessage = ''
                message = ''
                render()
              },
              true,
            ),
          )
        }
        for (const provider of socialProviders) {
          methods.append(
            button(
              `Continue with ${provider}`,
              () => run(() => wallet.signInWithSocial(provider)),
              true,
            ),
          )
        }
        if (wallet.canSignInWithPasskey) {
          methods.append(button('Passkey', () => run(() => wallet.signInWithPasskey()), true))
        }
        for (const provider of wallet.externalWalletProviders) {
          methods.append(
            button(
              `Connect ${provider.label}`,
              () => run(() => wallet.connectExternalWallet(provider.id)),
              true,
            ),
          )
        }
        content.append(methods)
      }
      if (otpStarted) {
        const code = input('One-time code', 'text')
        code.value = otpCode
        code.className = 'otp-input'
        code.addEventListener('input', () => {
          otpCode = code.value
        })
        code.autocomplete = 'one-time-code'
        const codeLabel = code.parentElement
        codeLabel?.classList.add('otp-field')
        content.append(
          codeLabel ?? code,
          button('Verify and continue', () =>
            run(async () => {
              await wallet.verifyOtp(otpChannel, otpIdentifier, code.value)
              otpStarted = false
              otpCode = ''
            }),
          ),
        )
        content.append(
          button(
            'Use a different method',
            () => {
              otpStarted = false
              otpCode = ''
              otpIdentifier = ''
              otpChannel = otpChannel === 'email' ? 'sms' : 'email'
              message = ''
              render()
            },
            true,
          ),
        )
      }
    } else {
      const status = document.createElement('p')
      status.className = 'status'
      const address = state.address ?? 'Unavailable'
      if (state.custody === 'external') {
        const provider = wallet.externalWalletProviders.find(
          (candidate) => candidate.id === state.externalProviderId,
        )
        const chain = state.externalChain === 'evm' ? 'EVM' : 'Solana'
        status.textContent = `Connected with ${provider?.label ?? 'external wallet'} · ${chain} · ${address}`
      } else {
        status.textContent =
          state.status === 'locked' ? `Wallet locked · ${address}` : `Connected · ${address}`
      }
      const statusCard = document.createElement('div')
      statusCard.className = 'status-card'
      const statusLabel = document.createElement('p')
      statusLabel.className = 'status-label'
      statusLabel.textContent = state.status === 'locked' ? 'Wallet status' : 'Your wallet'
      statusCard.append(statusLabel, status)
      content.append(statusCard)
      if (state.status === 'locked') {
        const unlock =
          state.protection === 'passkey'
            ? () => run(() => wallet.unlockWithPasskey())
            : () => run(() => wallet.unlock())
        content.append(
          button(state.protection === 'passkey' ? 'Unlock with passkey' : 'Unlock wallet', unlock),
        )
      } else {
        const actions = document.createElement('div')
        actions.className = 'actions'
        if (state.custody !== 'external' || state.externalChain === 'solana') {
          actions.append(
            button(
              'Check balance',
              () =>
                run(async () => {
                  const balance = await wallet.getBalance()
                  message = `Balance: ${String(balance.uiAmount ?? 'unavailable')} SOL`
                }),
              true,
            ),
          )
        }
        if (state.custody === 'embedded') {
          if (state.protection === 'device-local') {
            actions.append(
              button('Protect with passkey', () => run(() => wallet.protectWithPasskey()), true),
            )
          }
          actions.append(
            button(
              'Create token account',
              () =>
                run(async () => {
                  const result = await wallet.createAccount()
                  message =
                    result.Message ||
                    (result.Signature
                      ? `Account created: ${result.Signature}`
                      : 'Account is ready.')
                }),
              true,
            ),
          )
        }
        if (state.custody === 'external' && state.externalChain === 'evm') {
          const unavailable = document.createElement('p')
          unavailable.className = 'note'
          unavailable.textContent = 'Solana balance and transaction actions are unavailable.'
          content.append(unavailable)
        }
        if (actions.childElementCount > 0) content.append(actions)
      }
      content.append(
        button(
          state.custody === 'external' ? 'Disconnect wallet' : 'Sign out',
          () => run(() => wallet.signOut()),
          true,
        ),
      )
    }

    if (state.status === 'connected') {
      for (const { event: transaction } of pending.values()) {
        const confirmation = document.createElement('div')
        confirmation.className = 'confirm'
        confirmation.setAttribute('role', 'group')
        confirmation.setAttribute('aria-label', `Transaction confirmation ${transaction.id}`)
        const summary = document.createElement('p')
        const amount = transaction.intent.amount.toLocaleString()
        summary.textContent =
          transaction.intent.kind === 'sol-transfer'
            ? `Confirm transfer of ${amount} lamports to ${transaction.intent.recipient}?`
            : `Confirm transfer of ${amount} base units of ${transaction.intent.mint} to ${transaction.intent.recipient}?`
        confirmation.append(
          summary,
          button(
            'Confirm and submit',
            () => submitTransaction(transaction.id),
            false,
            submitting.has(transaction.id),
          ),
          button(
            'Cancel',
            () => {
              if (!pending.has(transaction.id)) return
              wallet.rejectTransaction(transaction.id)
              pending.delete(transaction.id)
              render()
            },
            true,
          ),
        )
        content.append(confirmation)
      }
    }

    if (message) {
      const note = document.createElement('p')
      note.className = 'note'
      note.setAttribute('role', 'status')
      note.textContent = message
      content.append(note)
    }
    if (errorMessage) {
      const error = document.createElement('p')
      error.className = 'error'
      error.setAttribute('role', 'alert')
      error.textContent = errorMessage
      content.append(error)
    }
    const footer = document.createElement('footer')
    footer.className = 'footer'
    const footerText = document.createElement('span')
    footerText.textContent = 'Secure wallet access by Altude'
    footer.append(footerText)
    panel.append(footer)
    const firstButton = panel.querySelector<HTMLButtonElement>('button')
    if (firstButton) firstButton.focus()
  }

  async function run(operation: () => Promise<unknown>): Promise<void> {
    if (busy) return
    busy = true
    errorMessage = ''
    message = ''
    render()
    try {
      await operation()
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    } finally {
      busy = false
      render()
    }
  }

  async function submitTransaction(id: string): Promise<void> {
    if (!pending.has(id) || submitting.has(id)) return
    submitting.add(id)
    errorMessage = ''
    message = ''
    render()
    try {
      await wallet.approveTransaction(id)
    } catch (error) {
      if (pending.delete(id)) {
        errorMessage = error instanceof Error ? error.message : String(error)
      }
    } finally {
      submitting.delete(id)
      render()
    }
  }

  render()
  let mounted = true
  void wallet.restoreSession().catch((error: unknown) => {
    if (!mounted) return
    errorMessage = error instanceof Error ? error.message : String(error)
    render()
  })
  return () => {
    mounted = false
    events()
    root.remove()
    if (previousFocus instanceof HTMLElement) previousFocus.focus()
  }
}

function input(labelText: string, type: string): HTMLInputElement {
  const wrapper = document.createElement('label')
  wrapper.textContent = labelText
  wrapper.className = 'otp-field'
  const field = document.createElement('input')
  field.type = type
  field.autocomplete = type === 'email' ? 'email' : type === 'tel' ? 'tel' : 'one-time-code'
  wrapper.append(field)
  return field
}

function joinWithOr(values: readonly string[]): string {
  if (values.length < 2) return values[0] ?? 'an available option'
  return `${values.slice(0, -1).join(', ')}, or ${values.at(-1) ?? ''}`
}

function iconButton(
  label: string,
  icon: 'back' | 'close',
  action: () => unknown,
): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = 'icon-button'
  element.setAttribute('aria-label', label)
  element.innerHTML = iconSvg(icon)
  element.addEventListener('click', () => void action())
  return element
}

function iconSvg(icon: 'back' | 'close' | 'email' | 'phone'): string {
  const paths = {
    back: '<path d="m15 18-6-6 6-6"/><path d="M9 12h12"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    email: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
  }
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[icon]}</svg>`
}

function button(
  text: string,
  action: () => unknown,
  secondary = false,
  disabled = false,
): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.textContent = text
  element.disabled = disabled
  if (secondary) element.className = 'secondary'
  element.addEventListener('click', () => void action())
  return element
}

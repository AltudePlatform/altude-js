import type { WalletEvent, WalletUiOptions } from './types.js'
import type { AltudeWallet } from './wallet.js'

const styles = `
:host{font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#071922}
.overlay{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:20px;background:#07192299}
.panel{box-sizing:border-box;width:min(100%,420px);max-height:min(88vh,760px);overflow:auto;padding:28px;background:#fff;border:1px solid #d6e1e6;border-radius:18px;box-shadow:0 24px 80px #07192240}
.inline{width:100%;max-width:480px;margin:auto;padding:24px;background:#fff;border:1px solid #d6e1e6;border-radius:16px}
.fullscreen{position:fixed;inset:0;z-index:2147483000;overflow:auto;padding:24px;background:#f7fafb}
h2{margin:0 0 16px;font-size:22px;line-height:1.25}
p{margin:12px 0;color:#39515c}
label{display:block;margin:14px 0 5px;font-weight:600}
input{box-sizing:border-box;width:100%;min-height:44px;padding:10px 12px;border:1px solid #aabac2;border-radius:8px;font:inherit}
button{min-height:42px;margin:6px 6px 0 0;padding:9px 14px;border:0;border-radius:8px;background:#071922;color:white;font:600 14px/1.2 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}
button.secondary{border:1px solid #c5d2d8;background:white;color:#071922}
button:focus-visible,input:focus-visible{outline:3px solid #048abf;outline-offset:2px}
.error{color:#a6262d}
.status{word-break:break-word}
.confirm{margin-top:20px;padding:16px;background:#eff7fb;border-radius:10px}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
`

export function mountWalletUI(
  container: HTMLElement,
  wallet: AltudeWallet,
  options: WalletUiOptions = {},
): () => void {
  const root = document.createElement('div')
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
  let otpStarted = false
  let busy = false
  let message = ''
  let errorMessage = ''
  let pending: Extract<WalletEvent, { type: 'transaction:confirmation' }> | null = null
  const events = wallet.onEvent((event) => {
    if (event.type === 'transaction:confirmation') pending = event
    if (event.type === 'transaction:complete') {
      pending = null
      message = `Transaction submitted: ${event.result.signature}`
    }
    if (event.type === 'transaction:error') {
      pending = null
      errorMessage = event.error.message
    }
    render()
  })

  const render = () => {
    panel.replaceChildren()
    const title = document.createElement('h2')
    title.textContent = options.title ?? 'Your wallet'
    panel.append(title)
    const state = wallet.state

    if (state.status === 'disconnected') {
      const intro = document.createElement('p')
      intro.textContent = 'Sign in to access your locally held Solana wallet.'
      panel.append(intro)
      if (!otpStarted && wallet.canStartOtp) {
        const channelLabel = document.createElement('label')
        channelLabel.textContent = 'Sign-in method'
        const channel = document.createElement('select')
        channel.setAttribute('aria-label', 'Sign-in method')
        for (const [value, label] of [
          ['email', 'Email'],
          ['sms', 'Text message'],
        ] as const) {
          const option = document.createElement('option')
          option.value = value
          option.textContent = label
          channel.append(option)
        }
        channel.value = otpChannel
        channel.addEventListener('change', () => {
          otpChannel = channel.value as 'email' | 'sms'
          render()
        })
        const identity = input(
          otpChannel === 'email' ? 'Email address' : 'Phone number',
          otpChannel === 'email' ? 'email' : 'tel',
        )
        const send = button('Send one-time code', () =>
          run(async () => {
            otpIdentifier = identity.value
            await wallet.startOtp(otpChannel, identity.value)
            otpStarted = true
            message = 'Check your inbox or phone for the verification code.'
            render()
          }),
        )
        channelLabel.append(channel)
        panel.append(channelLabel, identity.parentElement ?? identity, send)
      }
      if (!otpStarted && wallet.canSignInWithSocial) {
        for (const provider of options.socialProviders ?? []) {
          panel.append(
            button(`Continue with ${provider}`, () => run(() => wallet.signInWithSocial(provider))),
          )
        }
      }
      if (!otpStarted && wallet.canSignInWithPasskey) {
        panel.append(
          button('Continue with passkey', () => run(() => wallet.signInWithPasskey()), true),
        )
      }
      if (otpStarted) {
        const code = input('One-time code', 'text')
        code.autocomplete = 'one-time-code'
        panel.append(
          code.parentElement ?? code,
          button('Verify and continue', () =>
            run(async () => {
              await wallet.verifyOtp(otpChannel, otpIdentifier, code.value)
              otpStarted = false
            }),
          ),
        )
        panel.append(
          button(
            'Use a different method',
            () => {
              otpStarted = false
              message = ''
              render()
            },
            true,
          ),
        )
      }
      if (!wallet.canStartOtp && !wallet.canSignInWithSocial && !wallet.canSignInWithPasskey) {
        const unavailable = document.createElement('p')
        unavailable.textContent = 'No sign-in methods are configured for this wallet.'
        panel.append(unavailable)
      }
    } else {
      const status = document.createElement('p')
      status.className = 'status'
      const address = state.address ?? 'Unavailable'
      status.textContent =
        state.status === 'locked' ? `Wallet locked · ${address}` : `Connected · ${address}`
      panel.append(status)
      if (state.status === 'locked') {
        const unlock =
          state.protection === 'passkey'
            ? () => run(() => wallet.unlockWithPasskey())
            : () => run(() => wallet.unlock())
        panel.append(
          button(state.protection === 'passkey' ? 'Unlock with passkey' : 'Unlock wallet', unlock),
        )
      } else {
        panel.append(
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
        if (state.protection === 'device-local') {
          panel.append(
            button('Protect with passkey', () => run(() => wallet.protectWithPasskey()), true),
          )
        }
        panel.append(
          button(
            'Create token account',
            () =>
              run(async () => {
                const result = await wallet.createAccount()
                message =
                  result.Message ||
                  (result.Signature ? `Account created: ${result.Signature}` : 'Account is ready.')
              }),
            true,
          ),
        )
      }
      panel.append(button('Sign out', () => run(() => wallet.signOut()), true))
    }

    if (pending && state.status === 'connected') {
      const confirmation = document.createElement('div')
      confirmation.className = 'confirm'
      const summary = document.createElement('p')
      const transaction = pending
      const amount = transaction.intent.amount.toLocaleString()
      summary.textContent =
        transaction.intent.kind === 'sol-transfer'
          ? `Confirm transfer of ${amount} lamports to ${transaction.intent.recipient}?`
          : `Confirm transfer of ${amount} base units of ${transaction.intent.mint} to ${transaction.intent.recipient}?`
      confirmation.append(
        summary,
        button('Confirm and submit', () => run(() => wallet.approveTransaction(transaction.id))),
        button(
          'Cancel',
          () => {
            wallet.rejectTransaction(transaction.id)
            pending = null
            render()
          },
          true,
        ),
      )
      panel.append(confirmation)
    }

    if (message) {
      const note = document.createElement('p')
      note.setAttribute('role', 'status')
      note.textContent = message
      panel.append(note)
    }
    if (errorMessage) {
      const error = document.createElement('p')
      error.className = 'error'
      error.setAttribute('role', 'alert')
      error.textContent = errorMessage
      panel.append(error)
    }
    if (options.onClose) panel.append(button('Close', options.onClose, true))
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
  const field = document.createElement('input')
  field.type = type
  field.autocomplete = type === 'email' ? 'email' : type === 'tel' ? 'tel' : 'one-time-code'
  wrapper.append(field)
  return field
}

function button(text: string, action: () => unknown, secondary = false): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.textContent = text
  if (secondary) element.className = 'secondary'
  element.addEventListener('click', () => void action())
  return element
}

import type { WalletEvent, WalletUiOptions } from './types.js'
import type { AltudeWallet } from './wallet.js'

let walletUiInstance = 0

const styles = `
.altude-wallet-ui{font:14px/1.5 Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#0f172a}
.altude-wallet-ui *{box-sizing:border-box}
.altude-wallet-ui .overlay{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:20px;background-color:rgba(244,247,250,.94);background-image:repeating-radial-gradient(ellipse at 50% 0%,transparent 0 15px,rgba(148,163,184,.09) 16px,transparent 17px 29px)}
.altude-wallet-ui .panel{width:min(100%,520px);max-height:min(92vh,820px);overflow:auto;padding:30px 34px 24px;background:linear-gradient(180deg,#fff 0%,#fcfdff 100%);border:1px solid #e5eaf0;border-radius:25px;box-shadow:0 1px 0 #fff inset,0 30px 70px -28px rgba(15,23,42,.24),0 8px 24px -14px rgba(15,23,42,.14)}
.altude-wallet-ui .inline{width:100%;max-width:520px;margin:auto;padding:28px 32px 24px;background:linear-gradient(180deg,#fff 0%,#fcfdff 100%);border:1px solid #e5eaf0;border-radius:25px;box-shadow:0 1px 0 #fff inset,0 18px 36px -18px rgba(15,23,42,.16)}
.altude-wallet-ui .fullscreen{position:fixed;inset:0;z-index:2147483000;overflow:auto;padding:24px;background:#f8fafc}
.altude-wallet-ui .header{position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;min-height:32px;margin-bottom:25px}
.altude-wallet-ui .brand{display:inline-flex;align-items:center;gap:9px;color:#071922;font-size:16px;font-weight:700;letter-spacing:-.02em}
.altude-wallet-ui .brand-mark{display:grid;width:25px;height:25px;place-items:center;border:1.6px solid #071922;border-radius:7px;color:#071922;font-size:16px;font-weight:750;line-height:1}
.altude-wallet-ui .brand-mark img{display:block;width:100%;height:100%;object-fit:contain}
.altude-wallet-ui .header-actions{display:flex;gap:8px}
.altude-wallet-ui .icon-button{display:grid;width:32px;height:32px;min-height:32px;margin:0;padding:0;place-items:center;border:0;border-radius:999px;background:#f1f5f9;color:#334155;cursor:pointer}
.altude-wallet-ui .icon-button:hover{background:#e2e8f0}
.altude-wallet-ui .icon-button svg{width:15px;height:15px}
.altude-wallet-ui .content{display:flex;flex-direction:column;gap:17px}
.altude-wallet-ui h2{margin:0;color:#172337;font-size:28px;line-height:1.2;font-weight:700;letter-spacing:-.035em}
.altude-wallet-ui p{margin:0;color:#64748b}
.altude-wallet-ui .headline{display:flex;flex-direction:column;gap:6px}
.altude-wallet-ui .subtitle{font-size:15px;line-height:1.55}
.altude-wallet-ui .magic{display:grid;grid-template-columns:22px minmax(0,1fr) auto;align-items:center;gap:8px;padding:7px 7px 7px 15px;background:linear-gradient(180deg,#fff,#fcfdff);border:1px solid #d9e1ea;border-radius:15px;box-shadow:0 1px 2px rgba(15,23,42,.04),0 8px 24px -16px rgba(15,23,42,.08)}
.altude-wallet-ui .field-icon{display:grid;place-items:center;color:#91a2b8}
.altude-wallet-ui .field-icon svg{width:17px;height:17px}
.altude-wallet-ui input{width:100%;min-width:0;min-height:40px;padding:8px 4px;border:0;background:transparent;color:#0f172a;font:inherit;outline:none}
.altude-wallet-ui input::placeholder{color:#94a3b8}
.altude-wallet-ui .magic:focus-within{border-color:#3dbff2;box-shadow:0 0 0 3px rgba(61,191,242,.12)}
.altude-wallet-ui button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:42px;margin:0;padding:9px 14px;border:1px solid transparent;border-radius:11px;background:#071922;color:#fff;font:600 13px/1.2 Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;transition:background 160ms ease,border-color 160ms ease,transform 160ms ease}
.altude-wallet-ui button:hover:not(:disabled){background:#084360}
.altude-wallet-ui button:active:not(:disabled){transform:translateY(1px)}
.altude-wallet-ui button:disabled{background:#9ca3af;color:#fff;cursor:not-allowed}
.altude-wallet-ui button.secondary{border-color:#dfe6ee;background:#fff;color:#243248}
.altude-wallet-ui button.secondary:hover:not(:disabled){border-color:#b8c7d6;background:#f9fbfd}
.altude-wallet-ui .magic-cta{min-height:40px;padding:8px 15px;border-radius:10px}
.altude-wallet-ui .channel-switch-button{align-self:flex-start;min-height:28px;padding:4px 0;border:0;background:transparent;color:#688096;font-size:12px;font-weight:550}
.altude-wallet-ui .channel-switch-button:hover:not(:disabled){background:transparent;color:#084360;text-decoration:underline}
.altude-wallet-ui .divider{display:flex;align-items:center;gap:12px;color:#92a2b8;font-size:11px;font-weight:650;letter-spacing:.08em;text-transform:uppercase}
.altude-wallet-ui .divider:before,.altude-wallet-ui .divider:after{height:1px;flex:1;background:#e7ecf2;content:""}
.altude-wallet-ui .method-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}
.altude-wallet-ui .method-list button{min-height:54px;border-color:#e0e7ef;background:linear-gradient(180deg,#fff,#fcfdff);color:#172337}
.altude-wallet-ui .method-list button:hover:not(:disabled){border-color:#b8deea;background:#f8fdff}
.altude-wallet-ui .provider-method{justify-content:flex-start}
.altude-wallet-ui .provider-glyph{display:grid;width:24px;height:24px;flex:0 0 auto;place-items:center;border-radius:7px;background:#f0f4f8;color:#34465a;font-size:13px;font-weight:700}
.altude-wallet-ui .passkey-action{grid-column:1/-1;width:100%;min-height:54px;border-color:#e0e7ef;background:#fff;color:#172337}
.altude-wallet-ui .passkey-glyph{background:transparent}
.altude-wallet-ui .or-divider{display:flex;align-items:center;gap:10px;color:#94a3b8;font-size:11px}
.altude-wallet-ui .or-divider:before,.altude-wallet-ui .or-divider:after{height:1px;flex:1;background:#e7ecf2;content:""}
.altude-wallet-ui .or-divider span{padding:4px 10px;border:1px solid #e2e8f0;border-radius:999px;background:#fbfcfe}
.altude-wallet-ui .wallet-group{overflow:hidden;border:1px solid #e0e7ef;border-radius:15px;background:linear-gradient(180deg,#fff,#fcfdff);box-shadow:0 2px 5px rgba(15,23,42,.035)}
.altude-wallet-ui .wallet-group-toggle{display:flex;width:100%;min-height:80px;align-items:center;justify-content:space-between;padding:13px 15px;border:0;border-radius:0;background:transparent;color:#172337;text-align:left}
.altude-wallet-ui .wallet-group-toggle:hover:not(:disabled){background:#f8fbfd}
.altude-wallet-ui .wallet-group-copy{display:grid;flex:1;gap:3px;text-align:left}
.altude-wallet-ui .wallet-group-icon{display:grid;width:44px;height:44px;flex:0 0 auto;place-items:center;margin-right:13px;border:1px solid #d7effb;border-radius:12px;background:#f1fbff;color:#048abf}
.altude-wallet-ui .wallet-group-icon svg{width:22px;height:22px}
.altude-wallet-ui .wallet-group-title{font-size:15px;font-weight:650}
.altude-wallet-ui .wallet-group-detail{max-width:340px;color:#64748b;font-size:12px;font-weight:400;line-height:1.4}
.altude-wallet-ui .wallet-group-chevron{display:grid;width:30px;height:30px;flex:0 0 auto;place-items:center;border-radius:9px;background:#f0f4f8;color:#64748b}
.altude-wallet-ui .wallet-group-chevron svg{width:16px;height:16px;transition:transform 160ms ease}
.altude-wallet-ui .wallet-group-toggle[aria-expanded="true"] .wallet-group-chevron svg{transform:rotate(180deg)}
.altude-wallet-ui .wallet-provider-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:0 12px 13px}
.altude-wallet-ui .wallet-provider-list[hidden]{display:none}
.altude-wallet-ui .wallet-provider-card{min-height:112px;flex-direction:column;gap:5px;padding:10px 6px 9px;border-color:#e0e7ef;border-radius:14px;background:#fff;color:#243248}
.altude-wallet-ui .wallet-provider-card:hover:not(:disabled){border-color:#b8deea;background:#f8fdff}
.altude-wallet-ui .wallet-provider-icon{display:grid;width:40px;height:40px;place-items:center;border:1px solid #edf1f6;border-radius:12px;background:#f7f9fc;color:#34465a;font-size:14px;font-weight:750}
.altude-wallet-ui .wallet-provider-icon[data-provider="metamask"]{color:#b45c22}
.altude-wallet-ui .wallet-provider-icon[data-provider="phantom"]{color:#7860d9}
.altude-wallet-ui .wallet-provider-icon[data-provider="walletconnect"]{color:#2786f7}
.altude-wallet-ui .wallet-provider-name{font-size:12px;font-weight:650}
.altude-wallet-ui .wallet-provider-status{color:#00a876;font-size:9px;font-weight:750;letter-spacing:.06em}
.altude-wallet-ui .wallet-provider-status[data-available="false"]{color:#8b95a5}
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
.altude-wallet-ui .login-state{display:flex;min-height:330px;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:18px 0 26px;text-align:center}
.altude-wallet-ui .login-state h2{font-size:26px}
.altude-wallet-ui .login-state-copy{max-width:420px;color:#64748b;font-size:14px;line-height:1.6;overflow-wrap:anywhere}
.altude-wallet-ui .login-state-icon{display:grid;width:90px;height:90px;place-items:center;border:1px solid #e7eefb;border-radius:50%;background:#fff}
.altude-wallet-ui .login-state-icon svg{width:37px;height:37px}
.altude-wallet-ui .login-error .login-state-icon{border-color:#fecaca;background:#fff5f5;color:#dc2626}
.altude-wallet-ui .login-retry{min-width:150px;min-height:48px;border-radius:12px;background:#3b82f6;font-size:15px}
.altude-wallet-ui .login-retry:hover:not(:disabled){background:#2563eb}
.altude-wallet-ui .setup-orb{position:relative;width:90px;height:90px;border:1px solid #e7eefb;border-radius:50%;background:radial-gradient(circle,#edf4ff 0 38%,#fff 39%)}
.altude-wallet-ui .setup-orb:before{position:absolute;inset:34px;border:1px solid #8bb8fb;border-radius:50%;background:radial-gradient(circle at 35% 30%,#7bb5ff,#2874e8 70%);box-shadow:0 2px 8px #377fe855;content:""}
.altude-wallet-ui .setup-copy{margin-top:-4px}
.altude-wallet-ui .setup-copy p{font-size:14px}
.altude-wallet-ui .setup-steps{display:grid;width:100%;gap:11px;padding:14px 16px;border:1px solid #dce5f1;border-radius:16px;background:linear-gradient(180deg,#fff,#f7faff);text-align:left}
.altude-wallet-ui .setup-step{display:flex;align-items:center;gap:11px;color:#64748b;font-size:14px}
.altude-wallet-ui .setup-step-indicator{display:grid;width:25px;height:25px;flex:0 0 auto;place-items:center;border-radius:50%;background:#eef2f7;color:#64748b}
.altude-wallet-ui .setup-step[data-state="active"]{color:#172337;font-weight:650}
.altude-wallet-ui .setup-step[data-state="active"] .setup-step-indicator{background:#eaf1ff;color:#3479e8}
.altude-wallet-ui .setup-step[data-state="complete"] .setup-step-indicator{background:#e5f7ef;color:#00a876}
.altude-wallet-ui .setup-step-spinner{width:15px;height:15px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:altude-wallet-spin .8s linear infinite}
@keyframes altude-wallet-spin{to{transform:rotate(360deg)}}
.altude-wallet-ui .account-identity{display:flex;align-items:center;gap:13px}
.altude-wallet-ui .account-avatar{display:grid;width:54px;height:54px;flex:0 0 auto;place-items:center;border:3px solid #dceaff;border-radius:50%;background:linear-gradient(145deg,#74a8ff,#2452b8);box-shadow:0 5px 14px #377fe833;color:#fff;font-size:20px;font-weight:700}
.altude-wallet-ui .account-contact{display:grid;min-width:0;gap:6px}
.altude-wallet-ui .account-contact strong{overflow-wrap:anywhere;color:#172337;font-size:16px;font-weight:650}
.altude-wallet-ui .account-protection{display:inline-flex;align-items:center;gap:6px;justify-self:start;padding:4px 9px;border-radius:999px;background:#edf4ff;color:#2e66c2;font-size:11px;font-weight:600}
.altude-wallet-ui .account-protection svg{width:14px;height:14px}
.altude-wallet-ui .account-card{display:grid;gap:0;padding:15px 18px;border:1px solid #dce5f1;border-radius:17px;background:linear-gradient(180deg,#fff,#f7faff);box-shadow:0 2px 5px rgba(15,23,42,.035)}
.altude-wallet-ui .account-row{display:flex;min-height:47px;align-items:center;justify-content:space-between;gap:14px;border-bottom:1px solid #e8edf4;color:#64748b;font-size:13px}
.altude-wallet-ui .account-row:last-child{border-bottom:0}
.altude-wallet-ui .account-row-label{flex:0 0 auto}
.altude-wallet-ui .account-row-value{display:inline-flex;min-width:0;align-items:center;justify-content:flex-end;gap:7px;color:#172337;font-weight:650;text-align:right}
.altude-wallet-ui .address-copy{min-height:30px;padding:4px 0;border:0;background:transparent;color:#172337;font-size:12px;font-weight:650}
.altude-wallet-ui .address-copy:hover:not(:disabled){background:transparent;color:#2563eb}
.altude-wallet-ui .address-copy svg,.altude-wallet-ui .account-explorer svg{width:14px;height:14px}
.altude-wallet-ui .recovery-status{padding:5px 10px;border-radius:999px;background:#fff7ed;color:#b45309;font-size:11px}
.altude-wallet-ui .account-explorer{display:inline-flex;align-items:center;gap:5px;color:#3479e8;font-size:13px;font-weight:650;text-decoration:none}
.altude-wallet-ui .account-explorer:hover{text-decoration:underline;text-underline-offset:3px}
.altude-wallet-ui .account-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.altude-wallet-ui .account-actions button{min-height:44px;border-color:#dfe6ee;background:#fff;color:#243248}
.altude-wallet-ui .account-actions button:disabled{border-color:#e5eaf0;background:#fff;color:#7b8797;cursor:not-allowed;opacity:.8}
.altude-wallet-ui .account-actions button svg{width:17px;height:17px;flex:0 0 auto}
.altude-wallet-ui .account-help{margin-top:-8px;color:#7b8797;font-size:11px;text-align:center}
.altude-wallet-ui .trust-row{display:flex;justify-content:center;gap:8px;flex-wrap:wrap;padding:14px 0 12px;border-top:1px solid #eef1f5;color:#617286;font-size:11px;font-weight:600}
.altude-wallet-ui .trust-row span+span:before{margin-right:8px;color:#cbd5e1;content:"·"}
.altude-wallet-ui .footer{display:flex;justify-content:center;margin-top:2px;padding-top:13px;border-top:1px solid #eef1f5}
.altude-wallet-ui .footer span{color:#64748b;font-size:12px}
.altude-wallet-ui .footer strong{color:#334155;letter-spacing:.08em}
.altude-wallet-ui .legal-links{display:flex;justify-content:center;gap:14px;margin-top:8px}
.altude-wallet-ui .legal-links a{color:#718096;font-size:11px;text-decoration:underline;text-underline-offset:2px}
.altude-wallet-ui .legal-links a:hover{color:#084360}
.altude-wallet-ui button:focus-visible,.altude-wallet-ui input:focus-visible{outline:3px solid #3dbff2;outline-offset:2px}
@media(max-width:480px){.altude-wallet-ui .panel{padding:22px 20px 18px;border-radius:21px}.altude-wallet-ui .inline{padding:22px 20px 18px;border-radius:21px}.altude-wallet-ui h2{font-size:25px}.altude-wallet-ui .magic{grid-template-columns:18px minmax(0,1fr);}.altude-wallet-ui .magic-cta{grid-column:1/-1;width:100%}.altude-wallet-ui .method-list{grid-template-columns:1fr}.altude-wallet-ui .wallet-group-toggle{min-height:76px;padding:12px}.altude-wallet-ui .wallet-provider-list{grid-template-columns:repeat(2,minmax(0,1fr))}.altude-wallet-ui .trust-row{gap:5px}}
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
  walletUiInstance += 1
  const providerListId = `altude-wallet-providers-${String(walletUiInstance)}`
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
  panel.setAttribute(
    'aria-label',
    options.walletUi?.appName?.trim() || options.title || 'Altude wallet',
  )
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
  let externalWalletsExpanded = false
  let busy = false
  let message = ''
  let errorMessage = ''
  let loginErrorMessage = ''
  let loginProgressStage:
    | 'authenticating'
    | 'securing-device'
    | 'connecting-account'
    | 'finishing'
    | null = null
  type ConfirmationEvent = Extract<WalletEvent, { type: 'transaction:confirmation' }>
  const pending = new Map<
    string,
    { event: ConfirmationEvent; userId: string | null; address: string | null }
  >()
  const submitting = new Set<string>()
  const events = wallet.onEvent((event) => {
    if (event.type === 'setup:progress') {
      loginProgressStage = event.stage
    }
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
            request.userId !== (event.state.session?.user.id ?? null) ||
            request.address !== event.state.address
          ) {
            pending.delete(id)
          }
        }
      }
    }
    render()
  })

  const render = (focusFirst = false) => {
    panel.replaceChildren()
    const header = document.createElement('header')
    header.className = 'header'
    const brand = document.createElement('div')
    brand.className = 'brand'
    const mark = document.createElement('span')
    mark.className = 'brand-mark'
    mark.setAttribute('aria-hidden', 'true')
    const configuredLogo = safeHttpsUrl(options.walletUi?.logoUrl)
    if (configuredLogo) {
      const logo = document.createElement('img')
      logo.src = configuredLogo
      logo.alt = ''
      logo.referrerPolicy = 'no-referrer'
      mark.append(logo)
    } else {
      mark.textContent = 'A'
    }
    const brandName = document.createElement('span')
    brandName.textContent = options.walletUi?.appName?.trim() || 'Altude'
    brand.append(mark, brandName)
    header.append(brand)
    const headerActions = document.createElement('div')
    headerActions.className = 'header-actions'
    if (otpStarted && !loginErrorMessage && !loginProgressStage) {
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

    if (state.status === 'disconnected' && loginErrorMessage) {
      const errorState = document.createElement('div')
      errorState.className = 'login-state login-error'
      const icon = document.createElement('span')
      icon.className = 'login-state-icon'
      icon.setAttribute('aria-hidden', 'true')
      icon.innerHTML = iconSvg('error')
      const title = document.createElement('h2')
      title.textContent = 'Something went wrong'
      const details = document.createElement('p')
      details.className = 'login-state-copy'
      details.textContent = loginErrorMessage
      const retry = button('Try again', () => {
        loginErrorMessage = ''
        loginProgressStage = null
        otpStarted = false
        otpCode = ''
        errorMessage = ''
        message = ''
        render()
      })
      retry.classList.add('login-retry')
      errorState.append(icon, title, details, retry)
      content.append(errorState)
    } else if (state.status === 'disconnected' && busy && loginProgressStage !== null) {
      const stages = [
        { id: 'authenticating', label: 'Confirming your sign-in' },
        { id: 'securing-device', label: 'Securing your device' },
        { id: 'connecting-account', label: 'Connecting your account' },
        { id: 'finishing', label: 'Finishing sign-in' },
      ] as const
      const activeIndex = Math.max(
        0,
        stages.findIndex(({ id }) => id === loginProgressStage),
      )
      const progress = document.createElement('div')
      progress.className = 'login-state login-progress'
      progress.setAttribute('role', 'status')
      progress.setAttribute('aria-live', 'polite')
      const orb = document.createElement('span')
      orb.className = 'setup-orb'
      orb.setAttribute('aria-hidden', 'true')
      const headline = document.createElement('div')
      headline.className = 'headline setup-copy'
      const title = document.createElement('h2')
      title.textContent = stages[activeIndex]?.label ?? 'Securing your device'
      const subtitle = document.createElement('p')
      subtitle.className = 'subtitle'
      subtitle.textContent = 'Preparing your wallet on this device.'
      headline.append(title, subtitle)
      const steps = document.createElement('div')
      steps.className = 'setup-steps'
      for (const [index, stage] of stages.entries()) {
        const step = document.createElement('div')
        step.className = 'setup-step'
        const state =
          index < activeIndex ? 'complete' : index === activeIndex ? 'active' : 'upcoming'
        step.dataset.state = state
        const indicator = document.createElement('span')
        indicator.className = 'setup-step-indicator'
        indicator.setAttribute('aria-hidden', 'true')
        if (state === 'complete') {
          indicator.innerHTML = iconSvg('check')
        } else if (state === 'active') {
          const spinner = document.createElement('span')
          spinner.className = 'setup-step-spinner'
          indicator.append(spinner)
        }
        const label = document.createElement('span')
        label.textContent = stage.label
        step.append(indicator, label)
        steps.append(step)
      }
      progress.append(orb, headline, steps)
      content.append(progress)
    } else if (state.status === 'disconnected') {
      const walletUi = options.walletUi
      const methodConfiguration = walletUi?.enabledMethods
      const hasWalletUiConfiguration = walletUi !== undefined && walletUi !== null
      const isEnabled = (method: 'emailOtp' | 'smsOtp' | 'passkey') =>
        !hasWalletUiConfiguration || methodConfiguration?.[method] === true
      const canSignInWithOtp = (channel: 'email' | 'sms') =>
        typeof wallet.canSignInWithOtp === 'function'
          ? wallet.canSignInWithOtp(channel)
          : wallet.canStartOtp
      const emailOtpEnabled = canSignInWithOtp('email') && isEnabled('emailOtp')
      const smsOtpEnabled = canSignInWithOtp('sms') && isEnabled('smsOtp')
      if (otpChannel === 'email' && !emailOtpEnabled && smsOtpEnabled) otpChannel = 'sms'
      if (otpChannel === 'sms' && !smsOtpEnabled && emailOtpEnabled) otpChannel = 'email'
      const canStartOtp = emailOtpEnabled || smsOtpEnabled
      const canSignInWithPasskey = wallet.canSignInWithPasskey && isEnabled('passkey')
      const configuredSocialProviders = options.socialProviders ?? []
      const socialProviders =
        wallet.canSignInWithSocial && hasWalletUiConfiguration
          ? configuredSocialProviders.filter((provider) =>
              (methodConfiguration?.socialProviders ?? []).some(
                (enabledProvider) =>
                  normalizeProviderId(enabledProvider) === normalizeProviderId(provider),
              ),
            )
          : wallet.canSignInWithSocial
            ? configuredSocialProviders
            : []
      const externalWalletProviders = wallet.externalWalletProviders.filter(
        (provider) =>
          !hasWalletUiConfiguration ||
          (methodConfiguration?.externalWalletProviders ?? []).includes(provider.id),
      )
      const displayName = walletUi?.appName?.trim() || options.title || 'Altude'
      const headline = document.createElement('div')
      headline.className = 'headline'
      const title = document.createElement('h2')
      title.textContent = otpStarted
        ? `Check your ${otpChannel === 'email' ? 'email' : 'phone'}`
        : `Sign in to ${displayName}`
      const intro = document.createElement('p')
      intro.className = 'subtitle'
      const signInOptions = [
        ...(emailOtpEnabled && smsOtpEnabled
          ? ['email or text message']
          : emailOtpEnabled
            ? ['email']
            : smsOtpEnabled
              ? ['a text message']
              : []),
        ...(socialProviders.length > 0 ? ['a social account'] : []),
        ...(canSignInWithPasskey ? ['a passkey'] : []),
        ...(externalWalletProviders.length > 0 ? ['an external wallet'] : []),
      ]
      intro.textContent = otpStarted
        ? `Enter the one-time code sent to ${otpIdentifier}.`
        : walletUi?.tagline?.trim() ||
          (signInOptions.length > 0
            ? `Continue with ${joinWithOr(signInOptions)}.`
            : 'No sign-in methods are configured for this wallet.')
      headline.append(title, intro)
      content.append(headline)

      const hasIdentityAlternatives = socialProviders.length > 0 || canSignInWithPasskey
      if (
        !otpStarted &&
        canStartOtp &&
        (otpChannel === 'email' ? emailOtpEnabled : smsOtpEnabled)
      ) {
        const form = document.createElement('form')
        form.className = 'magic'
        form.addEventListener('submit', (event) => {
          event.preventDefault()
          const identity = form.querySelector<HTMLInputElement>('input')
          if (!identity) return
          otpIdentifier = identity.value
          if (wallet.usesHostedOtp) {
            void run(() => wallet.signInWithOtp(otpChannel, otpIdentifier), {
              loginAttempt: true,
              showProgress: true,
            })
          } else {
            void run(async () => {
              await wallet.startOtp(otpChannel, otpIdentifier)
              otpStarted = true
              message = `Check your ${otpChannel === 'email' ? 'inbox' : 'phone'} for the verification code.`
            })
          }
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
        const channelSwitch = button(
          otpChannel === 'email' ? 'Use a text message instead' : 'Use email instead',
          () => {
            otpChannel = otpChannel === 'email' ? 'sms' : 'email'
            otpIdentifier = ''
            errorMessage = ''
            message = ''
            render()
          },
          true,
        )
        channelSwitch.classList.add('channel-switch-button')
        if (
          (otpChannel === 'email' && smsOtpEnabled) ||
          (otpChannel === 'sms' && emailOtpEnabled)
        ) {
          content.append(channelSwitch)
        }
      }

      if (!otpStarted && canStartOtp && hasIdentityAlternatives) {
        const divider = document.createElement('div')
        divider.className = 'divider'
        divider.textContent = 'or continue with'
        content.append(divider)
      }
      if (!otpStarted && hasIdentityAlternatives) {
        const methods = document.createElement('div')
        methods.className = 'method-list'
        for (const provider of socialProviders) {
          const control = button(
            `Continue with ${provider}`,
            () =>
              run(() => wallet.signInWithSocial(provider), {
                loginAttempt: true,
                showProgress: true,
              }),
            true,
          )
          control.classList.add('provider-method')
          const glyph = document.createElement('span')
          glyph.className = 'provider-glyph'
          glyph.setAttribute('aria-hidden', 'true')
          glyph.textContent = provider.trim().slice(0, 1).toUpperCase()
          control.prepend(glyph)
          methods.append(control)
        }
        if (canSignInWithPasskey) {
          const passkey = button(
            'Passkey',
            () =>
              run(() => wallet.signInWithPasskey(), {
                loginAttempt: true,
                showProgress: true,
              }),
            true,
          )
          passkey.classList.add('passkey-action')
          const glyph = document.createElement('span')
          glyph.className = 'provider-glyph passkey-glyph'
          glyph.setAttribute('aria-hidden', 'true')
          glyph.innerHTML = iconSvg('key')
          passkey.prepend(glyph)
          methods.append(passkey)
        }
        content.append(methods)
      }
      if (!otpStarted && externalWalletProviders.length > 0) {
        if (canStartOtp || hasIdentityAlternatives) {
          const divider = document.createElement('div')
          divider.className = 'or-divider'
          const label = document.createElement('span')
          label.textContent = 'OR'
          divider.append(label)
          content.append(divider)
        }
        const walletGroup = document.createElement('div')
        walletGroup.className = 'wallet-group'
        const walletToggle = document.createElement('button')
        walletToggle.type = 'button'
        walletToggle.className = 'wallet-group-toggle'
        walletToggle.setAttribute('aria-expanded', String(externalWalletsExpanded))
        walletToggle.setAttribute('aria-controls', providerListId)
        walletToggle.addEventListener('click', () => {
          externalWalletsExpanded = !externalWalletsExpanded
          render()
          panel.querySelector<HTMLButtonElement>('.wallet-group-toggle')?.focus()
        })
        const walletCopy = document.createElement('span')
        walletCopy.className = 'wallet-group-copy'
        const walletIcon = document.createElement('span')
        walletIcon.className = 'wallet-group-icon'
        walletIcon.setAttribute('aria-hidden', 'true')
        walletIcon.innerHTML = iconSvg('wallet')
        const walletTitle = document.createElement('span')
        walletTitle.className = 'wallet-group-title'
        walletTitle.textContent = 'Connect a Web3 wallet'
        const walletDetail = document.createElement('span')
        walletDetail.className = 'wallet-group-detail'
        walletDetail.textContent = externalWalletProviders.map(({ label }) => label).join(', ')
        walletCopy.append(walletTitle, walletDetail)
        const chevron = document.createElement('span')
        chevron.className = 'wallet-group-chevron'
        chevron.setAttribute('aria-hidden', 'true')
        chevron.innerHTML = iconSvg('chevron')
        walletToggle.append(walletIcon, walletCopy, chevron)
        walletGroup.append(walletToggle)
        const providerList = document.createElement('div')
        providerList.className = 'wallet-provider-list'
        providerList.id = providerListId
        providerList.hidden = !externalWalletsExpanded
        providerList.setAttribute('role', 'group')
        providerList.setAttribute('aria-label', 'Available Web3 wallets')
        for (const provider of externalWalletProviders) {
          const providerButton = button(
            `Connect ${provider.label}`,
            () =>
              run(() => wallet.connectExternalWallet(provider.id), {
                loginAttempt: true,
              }),
            true,
          )
          providerButton.className = 'wallet-provider-card'
          providerButton.setAttribute('aria-label', `Connect ${provider.label}`)
          const providerIcon = document.createElement('span')
          providerIcon.className = 'wallet-provider-icon'
          providerIcon.dataset.provider = provider.id
          providerIcon.setAttribute('aria-hidden', 'true')
          providerIcon.textContent = provider.label.slice(0, 1).toUpperCase()
          const providerName = document.createElement('span')
          providerName.className = 'wallet-provider-name'
          providerName.textContent = provider.label
          const providerStatus = document.createElement('span')
          providerStatus.className = 'wallet-provider-status'
          const available = provider.isAvailable?.()
          providerStatus.textContent =
            provider.id === 'walletconnect'
              ? 'QR & MOBILE'
              : available === true
                ? 'DETECTED'
                : available === false
                  ? 'NOT DETECTED'
                  : 'READY TO CONNECT'
          if (available !== undefined) {
            providerStatus.dataset.available = String(available)
          }
          providerButton.replaceChildren(providerIcon, providerName, providerStatus)
          providerList.append(providerButton)
        }
        walletGroup.append(providerList)
        content.append(walletGroup)
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
            run(
              async () => {
                await wallet.verifyOtp(otpChannel, otpIdentifier, code.value)
                otpStarted = false
                otpCode = ''
              },
              {
                loginAttempt: true,
                showProgress: true,
              },
            ),
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
    } else if (state.status === 'connected' && state.custody === 'embedded') {
      const address = state.address
      const identity = document.createElement('div')
      identity.className = 'account-identity'
      const avatar = document.createElement('span')
      avatar.className = 'account-avatar'
      avatar.setAttribute('aria-hidden', 'true')
      const contact =
        state.session?.user.email || state.session?.user.phoneNumber || 'Wallet account'
      avatar.textContent = contact.slice(0, 1).toUpperCase()
      const accountContact = document.createElement('div')
      accountContact.className = 'account-contact'
      const contactText = document.createElement('strong')
      contactText.textContent = contact
      const protection = document.createElement('span')
      protection.className = 'account-protection'
      protection.innerHTML = iconSvg('shield')
      protection.append(
        document.createTextNode(
          state.protection === 'passkey' ? 'Protected with a passkey' : 'Stored on this device',
        ),
      )
      accountContact.append(contactText, protection)
      identity.append(avatar, accountContact)
      content.append(identity)

      const accountCard = document.createElement('div')
      accountCard.className = 'account-card'
      accountCard.append(
        accountRow('Account address', () => {
          const value = document.createElement('span')
          value.className = 'account-row-value'
          value.textContent = address ? abbreviateAddress(address) : 'Unavailable'
          if (address) {
            const copy = button(
              'Copy account address',
              () =>
                run(async () => {
                  await navigator.clipboard.writeText(address)
                  message = 'Account address copied.'
                }),
              true,
            )
            copy.className = 'address-copy'
            copy.setAttribute('aria-label', 'Copy account address')
            copy.innerHTML = iconSvg('copy')
            value.append(copy)
          }
          return value
        }),
        accountRow('Recovery', () => {
          const value = document.createElement('span')
          value.className = 'account-row-value'
          const status = document.createElement('span')
          status.className = 'recovery-status'
          status.textContent = 'Not set up'
          value.append(status)
          return value
        }),
        accountRow('Connected app', () => {
          const value = document.createElement('span')
          value.className = 'account-row-value'
          value.textContent = options.title?.trim() || options.walletUi?.appName?.trim() || 'Altude'
          return value
        }),
        accountRow('On-chain', () => {
          const value = document.createElement('span')
          value.className = 'account-row-value'
          if (address) {
            const explorer = document.createElement('a')
            explorer.className = 'account-explorer'
            explorer.href = getExplorerAddressUrl(address, wallet.network)
            explorer.target = '_blank'
            explorer.rel = 'noopener noreferrer'
            explorer.textContent = `View ${networkLabel(wallet.network)} explorer`
            explorer.append(createIcon('external'))
            value.append(explorer)
          } else {
            value.textContent = networkLabel(wallet.network)
          }
          return value
        }),
      )
      content.append(accountCard)

      const recoveryHelpId = `altude-recovery-help-${String(walletUiInstance)}`
      const accountActions = document.createElement('div')
      accountActions.className = 'account-actions'
      const manageRecovery = button('Manage recovery', () => undefined, true, true)
      manageRecovery.setAttribute('aria-describedby', recoveryHelpId)
      manageRecovery.prepend(createIcon('shield'))
      const signOut = button('Sign out', () => run(() => wallet.signOut()), true)
      signOut.prepend(createIcon('signout'))
      accountActions.append(manageRecovery, signOut)
      content.append(accountActions)
      const recoveryHelp = document.createElement('p')
      recoveryHelp.id = recoveryHelpId
      recoveryHelp.className = 'account-help'
      recoveryHelp.textContent = 'Recovery setup is not available for this wallet yet.'
      content.append(recoveryHelp)
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
    if (errorMessage && !loginErrorMessage) {
      const error = document.createElement('p')
      error.className = 'error'
      error.setAttribute('role', 'alert')
      error.textContent = errorMessage
      content.append(error)
    }
    if (state.status === 'disconnected' && !otpStarted && !loginErrorMessage) {
      const trustRow = document.createElement('div')
      trustRow.className = 'trust-row'
      const verifiedBadges = options.walletUi?.trustedBadges
      if (verifiedBadges?.nonCustodialVerified) {
        const custody = document.createElement('span')
        custody.textContent = 'Non-custodial'
        trustRow.append(custody)
      } else {
        const custody = document.createElement('span')
        custody.textContent = 'Self-custodial'
        trustRow.append(custody)
      }
      const approval = document.createElement('span')
      approval.textContent = 'You approve each transfer'
      trustRow.append(approval)
      if (verifiedBadges?.ikaRecoveryVerified) {
        const recovery = document.createElement('span')
        recovery.textContent = 'Secure recovery by Ika'
        trustRow.append(recovery)
      }
      if (verifiedBadges?.soc2Verified) {
        const soc2 = document.createElement('span')
        soc2.textContent = 'SOC 2'
        trustRow.append(soc2)
      }
      content.append(trustRow)
    }
    const footer = document.createElement('footer')
    footer.className = 'footer'
    const footerText = document.createElement('span')
    footerText.innerHTML = 'Securely yours, by <strong>ALTUDE</strong>'
    footer.append(footerText)
    panel.append(footer)
    const legalUrls = [
      ['Terms', options.walletUi?.termsUrl],
      ['Privacy', options.walletUi?.privacyUrl],
    ] as const
    const legalLinks = legalUrls
      .map(([label, value]) => {
        const url = safeHttpsUrl(value)
        if (!url) return undefined
        const link = document.createElement('a')
        link.href = url
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        link.textContent = label
        return link
      })
      .filter((link): link is HTMLAnchorElement => link !== undefined)
    if (legalLinks.length > 0) {
      const legal = document.createElement('nav')
      legal.className = 'legal-links'
      legal.setAttribute('aria-label', 'Legal information')
      legal.append(...legalLinks)
      panel.append(legal)
    }
    if (focusFirst) {
      const firstButton = panel.querySelector<HTMLButtonElement>('button')
      if (firstButton) firstButton.focus()
    }
  }

  async function run(
    operation: () => Promise<unknown>,
    options: { loginAttempt?: boolean; showProgress?: boolean } = {},
  ): Promise<void> {
    if (busy) return
    busy = true
    errorMessage = ''
    loginErrorMessage = ''
    loginProgressStage = options.showProgress ? 'authenticating' : null
    message = ''
    render()
    try {
      await operation()
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error)
      if (options.loginAttempt) {
        otpStarted = false
        otpCode = ''
        loginErrorMessage = details
      } else {
        errorMessage = details
      }
    } finally {
      busy = false
      loginProgressStage = null
      render(true)
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
    for (const id of pending.keys()) {
      if (!submitting.has(id)) wallet.rejectTransaction(id)
    }
    pending.clear()
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

function normalizeProviderId(provider: string): string {
  return provider
    .trim()
    .toLowerCase()
    .replace(/-oauth2$/, '')
    .replace(/[^a-z0-9]/g, '')
}

function safeHttpsUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
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

function iconSvg(
  icon:
    | 'back'
    | 'close'
    | 'email'
    | 'phone'
    | 'key'
    | 'chevron'
    | 'wallet'
    | 'error'
    | 'check'
    | 'copy'
    | 'shield'
    | 'signout'
    | 'external',
): string {
  const paths = {
    back: '<path d="m15 18-6-6 6-6"/><path d="M9 12h12"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    email: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9m-5 5 3 3m-6-1 3 3"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    wallet:
      '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 9h18"/><path d="M16 15h2"/>',
    error: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    shield: '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/>',
    signout:
      '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    external:
      '<path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  }
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[icon]}</svg>`
}

function createIcon(icon: Parameters<typeof iconSvg>[0]): HTMLSpanElement {
  const element = document.createElement('span')
  element.setAttribute('aria-hidden', 'true')
  element.innerHTML = iconSvg(icon)
  return element
}

function accountRow(labelText: string, createValue: () => HTMLElement): HTMLDivElement {
  const row = document.createElement('div')
  row.className = 'account-row'
  const label = document.createElement('span')
  label.className = 'account-row-label'
  label.textContent = labelText
  row.append(label, createValue())
  return row
}

function abbreviateAddress(address: string): string {
  if (address.length <= 12) return address
  return `${address.slice(0, 4)}…${address.slice(-4)}`
}

function networkLabel(network: AltudeWallet['network']): string {
  return network === 'mainnet-beta' ? 'mainnet' : network
}

function getExplorerAddressUrl(address: string, network: AltudeWallet['network']): string {
  const url = new URL(`https://explorer.solana.com/address/${encodeURIComponent(address)}`)
  if (network !== 'mainnet-beta') url.searchParams.set('cluster', network)
  return url.toString()
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

import type { WalletEvent, WalletState, WalletUiOptions } from './types.js'
import type { AltudeWallet } from './wallet.js'

let walletUiInstance = 0

const styles = `
.altude-wallet-ui{font:14px/1.5 Manrope,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--altude-ink,#071922)}
.altude-wallet-ui *{box-sizing:border-box}
.altude-wallet-ui [hidden]{display:none!important}
.altude-wallet-ui .overlay{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));background:rgba(7,25,34,.4)}
.altude-wallet-ui .panel{width:min(100%,420px);max-height:calc(100dvh - 32px);overflow:auto;padding:24px clamp(16px,5%,28px);container-type:inline-size;overflow-wrap:anywhere;background:var(--altude-surface,#fff);border:1px solid var(--altude-line,#dce2e5);border-radius:20px;box-shadow:0 24px 80px -24px rgba(7,25,34,.3)}
.altude-wallet-ui .inline{width:100%;max-width:420px;margin:auto;padding:24px clamp(16px,5%,28px) 28px;container-type:inline-size;overflow-wrap:anywhere;background:var(--altude-surface,#fff);border:1px solid var(--altude-line,#dce2e5);border-radius:20px;box-shadow:0 16px 48px -24px rgba(7,25,34,.22)}
.altude-wallet-ui .fullscreen{position:fixed;inset:0;z-index:2147483000;overflow:auto;padding:24px;background:var(--altude-canvas,#efefef)}
.altude-wallet-ui .header{position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:24px}
.altude-wallet-ui .brand{display:inline-flex;min-width:0;align-items:center;gap:10px;color:var(--altude-ink,#071922);font-size:14px;font-weight:700;letter-spacing:-.02em}
.altude-wallet-ui .brand-mark{display:grid;width:24px;height:24px;flex:none;place-items:center;border:0;border-radius:0;background:transparent;color:var(--altude-ink,#071922)}
.altude-wallet-ui .brand-mark svg{width:18px;height:18px}
.altude-wallet-ui .brand-mark img{display:block;width:100%;height:100%;object-fit:contain}
.altude-wallet-ui .header-actions{display:flex;gap:8px}
.altude-wallet-ui .icon-button{display:grid;width:44px;height:44px;min-height:44px;margin:0;padding:0;place-items:center;border:1px solid var(--altude-line,#dce2e5);border-radius:50%;background:transparent;color:var(--altude-ink-2,#24404e);cursor:pointer}
.altude-wallet-ui .icon-button:hover{background:var(--altude-line-soft,#edf0f1)}
.altude-wallet-ui .icon-button svg{width:15px;height:15px}
.altude-wallet-ui .content{display:flex;flex-direction:column;gap:20px}
.altude-wallet-ui h2{margin:0;color:var(--altude-ink,#071922);font-size:24px;line-height:1.25;font-weight:700;letter-spacing:-.045em}
.altude-wallet-ui .headline--hero h2{font-size:28px}
.altude-wallet-ui p{margin:0;color:var(--altude-muted,#5d7079)}
.altude-wallet-ui .headline{display:flex;flex-direction:column;gap:8px}
.altude-wallet-ui .subtitle{font-size:14px;line-height:1.65}
.altude-wallet-ui .sms-consent{display:flex;align-items:flex-start;gap:10px;color:var(--altude-muted,#5d7079);font-size:13px}
.altude-wallet-ui .sms-consent input{width:20px;height:20px;min-height:20px;flex:none;margin:2px 0;accent-color:var(--altude-fuji,#084360)}
.altude-wallet-ui .local-wallet{display:grid;gap:12px;padding:14px;border:1px solid var(--altude-line,#dce2e5);border-radius:12px}
.altude-wallet-ui .local-wallet h3{margin:0;color:var(--altude-ink,#071922);font-size:14px}
.altude-wallet-ui .local-wallet-return{display:grid;gap:8px}
.altude-wallet-ui .local-wallet label{display:grid;gap:6px;color:var(--altude-ink,#071922);font-size:13px;font-weight:600}
.altude-wallet-ui .local-wallet input{padding:10px;border:1px solid var(--altude-line,#dce2e5);border-radius:8px;font-weight:400}
.altude-wallet-ui .local-handle{overflow-wrap:anywhere;user-select:all}
.altude-wallet-ui .balance-form{display:grid;gap:8px}
.altude-wallet-ui .balance-form label{display:grid;gap:6px;color:var(--altude-ink,#071922);font-size:13px;font-weight:600}
.altude-wallet-ui .balance-form input{padding:10px;border:1px solid var(--altude-line,#dce2e5);border-radius:8px;font-weight:400}
.altude-wallet-ui .magic{display:grid;grid-template-columns:24px minmax(0,1fr) auto;align-items:center;gap:8px;padding:6px 6px 6px 12px;background:var(--altude-surface,#fff);border:1px solid var(--altude-line,#dce2e5);border-radius:12px}
.altude-wallet-ui .field-icon{display:grid;place-items:center;color:var(--altude-muted,#5d7079)}
.altude-wallet-ui .field-icon svg{width:17px;height:17px}
.altude-wallet-ui input{width:100%;min-width:0;min-height:40px;padding:10px 2px;border:0;background:transparent;color:var(--altude-ink,#071922);font:inherit;font-size:16px;outline:none}
.altude-wallet-ui input::placeholder{color:var(--altude-muted-2,#687b84)}
.altude-wallet-ui .magic:focus-within{border-color:var(--altude-sky-600,#087da9);outline:2px solid var(--altude-sky-600,#087da9);outline-offset:2px}
.altude-wallet-ui button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;margin:0;padding:12px 16px;border:1px solid transparent;border-radius:10px;background:var(--altude-fuji,#084360);color:#fff;font:600 14px/1.2 Manrope,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;transition:background 160ms ease,border-color 160ms ease,transform 160ms ease}
.altude-wallet-ui button:hover:not(:disabled){background:var(--altude-sky-700,#084360)}
.altude-wallet-ui button:active:not(:disabled){transform:translateY(1px)}
.altude-wallet-ui button:disabled{opacity:.45;cursor:not-allowed}
.altude-wallet-ui button.secondary{border-color:var(--altude-line,#dce2e5);background:var(--altude-surface,#fff);color:var(--altude-ink,#071922)}
.altude-wallet-ui button.secondary:hover:not(:disabled){border-color:var(--altude-muted-2,#687b84);background:var(--altude-line-soft,#edf0f1)}
.altude-wallet-ui .magic-cta{min-height:44px;padding:0 14px;border-radius:8px;background:var(--altude-brand-ink,#071922);color:var(--altude-offwhite,#efefef);font-size:13px}
.altude-wallet-ui .magic-cta svg{width:14px;height:14px;flex:none}
.altude-wallet-ui .channel-switch-button{align-self:flex-start;min-height:44px;padding:8px 0;border:0;background:transparent;color:var(--altude-sky-700,#084360);font-size:13px}
.altude-wallet-ui .channel-switch-button:hover:not(:disabled){background:transparent;text-decoration:underline}
.altude-wallet-ui .divider{margin:-4px 0;text-align:center;color:var(--altude-muted,#5d7079);font-size:12px}
.altude-wallet-ui .method-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(48px,1fr));gap:8px}
.altude-wallet-ui .method-list button{min-width:0;min-height:48px;padding:12px;border-color:var(--altude-line,#dce2e5);background:var(--altude-surface,#fff);color:var(--altude-ink,#071922)}
.altude-wallet-ui .method-list button:hover:not(:disabled){border-color:var(--altude-muted-2,#687b84);background:var(--altude-line-soft,#edf0f1)}
.altude-wallet-ui .provider-glyph{display:grid;width:24px;height:24px;flex:none;place-items:center;color:var(--altude-ink,#071922);font-size:13px;font-weight:700}
.altude-wallet-ui .provider-glyph svg{width:20px;height:20px}
.altude-wallet-ui .method-label{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.altude-wallet-ui .passkey-glyph{background:transparent}
.altude-wallet-ui .or-divider{display:flex;align-items:center;gap:12px;color:var(--altude-muted,#5d7079);font-size:12px}
.altude-wallet-ui .or-divider:before,.altude-wallet-ui .or-divider:after{height:1px;flex:1;background:var(--altude-line,#dce2e5);content:""}
.altude-wallet-ui .wallet-group{overflow:hidden;border:1px solid var(--altude-line,#dce2e5);border-radius:12px;background:var(--altude-surface,#fff)}
.altude-wallet-ui .wallet-group-toggle{display:flex;width:100%;min-height:64px;align-items:center;justify-content:space-between;gap:12px;padding:14px;border:0;border-radius:0;background:transparent;color:var(--altude-ink,#071922);text-align:left}
.altude-wallet-ui .wallet-group-toggle:hover:not(:disabled){background:var(--altude-line-soft,#edf0f1)}
.altude-wallet-ui .wallet-group-copy{display:grid;flex:1;gap:3px;text-align:left}
.altude-wallet-ui .wallet-group-icon{display:grid;width:36px;height:36px;flex:none;place-items:center;border-radius:8px;background:var(--altude-line-soft,#edf0f1);color:var(--altude-ink,#071922)}
.altude-wallet-ui .wallet-group-icon svg{width:22px;height:22px}
.altude-wallet-ui .wallet-group-title{font-size:14px;font-weight:600}
.altude-wallet-ui .wallet-group-detail{color:var(--altude-muted,#5d7079);font-size:12px;font-weight:400;line-height:1.4}
.altude-wallet-ui .wallet-group-chevron{display:grid;width:24px;height:24px;flex:none;place-items:center;color:var(--altude-muted,#5d7079)}
.altude-wallet-ui .wallet-group-chevron svg{width:16px;height:16px;transition:transform 160ms ease}
.altude-wallet-ui .wallet-group-toggle[aria-expanded="true"] .wallet-group-chevron svg{transform:rotate(180deg)}
.altude-wallet-ui .wallet-provider-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:0 12px 12px}
.altude-wallet-ui .wallet-provider-list[hidden]{display:none}
.altude-wallet-ui .wallet-provider-card{min-width:0;min-height:100px;flex-direction:column;gap:6px;padding:14px 4px;border-color:var(--altude-line,#dce2e5);border-radius:8px;background:var(--altude-surface,#fff);color:var(--altude-ink,#071922)}
.altude-wallet-ui .wallet-provider-card:hover:not(:disabled){border-color:var(--altude-muted-2,#687b84);background:var(--altude-line-soft,#edf0f1)}
.altude-wallet-ui .wallet-provider-icon{display:grid;width:38px;height:38px;place-items:center;color:var(--altude-ink,#071922);font-size:14px;font-weight:700}
.altude-wallet-ui .wallet-provider-icon[data-provider="metamask"]{color:#b45c22}
.altude-wallet-ui .wallet-provider-icon[data-provider="phantom"]{color:#7860d9}
.altude-wallet-ui .wallet-provider-icon[data-provider="walletconnect"]{color:#2786f7}
.altude-wallet-ui .wallet-provider-name{font-size:11px;font-weight:600}
.altude-wallet-ui .wallet-provider-status{color:var(--altude-muted,#5d7079);font-size:10px;font-weight:500}
.altude-wallet-ui .wallet-provider-status[data-available="false"]{color:var(--altude-muted,#5d7079)}
.altude-wallet-ui .otp-form{display:flex;flex-direction:column;gap:20px}
.altude-wallet-ui .otp-fields{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));align-self:center;gap:clamp(4px,2cqi,8px);width:100%;max-width:316px;min-width:0;padding:8px 0}
.altude-wallet-ui .otp-fields input{width:100%;min-width:0;height:52px;padding:0;border:1px solid var(--altude-line,#dce2e5);border-radius:8px;background:var(--altude-surface,#fff);font:20px/1 "DM Mono",monospace;text-align:center}
.altude-wallet-ui .otp-fields input:focus{border-color:var(--altude-sky-600,#087da9);box-shadow:0 0 0 3px rgba(4,138,191,.12)}
.altude-wallet-ui .otp-resend{display:flex;align-items:center;justify-content:center;gap:4px;color:var(--altude-muted,#5d7079);font-size:13px}
.altude-wallet-ui .otp-resend button{min-height:44px;padding:4px;border:0;background:transparent;color:var(--altude-sky-700,#084360);font:inherit;font-weight:600}
.altude-wallet-ui .otp-resend button:hover:not(:disabled){background:transparent;text-decoration:underline}
.altude-wallet-ui .actions{display:flex;flex-direction:column;gap:8px}
.altude-wallet-ui .actions button{width:100%;justify-content:flex-start}
.altude-wallet-ui .status-card{padding:14px;border:1px solid var(--altude-line,#dce2e5);border-radius:12px;background:var(--altude-canvas,#efefef)}
.altude-wallet-ui .status-label{margin-bottom:5px;color:var(--altude-muted,#5d7079);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em}
.altude-wallet-ui .status{overflow-wrap:anywhere;color:var(--altude-ink,#071922);font-size:13px;font-weight:600}
.altude-wallet-ui .note{padding:12px 14px;border:1px solid var(--altude-line,#dce2e5);border-radius:8px;background:var(--altude-selection,#eaf5fa);color:var(--altude-ink-2,#24404e);font-size:13px}
.altude-wallet-ui .error{padding:12px 14px;border:1px solid rgba(166,38,45,.25);border-radius:8px;background:color-mix(in srgb,#a6262d 6%,var(--altude-surface,#fff));color:#a6262d;font-size:13px}
.altude-wallet-ui .confirm{display:flex;flex-direction:column;gap:10px;margin-top:4px;padding:14px;border:1px solid var(--altude-line,#dce2e5);border-radius:12px;background:var(--altude-selection,#eaf5fa)}
.altude-wallet-ui .confirm p{color:var(--altude-ink,#071922)}
.altude-wallet-ui .login-state{display:flex;flex-direction:column;align-items:center;gap:20px;padding:16px 0;text-align:center}
.altude-wallet-ui .login-state h2{font-size:24px}
.altude-wallet-ui .login-state-copy{color:var(--altude-muted,#5d7079);font-size:14px;line-height:1.65;overflow-wrap:anywhere}
.altude-wallet-ui .login-state-icon{display:grid;width:64px;height:64px;place-items:center;border:1px solid var(--altude-line,#dce2e5);border-radius:50%}
.altude-wallet-ui .login-state-icon svg{width:28px;height:28px}
.altude-wallet-ui .login-error .login-state-icon{color:#a6262d}
.altude-wallet-ui .login-retry{width:100%;min-height:48px;font-size:14px}
.altude-wallet-ui .setup-orb{position:relative;display:grid;width:64px;height:64px;place-items:center}
.altude-wallet-ui .setup-orb:before{width:14px;height:14px;border-radius:50%;background:var(--altude-sky-600,#087da9);content:""}
.altude-wallet-ui .setup-orb:after{position:absolute;inset:4px;border:2px solid var(--altude-line,#dce2e5);border-top-color:var(--altude-sky-600,#087da9);border-radius:50%;animation:altude-wallet-spin 1s linear infinite;content:""}
.altude-wallet-ui .setup-copy p{font-size:14px}
.altude-wallet-ui .setup-steps{display:grid;width:100%;gap:16px;padding:16px;border:1px solid var(--altude-line,#dce2e5);border-radius:12px;background:var(--altude-canvas,#efefef);text-align:left}
.altude-wallet-ui .setup-step{display:flex;align-items:center;gap:12px;color:var(--altude-muted,#5d7079);font-size:13px}
.altude-wallet-ui .setup-step-indicator{display:grid;width:22px;height:22px;flex:none;place-items:center;border-radius:50%;background:var(--altude-line-soft,#edf0f1);color:var(--altude-sky-700,#084360)}
.altude-wallet-ui .setup-step-indicator svg{width:14px;height:14px}
.altude-wallet-ui .setup-step[data-state="active"]{color:var(--altude-ink,#071922);font-weight:600}
.altude-wallet-ui .setup-step[data-state="active"] .setup-step-indicator{background:var(--altude-sky-600,#087da9);color:#fff}
.altude-wallet-ui .setup-step[data-state="complete"] .setup-step-indicator{background:var(--altude-sky-100,#d8effa)}
.altude-wallet-ui .setup-step-spinner{width:10px;height:10px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:altude-wallet-spin .8s linear infinite}
@keyframes altude-wallet-spin{to{transform:rotate(360deg)}}
.altude-wallet-ui .account-identity{display:flex;align-items:center;gap:13px}
.altude-wallet-ui .account-avatar{display:grid;width:48px;height:48px;flex:none;place-items:center;border-radius:12px;background:var(--altude-sky-100,#d8effa);color:var(--altude-brand-ink,#071922);font-size:18px;font-weight:700}
.altude-wallet-ui .account-contact{display:grid;min-width:0;gap:6px}
.altude-wallet-ui .account-contact strong{overflow-wrap:anywhere;color:var(--altude-ink,#071922);font-size:15px;font-weight:600}
.altude-wallet-ui .account-protection{display:inline-flex;align-items:center;gap:6px;justify-self:start;color:var(--altude-muted,#5d7079);font-size:11px}
.altude-wallet-ui .account-protection svg{width:14px;height:14px}
.altude-wallet-ui .account-card{display:grid;gap:0;padding:8px 16px;border:1px solid var(--altude-line,#dce2e5);border-radius:12px;background:var(--altude-canvas,#efefef)}
.altude-wallet-ui .account-row{display:flex;flex-wrap:wrap;min-height:47px;align-items:center;justify-content:space-between;gap:8px 16px;padding:12px 0;border-bottom:1px solid var(--altude-line,#dce2e5);color:var(--altude-muted,#5d7079);font-size:13px}
.altude-wallet-ui .account-row:last-child{border-bottom:0}
.altude-wallet-ui .account-row-label{flex:0 0 auto}
.altude-wallet-ui .account-row-value{display:inline-flex;min-width:0;align-items:center;justify-content:flex-end;gap:7px;color:var(--altude-ink,#071922);font-weight:600;text-align:right}
.altude-wallet-ui .address-copy{min-width:44px;min-height:44px;padding:6px;border:0;background:transparent;color:var(--altude-ink,#071922);font:13px "DM Mono",monospace}
.altude-wallet-ui .address-copy:hover:not(:disabled){background:transparent;color:var(--altude-sky-700,#084360)}
.altude-wallet-ui .address-copy svg,.altude-wallet-ui .account-explorer svg{width:14px;height:14px}
.altude-wallet-ui .recovery-status{color:var(--altude-ink-2,#24404e);font-size:11px}
.altude-wallet-ui .account-explorer{display:inline-flex;align-items:center;gap:6px;color:var(--altude-sky-700,#084360);font-size:13px;font-weight:600;text-decoration:none}
.altude-wallet-ui .account-explorer:hover{text-decoration:underline;text-underline-offset:3px}
.altude-wallet-ui .account-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.altude-wallet-ui .account-actions button{min-height:44px;padding:12px;border-color:var(--altude-line,#dce2e5);background:var(--altude-surface,#fff);color:var(--altude-ink,#071922);font-size:13px}
.altude-wallet-ui .account-actions button svg{width:17px;height:17px;flex:0 0 auto}
.altude-wallet-ui .account-help{margin-top:-8px;color:var(--altude-muted,#5d7079);font-size:11px;text-align:center}
.altude-wallet-ui .trust-row{display:flex;justify-content:center;gap:8px;flex-wrap:wrap;padding-top:16px;border-top:1px solid var(--altude-line-soft,#edf0f1);color:var(--altude-muted,#5d7079);font-size:11px;line-height:1.6}
.altude-wallet-ui .trust-row span{display:inline-flex;align-items:flex-start;gap:8px}
.altude-wallet-ui .trust-row svg{width:14px;height:14px;flex:none;margin-top:2px}
.altude-wallet-ui .footer{display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;margin-top:24px;padding-top:16px;border-top:1px solid var(--altude-line-soft,#edf0f1);color:var(--altude-muted,#5d7079)}
.altude-wallet-ui .footer svg{width:12px;height:12px}
.altude-wallet-ui .footer span{color:var(--altude-muted,#5d7079);font-size:11px}
.altude-wallet-ui .footer strong{font-family:Montserrat,system-ui,sans-serif;letter-spacing:.06em}
.altude-wallet-ui .legal-links{display:flex;justify-content:center;gap:14px;margin-top:8px}
.altude-wallet-ui .legal-links a{color:var(--altude-muted,#5d7079);font-size:11px;text-decoration:underline;text-underline-offset:2px}
.altude-wallet-ui .legal-links a:hover{color:var(--altude-sky-700,#084360)}
.altude-wallet-ui button:focus-visible,.altude-wallet-ui input:focus-visible,.altude-wallet-ui a:focus-visible{outline:2px solid var(--altude-sky-600,#087da9);outline-offset:2px}
@container(max-width:300px){.altude-wallet-ui .magic{grid-template-columns:24px minmax(0,1fr)}.altude-wallet-ui .magic-cta{grid-column:1/-1;width:100%}.altude-wallet-ui .wallet-provider-list{grid-template-columns:repeat(2,minmax(0,1fr))}.altude-wallet-ui .account-actions{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){.altude-wallet-ui *,.altude-wallet-ui *::before,.altude-wallet-ui *::after{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
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
  panel.setAttribute('tabindex', '-1')
  panel.className = presentation === 'inline' ? 'inline' : 'panel'
  panel.setAttribute('role', presentation === 'modal' ? 'dialog' : 'region')
  if (presentation === 'modal') panel.setAttribute('aria-modal', 'true')
  panel.setAttribute(
    'aria-label',
    options.walletUi?.branding?.appName?.trim() || options.title || 'Altude wallet',
  )
  if (presentation === 'modal') {
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        options.onClose?.()
      } else if (event.key === 'Tab') {
        const focusable = getFocusableControls(panel)
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (focusable.length === 0) {
          event.preventDefault()
          panel.focus()
        } else if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement as HTMLElement))) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement as HTMLElement))) {
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
  let otpDigits = Array<string>(6).fill('')
  let otpStarted = false
  let smsConsent = false
  let localHandle = ''
  let tokenMint = ''
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
  type ProvisioningEvent = Extract<WalletEvent, { type: 'provisioning:confirmation' }>
  const provisioning = new Map<string, { event: ProvisioningEvent; owner: string }>()
  const provisioningSubmitting = new Set<string>()
  let provisioningRequested = false
  let provisioningController: AbortController | null = null
  let mounted = true
  const ownerOf = (state: WalletState) =>
    JSON.stringify([state.custody, state.session?.user.id, state.localIdentityKey, state.address])
  const legalConfiguration = () => options.walletUi != null ? options.walletUi.legal : options.legal
  const smsConsentText = () => legalConfiguration()?.smsConsentText?.trim()
  const hasSmsConsent = () => Boolean(smsConsentText()) && smsConsent
  const events = wallet.onEvent((event) => {
    if (!mounted) return
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
    if (event.type === 'provisioning:confirmation') {
      provisioning.set(event.id, { event, owner: ownerOf(wallet.state) })
    }
    if (event.type === 'provisioning:complete' && provisioning.delete(event.id)) {
      message = event.result.Message || (event.result.Signature
        ? `Account created: ${event.result.Signature}`
        : 'Account is ready.')
    }
    if (event.type === 'provisioning:error' && provisioning.delete(event.id)) {
      errorMessage = event.error.message
    }
    if (event.type === 'state') {
      if (event.state.status === 'disconnected') {
        pending.clear()
        provisioning.clear()
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
      for (const [id, request] of provisioning) {
        if (request.owner !== ownerOf(event.state)) provisioning.delete(id)
      }
    }
    render()
  })

  const render = (focusFirst = false) => {
    if (!mounted) return
    const hadFocus = panel.contains(document.activeElement)
    panel.replaceChildren()
    const header = document.createElement('header')
    header.className = 'header'
    const brand = document.createElement('div')
    brand.className = 'brand'
    const mark = document.createElement('span')
    mark.className = 'brand-mark'
    mark.setAttribute('aria-hidden', 'true')
    const configuredLogo = safeHttpsUrl(options.walletUi?.branding?.logoUrl)
    if (configuredLogo) {
      const logo = document.createElement('img')
      logo.src = configuredLogo
      logo.alt = ''
      logo.referrerPolicy = 'no-referrer'
      mark.append(logo)
    } else {
      mark.innerHTML =
        '<svg viewBox="0 0 18 18" fill="currentColor" aria-hidden="true"><rect width="8.7" height="8.7"/><rect x="8.7" y="8.7" width="8.7" height="8.7"/></svg>'
    }
    const brandName = document.createElement('span')
    brandName.textContent = options.walletUi?.branding?.appName?.trim() || 'Altude'
    brand.append(mark, brandName)
    header.append(brand)
    const headerActions = document.createElement('div')
    headerActions.className = 'header-actions'
    if (otpStarted && !loginErrorMessage && !loginProgressStage) {
      headerActions.append(
        iconButton('Back to sign-in', 'back', () => {
          otpStarted = false
          otpDigits = Array<string>(6).fill('')
          errorMessage = ''
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
      details.setAttribute('role', 'alert')
      details.textContent = loginErrorMessage
      const retry = button('Try again', () => {
        loginErrorMessage = ''
        loginProgressStage = null
        otpStarted = false
        otpDigits = Array<string>(6).fill('')
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
      const methodConfiguration = walletUi != null ? walletUi.authMethods : options.authMethods
      const isEnabled = (method: 'emailOtp' | 'smsOtp' | 'passkey') =>
        methodConfiguration?.[method] === true
      const canSignInWithOtp = (channel: 'email' | 'sms') =>
        typeof wallet.canSignInWithOtp === 'function'
          ? wallet.canSignInWithOtp(channel)
          : wallet.canStartOtp
      const emailOtpEnabled = canSignInWithOtp('email') && isEnabled('emailOtp')
      const smsOtpEnabled = canSignInWithOtp('sms') && isEnabled('smsOtp')
      const previousChannel = otpChannel
      if (otpChannel === 'email' && !emailOtpEnabled && smsOtpEnabled) otpChannel = 'sms'
      if (otpChannel === 'sms' && !smsOtpEnabled && emailOtpEnabled) otpChannel = 'email'
      if (previousChannel !== otpChannel) {
        smsConsent = false
        otpIdentifier = ''
      }
      const canStartOtp = emailOtpEnabled || smsOtpEnabled
      const canSignInWithPasskey = wallet.canSignInWithPasskey && isEnabled('passkey')
      const canUseLocalPasskey = wallet.canUseLocalPasskey && isEnabled('passkey')
      const configuredSocialProviders = options.socialProviders ?? []
      const socialProviders =
        wallet.canSignInWithSocial
          ? configuredSocialProviders.filter((provider) =>
              (methodConfiguration?.socialProviders ?? []).some(
                (enabledProvider) =>
                  normalizeProviderId(enabledProvider) === normalizeProviderId(provider),
              ),
            )
          : []
      const externalWalletProviders = wallet.externalWalletProviders.filter(
        (provider) =>
          (methodConfiguration?.externalWallets ?? []).includes(provider.id) &&
          provider.isAvailable?.() !== false,
      )
      const displayName = walletUi?.branding?.appName?.trim() || options.title || 'Altude'
      const headline = document.createElement('div')
      headline.className = otpStarted ? 'headline' : 'headline headline--hero'
      const title = document.createElement('h2')
      title.textContent = otpStarted
        ? otpChannel === 'email' ? 'Check your inbox' : 'Check your messages'
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
      if (otpStarted) {
        const identifier = document.createElement('strong')
        identifier.textContent = otpIdentifier
        intro.append('We sent a code to ', identifier, '.')
      } else {
        intro.textContent = walletUi?.branding?.tagline?.trim() ||
          (signInOptions.length > 0
            ? `Continue with ${joinWithOr(signInOptions)}.`
            : canUseLocalPasskey
              ? 'Create or open a local-only wallet below.'
            : 'No sign-in methods are configured for this wallet.')
      }
      headline.append(title, intro)
      content.append(headline)

      const hasIdentityAlternatives =
        socialProviders.length > 0 || canSignInWithPasskey || (smsOtpEnabled && otpChannel === 'email')
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
          if (busy || !isIdentityValid() || (otpChannel === 'sms' && !hasSmsConsent())) return
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
              message = ''
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
        identity.disabled = busy
        const submit = document.createElement('button')
        submit.className = 'magic-cta'
        submit.type = 'submit'
        submit.textContent = busy ? 'Sending code...' : 'Send code'
        submit.append(createIcon('forward'))
        const isIdentityValid = () =>
          otpChannel === 'email'
            ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.value.trim())
            : /^\+?[\d\s().-]{7,}$/.test(identity.value.trim())
        const updateSubmit = () => {
          submit.disabled = busy || !isIdentityValid() || (otpChannel === 'sms' && !hasSmsConsent())
        }
        updateSubmit()
        identity.addEventListener('input', () => {
          if (otpIdentifier !== identity.value) {
            smsConsent = false
            const checkbox = content.querySelector<HTMLInputElement>('.sms-consent input')
            if (checkbox) checkbox.checked = false
          }
          otpIdentifier = identity.value
          updateSubmit()
        })
        form.append(fieldIcon, identity, submit)
        content.append(form)
        if (otpChannel === 'sms') content.append(createSmsConsent(updateSubmit))
        const channelSwitch = button(
          otpChannel === 'email' ? 'Use a text message instead' : 'Use email instead',
          () => {
            otpChannel = otpChannel === 'email' ? 'sms' : 'email'
            otpIdentifier = ''
            smsConsent = false
            errorMessage = ''
            message = ''
            render()
          },
          true,
        )
        channelSwitch.classList.add('channel-switch-button')
        if (otpChannel === 'sms' && emailOtpEnabled) {
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
          const normalized = normalizeProviderId(provider)
          const labelText = normalized === 'google' ? 'Google' : normalized === 'apple' ? 'Apple' : provider
          const control = button(
            `Continue with ${labelText}`,
            () =>
              run(() => wallet.signInWithSocial(provider), {
                loginAttempt: true,
                showProgress: true,
              }),
            true,
          )
          control.classList.add('provider-method')
          control.setAttribute('aria-label', `Continue with ${labelText}`)
          control.title = `Continue with ${labelText}`
          const label = document.createElement('span')
          label.className = 'method-label'
          label.textContent = `Continue with ${labelText}`
          const glyph = document.createElement('span')
          glyph.className = 'provider-glyph'
          glyph.setAttribute('aria-hidden', 'true')
          if (normalized === 'google' || normalized === 'apple') {
            glyph.innerHTML = iconSvg(normalized)
          } else {
            glyph.textContent = provider.trim().slice(0, 1).toUpperCase()
          }
          control.replaceChildren(glyph, label)
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
          passkey.setAttribute('aria-label', 'Use a passkey')
          passkey.title = 'Use a passkey'
          const label = document.createElement('span')
          label.className = 'method-label'
          label.textContent = 'Use a passkey'
          const glyph = document.createElement('span')
          glyph.className = 'provider-glyph passkey-glyph'
          glyph.setAttribute('aria-hidden', 'true')
          glyph.innerHTML = iconSvg('key')
          passkey.replaceChildren(glyph, label)
          methods.append(passkey)
        }
        if (smsOtpEnabled && otpChannel === 'email') {
          const phone = button('Continue with phone', () => {
            otpChannel = 'sms'
            otpIdentifier = ''
            smsConsent = false
            errorMessage = ''
            message = ''
            render()
            panel.querySelector<HTMLInputElement>('.magic input')?.focus()
          }, true)
          phone.setAttribute('aria-label', 'Continue with phone')
          phone.title = 'Continue with phone'
          phone.classList.add('phone-method')
          const glyph = createIcon('phone')
          glyph.className = 'provider-glyph'
          const label = document.createElement('span')
          label.className = 'method-label'
          label.textContent = 'Continue with phone'
          phone.replaceChildren(glyph, label)
          methods.append(phone)
        }
        content.append(methods)
      }
      if (!otpStarted && canUseLocalPasskey) {
        const local = document.createElement('section')
        local.className = 'local-wallet'
        local.setAttribute('aria-label', 'Local-only wallet')
        const heading = document.createElement('h3')
        heading.textContent = 'Local-only wallet'
        const description = document.createElement('p')
        description.textContent = 'Stored in this browser and protected by a passkey. This does not sign you in to an Altude API session.'
        const create = button('Create local wallet', () => {
          if (!wallet.canUseLocalPasskey) return
          return run(async () => {
            await wallet.createLocalWallet()
            localHandle = ''
          })
        }, true)
        const form = document.createElement('form')
        form.className = 'local-wallet-return'
        const label = document.createElement('label')
        label.textContent = 'Local wallet handle'
        const input = document.createElement('input')
        input.type = 'text'
        input.autocomplete = 'off'
        input.spellcheck = false
        input.value = localHandle
        input.placeholder = 'Paste your saved local wallet handle'
        const open = document.createElement('button')
        open.type = 'submit'
        open.className = 'secondary'
        open.textContent = 'Open local wallet'
        open.disabled = busy || !localHandle.trim()
        input.addEventListener('input', () => {
          localHandle = input.value
          open.disabled = busy || !localHandle.trim()
        })
        form.addEventListener('submit', (event) => {
          event.preventDefault()
          const handle = input.value.trim()
          if (busy || !handle || !wallet.canUseLocalPasskey) return
          void run(async () => {
            await wallet.openLocalWallet(handle)
            localHandle = ''
          })
        })
        label.append(input)
        form.append(label, open)
        local.append(heading, description, create, form)
        content.append(local)
      }
      if (!otpStarted && externalWalletProviders.length > 0) {
        if (canStartOtp || hasIdentityAlternatives) {
          const divider = document.createElement('div')
          divider.className = 'or-divider'
          const label = document.createElement('span')
          label.textContent = 'or'
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
          const providerIcon = document.createElement('div')
          providerIcon.innerHTML = web3icon(provider.label)
          providerIcon.className = 'wallet-provider-icon'
          providerIcon.dataset.provider = provider.id
          providerIcon.setAttribute('aria-hidden', 'true')
          //providerIcon.textContent = provider.label.slice(0, 1).toUpperCase()
          const providerName = document.createElement('span')
          providerName.className = 'wallet-provider-name'
          providerName.textContent = provider.label
          const providerStatus = document.createElement('span')
          providerStatus.className = 'wallet-provider-status'
          const available = provider.isAvailable?.()
          providerButton.disabled = available === false
          providerStatus.textContent =
            provider.id === 'walletconnect'
              ? 'QR & mobile'
              : available === true
                ? 'Detected'
                : available === false
                  ? 'Not detected'
                  : 'Ready to connect'
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
        const form = document.createElement('form')
        form.className = 'otp-form'
        const fields = document.createElement('div')
        fields.className = 'otp-fields'
        fields.setAttribute('role', 'group')
        fields.setAttribute('aria-label', 'Six-digit verification code')
        const verify = document.createElement('button')
        verify.type = 'submit'
        verify.textContent = 'Verify and continue'
        verify.hidden = true
        verify.disabled = !otpDigits.every((digit) => /^[0-9]$/.test(digit))
        const submitCode = () => {
          if (!otpDigits.every((digit) => /^[0-9]$/.test(digit))) return
          const code = otpDigits.join('')
          void run(
            async () => {
              await wallet.verifyOtp(otpChannel, otpIdentifier, code)
              otpStarted = false
              otpDigits = Array<string>(6).fill('')
            },
            {
              showProgress: true,
            },
          )
        }
        form.addEventListener('submit', (event) => {
          event.preventDefault()
          submitCode()
        })
        const inputs: HTMLInputElement[] = []
        const enterDigits = (index: number, value: string) => {
          const digits = value.replace(/[^0-9]/g, '').slice(0, 6)
          const start = digits.length === 6 ? 0 : index
          if (!digits) otpDigits[index] = ''
          for (let offset = 0; offset < digits.length && start + offset < 6; offset++) {
            otpDigits[start + offset] = digits.charAt(offset)
          }
          inputs.forEach((field, position) => {
            field.value = otpDigits[position] ?? ''
          })
          verify.disabled = !otpDigits.every((digit) => /^[0-9]$/.test(digit))
          if (digits) inputs[Math.min(start + digits.length, 5)]?.focus()
          if (!verify.disabled) submitCode()
        }
        for (let index = 0; index < 6; index++) {
          const digit = document.createElement('input')
          digit.type = 'text'
          digit.inputMode = 'numeric'
          digit.maxLength = 1
          digit.pattern = '[0-9]'
          digit.required = true
          digit.disabled = busy
          digit.autocomplete = index === 0 ? 'one-time-code' : 'off'
          digit.setAttribute('aria-label', `Digit ${String(index + 1)} of 6`)
          digit.value = otpDigits[index] ?? ''
          digit.addEventListener('focus', () => {
            digit.select()
          })
          digit.addEventListener('input', () => {
            enterDigits(index, digit.value)
          })
          digit.addEventListener('paste', (event) => {
            const text = event.clipboardData?.getData('text')
            if (text === undefined) return
            event.preventDefault()
            enterDigits(index, text)
          })
          digit.addEventListener('keydown', (event) => {
            if (event.key === 'Backspace') {
              event.preventDefault()
              const target = otpDigits[index] || index === 0 ? index : index - 1
              otpDigits[target] = ''
              const field = inputs[target]
              if (field) {
                field.value = ''
                field.focus()
              }
              verify.disabled = true
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault()
              inputs[index + (event.key === 'ArrowLeft' ? -1 : 1)]?.focus()
            }
          })
          inputs.push(digit)
          fields.append(digit)
        }
        form.append(fields, verify)
        content.append(form)
        const resend = document.createElement('div')
        resend.className = 'otp-resend'
        const resendButton = button('Resend code', () => run(async () => {
          if (otpChannel === 'sms' && !hasSmsConsent()) return
          await wallet.startOtp(otpChannel, otpIdentifier)
          otpDigits = Array<string>(6).fill('')
          message = `We sent a fresh code to your ${otpChannel === 'email' ? 'inbox' : 'phone'}.`
        }), false, busy || (otpChannel === 'sms' && !hasSmsConsent()))
        if (otpChannel === 'sms') {
          content.append(createSmsConsent(() => {
            resendButton.disabled = busy || !hasSmsConsent()
          }))
        }
        resend.append("Didn't get it?", resendButton)
        content.append(resend)
      }
    } else if (state.status === 'connected' && (state.custody === 'embedded' || state.custody === 'local')) {
      const address = state.address
      const identity = document.createElement('div')
      identity.className = 'account-identity'
      const avatar = document.createElement('span')
      avatar.className = 'account-avatar'
      avatar.setAttribute('aria-hidden', 'true')
      const contact =
        state.session?.user.email || state.session?.user.phoneNumber ||
        (state.custody === 'local' ? 'Local wallet' : 'Wallet account')
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
      if (state.custody === 'local') {
        const notice = document.createElement('p')
        notice.className = 'note'
        notice.textContent = 'Local-only wallet: no Altude API session is authenticated. Save the handle to reopen this wallet in this browser; it is not a recovery backup.'
        content.append(notice)
      }

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
          value.textContent =
            options.title?.trim() || options.walletUi?.branding?.appName?.trim() || 'Altude'
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
      if (state.custody === 'local' && state.localIdentityKey) {
        const handle = state.localIdentityKey
        const handleCard = document.createElement('div')
        handleCard.className = 'status-card'
        const label = document.createElement('p')
        label.className = 'status-label'
        label.textContent = 'Local wallet handle'
        const value = document.createElement('p')
        value.className = 'status local-handle'
        value.textContent = handle
        const copy = button('Copy local wallet handle', () => run(async () => {
          await navigator.clipboard.writeText(handle)
          message = 'Local wallet handle copied.'
        }), true)
        handleCard.append(label, value, copy)
        content.append(handleCard)
      }

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
      const walletActions = document.createElement('div')
      walletActions.className = 'actions'
      walletActions.append(createBalanceForm())
      if (state.protection === 'device-local' && wallet.canUseLocalPasskey) {
        walletActions.append(button('Protect with passkey', () => run(() => wallet.protectWithPasskey()), true))
      }
      walletActions.append(
        button('Lock wallet', () => { wallet.lock(); }, true),
        button('Create token account', requestProvisioning, true, provisioningRequested || provisioning.size > 0),
      )
      content.append(walletActions)
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
          actions.append(createBalanceForm())
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
      for (const { event: request } of provisioning.values()) {
        const confirmation = document.createElement('div')
        confirmation.className = 'confirm'
        confirmation.setAttribute('role', 'group')
        confirmation.setAttribute('aria-label', `Token account confirmation ${request.id}`)
        const summary = document.createElement('p')
        summary.textContent = `Create token accounts on ${request.network === 'mainnet-beta' ? 'mainnet' : request.network} for ${request.tokens.length > 0 ? request.tokens.join(', ') : 'the configured tokens'}?`
        confirmation.append(
          summary,
          button('Confirm and create', () => submitProvisioning(request.id), false, provisioningSubmitting.has(request.id)),
          button('Cancel', () => {
            if (!provisioning.has(request.id) || provisioningSubmitting.has(request.id)) return
            provisioning.delete(request.id)
            wallet.rejectProvisioning(request.id)
            render()
          }, true, provisioningSubmitting.has(request.id)),
        )
        content.append(confirmation)
      }
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
        const network = document.createElement('p')
        network.textContent = `Network: ${transaction.intent.network ?? 'unavailable'}`
        confirmation.append(
          summary,
          network,
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
    if (state.status === 'disconnected' && !otpStarted && !loginErrorMessage && !loginProgressStage) {
      const trustRow = document.createElement('div')
      trustRow.className = 'trust-row'
      const verifiedBadges = options.walletUi?.trust
      const custody = document.createElement('span')
      custody.textContent = wallet.canStartOtp
        ? 'Embedded wallet keys stay in this browser.'
        : 'Your wallet stays in your control.'
      custody.prepend(createIcon('shield'))
      trustRow.append(custody)
      if (verifiedBadges?.ikaRecoveryVerified === true) {
        const recovery = document.createElement('span')
        recovery.textContent = 'Secure recovery by Ika'
        trustRow.append(recovery)
      }
      if (verifiedBadges?.soc2Verified === true) {
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
    footer.append(createIcon('shield'), footerText)
    panel.append(footer)
    const legalUrls = [
      ['Terms', legalConfiguration()?.termsUrl],
      ['Privacy', legalConfiguration()?.privacyUrl],
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
    if (busy) {
      for (const control of panel.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
        'input,button:not([aria-label="Close wallet"])',
      )) {
        control.disabled = true
      }
    }
    if (focusFirst || (presentation === 'modal' && hadFocus)) {
      const firstDigit = panel.querySelector<HTMLInputElement>('.otp-fields input:not(:disabled)')
      if (firstDigit) {
        firstDigit.focus()
        return
      }
      ;(getFocusableControls(panel)[0] ?? panel).focus()
    }
  }

  function createSmsConsent(onChange: () => void): HTMLElement {
    const text = smsConsentText()
    if (!text) {
      const notice = document.createElement('p')
      notice.className = 'note'
      notice.textContent = 'SMS sign-in requires configured consent text.'
      return notice
    }
    const label = document.createElement('label')
    label.className = 'sms-consent'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = smsConsent
    checkbox.disabled = busy
    checkbox.addEventListener('change', () => {
      smsConsent = checkbox.checked
      onChange()
    })
    const copy = document.createElement('span')
    copy.textContent = text
    label.append(checkbox, copy)
    return label
  }

  function createBalanceForm(): HTMLFormElement {
    const form = document.createElement('form')
    form.className = 'balance-form'
    const label = document.createElement('label')
    label.textContent = 'Token mint (optional; leave empty for SOL)'
    const input = document.createElement('input')
    input.type = 'text'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.value = tokenMint
    input.addEventListener('input', () => { tokenMint = input.value })
    const check = document.createElement('button')
    check.type = 'submit'
    check.className = 'secondary'
    check.textContent = 'Check balance'
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const mint = input.value.trim()
      const owner = ownerOf(wallet.state)
      void run(async () => {
        const balance = await wallet.getBalance(mint || undefined)
        if (owner !== ownerOf(wallet.state)) return
        message = mint
          ? `Balance: ${String(balance.uiAmount ?? 'unavailable')} tokens (mint: ${mint})`
          : `Balance: ${String(balance.uiAmount ?? 'unavailable')} SOL`
      })
    })
    label.append(input)
    form.append(label, check)
    return form
  }

  async function requestProvisioning(): Promise<void> {
    if (busy || provisioningRequested || provisioning.size > 0) return
    const owner = ownerOf(wallet.state)
    const controller = new AbortController()
    provisioningController = controller
    provisioningRequested = true
    errorMessage = ''
    message = ''
    render()
    try {
      await wallet.createAccount([], controller.signal)
    } catch (error) {
      if (mounted && ownerOf(wallet.state) === owner) {
        errorMessage = error instanceof Error ? error.message : String(error)
      }
    } finally {
      provisioningRequested = false
      if (provisioningController === controller) provisioningController = null
      render()
    }
  }

  async function submitProvisioning(id: string): Promise<void> {
    const request = provisioning.get(id)
    if (!request || request.owner !== ownerOf(wallet.state) ||
      wallet.state.status !== 'connected' || provisioningSubmitting.has(id)) return
    provisioningSubmitting.add(id)
    errorMessage = ''
    message = ''
    render()
    try {
      await wallet.approveProvisioning(id)
      provisioning.delete(id)
    } catch (error) {
      if (provisioning.delete(id)) {
        errorMessage = error instanceof Error ? error.message : String(error)
      }
    } finally {
      provisioningSubmitting.delete(id)
      render()
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
        otpDigits = Array<string>(6).fill('')
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

  render(presentation === 'modal')
  if (typeof wallet.getPasskeyAvailability === 'function') {
    void wallet.getPasskeyAvailability().then(() => {
      render()
    }).catch((error: unknown) => {
      if (!mounted) return
      errorMessage = error instanceof Error ? error.message : String(error)
      render()
    })
  }
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
    if (provisioningSubmitting.size === 0) provisioningController?.abort()
    for (const id of provisioning.keys()) {
      if (!provisioningSubmitting.has(id)) wallet.rejectProvisioning(id)
    }
    provisioning.clear()
    events()
    root.remove()
    if (previousFocus instanceof HTMLElement) previousFocus.focus()
  }
}

function getFocusableControls(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(
    'a[href],button,input,select,textarea,[tabindex],[contenteditable="true"]',
  )].filter((element) => {
    if ((element.hasAttribute('tabindex') && element.tabIndex < 0) || element.matches(':disabled,input[type="hidden"]') ||
      element.closest('[hidden],[inert],[aria-hidden="true"]')) return false
    for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
      if (ancestor === panel) break
    }
    return true
  })
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
    | 'forward'
    | 'google'
    | 'apple'
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
  if (icon === 'google') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.5 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.75h3.57c2.08-1.92 3.22-4.74 3.22-8.3z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.75c-.99.66-2.25 1.06-3.71 1.06-2.85 0-5.27-1.92-6.13-4.51H2.18v2.83C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.87 14.14c-.22-.66-.34-1.36-.34-2.09 0-.73.12-1.43.34-2.09V7.13H2.18C1.43 8.61 1 10.26 1 12c0 1.74.43 3.39 1.18 4.87l3.69-2.73z"/><path fill="#EA4335" d="M12 5.4c1.62 0 3.07.56 4.21 1.65l3.16-3.16C17.45 2.09 14.96 1 12 1 7.7 1 3.99 3.47 2.18 7.13l3.69 2.83C6.73 7.32 9.15 5.4 12 5.4z"/></svg>'
  }
  if (icon === 'apple') {
    return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.36 12.55c-.02-2.24 1.83-3.32 1.91-3.37-1.04-1.52-2.66-1.73-3.24-1.76-1.38-.14-2.7.81-3.4.81-.71 0-1.79-.79-2.95-.77-1.51.02-2.92.88-3.7 2.23-1.58 2.74-.4 6.79 1.13 9 .75 1.08 1.65 2.3 2.83 2.25 1.14-.05 1.57-.73 2.95-.73 1.38 0 1.77.73 2.97.71 1.23-.02 2.01-1.1 2.76-2.19.87-1.26 1.23-2.48 1.25-2.55-.03-.01-2.39-.92-2.51-3.63zM14.13 5.7c.63-.76 1.05-1.82.94-2.87-.91.04-2.01.6-2.66 1.36-.58.67-1.09 1.75-.95 2.79 1.01.08 2.04-.51 2.67-1.28z"/></svg>'
  }
  const paths = {
    back: '<path d="m15 18-6-6 6-6"/><path d="M9 12h12"/>',
    forward: '<path d="m9 6 6 6-6 6"/><path d="M3 12h12"/>',
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

function web3icon(
  web3icon:string,
): string {
  
  const icontHtmlString = '';
  if(web3icon.toLowerCase() == 'metamask')
    return '<svg viewBox="0 0 40 38" width="26" height="26" aria-hidden="true">' +
                              '<path fill="#E17726" stroke="#E17726" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round" d="m36.9 1-14.6 10.8 2.7-6.4z"/>' +      
                              '<path fill="#E27625" stroke="#E27625" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round" d="m3.1 1 14.5 10.9-2.6-6.5zM31.5 27.1l-3.9 6 8.4 2.3 2.4-8.1zM1.7 27.3l2.4 8.1 8.3-2.3-3.8-6z"/>' +
                              '<path fill="#E27625" stroke="#E27625" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round" d="m11.9 17.1-2.3 3.5 8.3.4-.3-9zM28.1 17.1l-5.8-5.2-.2 9.1 8.3-.4zM12.4 33.1l5-2.4-4.3-3.4zM22.6 30.7l5 2.4-.7-5.8z"/>' +
                              '<path fill="#D5BFB2" stroke="#D5BFB2" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round" d="m27.6 33.1-5-2.4.4 3.3v1.4zM12.4 33.1l4.6 2.3v-1.4l.4-3.3z"/>' +
                              '<path fill="#233447" stroke="#233447" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round" d="m17.1 24.8-4.1-1.2 2.9-1.3zM22.9 24.8l1.2-2.5 2.9 1.3z"/>' +
                              '<path fill="#CC6228" stroke="#CC6228" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round" d="m12.4 33.1.7-6-4.6.1zM26.9 27.1l.7 6 3.9-5.9zM30.4 20.6l-8.3.4.8 4.2 1.2-2.5 2.9 1.3zM13 23.6l2.9-1.3 1.2 2.5.8-4.2-8.3-.4z"/>' +
                              '<path fill="#E27525" stroke="#E27525" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round" d="m9.6 20.6 3.5 6.8-.1-3.4zM27.1 24l-.2 3.4 3.5-6.8zM17.9 21l-.8 4.2 1 5.3.2-7zM22.1 21l-.4 2.5.2 7 1-5.3z"/>' +
                              '<path fill="#F5841F" stroke="#F5841F" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round" d="m22.9 24.8-1 5.3.7.5 4.3-3.4.2-3.4zM13 23.6l.1 3.4 4.3 3.4.7-.5-1-5.3z"/>' +
                              '<path fill="#C0AC9D" stroke="#C0AC9D" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round" d="m23 35.4v-1.4l-.4-.3h-5.2l-.4.3v1.4l-4.6-2.3 1.6 1.3 3.3 2.3h5.3l3.3-2.3 1.6-1.3z"/>' +
                              '<path fill="#763E1A" stroke="#763E1A" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round" d="m37.5 11.8 1.2-6-1.8-5.5-13.4 9.9 5.2 4.4 7.3 2.1 1.6-1.9-.7-.5 1.1-1-.8-.6 1.1-.9zM1.3 5.8l1.3 6-.8.6 1.1.9-.8.6 1.1 1-.7.5 1.6 1.9 7.3-2.1 5.2-4.4L3.1.3z"/>' +
                              '<path fill="#F5841F" stroke="#F5841F" stroke-width=".25" stroke-linecap="round" stroke-linejoin="round" d="m35.8 18.2-7.3-2.1 2.2 3.3-3.3 6.4 4.4-.1h6.5zM11.5 16.1l-7.3 2.1-2.4 7.5h6.5l4.3.1-3.2-6.4zM22.1 21l.5-8-2.1-5.7h-1L17.4 13l.5 8 .2 2.6v6.9h3.8l.2-6.9z"/>' +
                            '</svg>'
  if(web3icon.toLowerCase() == 'phantom')
    return '<svg viewBox="0 0 128 128" width="26" height="26" aria-hidden="true">'+
                              '<rect width="128" height="128" rx="28" fill="#AB9FF2"/>' +
                              '<path fill="#FFFDF8" d="M110.6 64.9h-9.9c0-20.3-16.4-36.9-36.8-36.9-20.1 0-36.5 16.2-36.9 36.2C26.6 84.9 45 105 65.4 105h2.6c17.9 0 41.9-14 45.6-31 .7-3.1-1.6-9.1-3-9.1zM52.5 66c0 2.8-2.3 5-5 5s-5-2.3-5-5 2.3-5.1 5-5.1 5 2.3 5 5.1zm17.3 0c0 2.8-2.3 5-5 5s-5-2.3-5-5 2.3-5.1 5-5.1 5 2.3 5 5.1z"/>' +
                            '</svg>'
  return icontHtmlString;
}

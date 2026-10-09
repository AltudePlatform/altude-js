export { AltudeWallet } from './wallet.js'
export { AltudeWalletError } from './errors.js'
export {
  IndexedDbWalletStore,
  MemorySessionTokenStore,
  BrowserSessionTokenStore,
} from './storage.js'
export { BrowserPasskeyAdapter } from './passkeys.js'
export { mountWalletUI } from './ui.js'
export {
  WALLET_EMBED_CHANNEL,
  WALLET_EMBED_VERSION,
  WalletEmbedProvider,
  createIframeWalletTransport,
} from './embed.js'
export type {
  AltudeWalletConfig,
  OtpChannel,
  PasskeyAdapter,
  SessionTokenStore,
  WalletAuthProvider,
  WalletEvent,
  WalletIdentityToken,
  WalletProtection,
  WalletSession,
  WalletState,
  WalletStore,
  WalletStoreRecord,
  WalletTransactionIntent,
  WalletTransactionResult,
  WalletTransferHistory,
  WalletTransferHistoryOptions,
  WalletUiOptions,
  WalletUser,
} from './types.js'
export type {
  EmbeddedWalletState,
  WalletEmbedEnvelope,
  WalletEmbedEvent,
  WalletEmbedMessageType,
  WalletEmbedProviderOptions,
  WalletEmbedTransport,
} from './embed.js'
export type { WalletErrorCode } from './errors.js'

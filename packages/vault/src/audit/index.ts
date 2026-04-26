/**
 * Append-only audit log — JSONL format.
 *
 * Written to ~/.ows/logs/audit.jsonl on every:
 *  - sign operation
 *  - key creation
 *  - key revocation
 *
 * Reference: OWS storage format spec §Vault Directory Structure
 */

import type { NodeVaultStorage } from '../storage/index.js'

export type AuditEventType =
  | 'sign'
  | 'sign_message'
  | 'sign_and_send'
  | 'key_created'
  | 'key_revoked'
  | 'wallet_created'
  | 'wallet_deleted'
  | 'wallet_exported'

export interface AuditLogEntry {
  timestamp: string // ISO 8601
  event: AuditEventType
  wallet_id?: string
  key_id?: string
  chain_id?: string
  success: boolean
  error_code?: string
}

export async function appendAuditLog(
  storage: NodeVaultStorage,
  entry: AuditLogEntry,
): Promise<void> {
  const logPath = storage.auditLogPath()
  const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n'

  // Read existing log (or start fresh)
  const existing = await storage.read(logPath)
  await storage.write(logPath, (existing ?? '') + line)
}

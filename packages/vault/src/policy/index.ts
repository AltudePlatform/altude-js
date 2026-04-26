/**
 * OWS Policy Engine — TypeScript implementation.
 *
 * Implements declarative policy rule evaluation and custom executable policies.
 * Reference: https://github.com/AltudePlatform/OWS-core/blob/main/docs/03-policy-engine.md
 *
 * Access model:
 *   - Owner (passphrase): no policy evaluation, full access
 *   - Agent (API token): all attached policies evaluated with AND semantics
 */

import type { OWSPolicy, PolicyContext, PolicyRule } from '@altude/core'
import { policyDenied } from '@altude/core'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PolicyResult = 'allow' | 'deny'

export interface ExecutablePolicyResult {
  allow: boolean
  reason?: string
}

// ---------------------------------------------------------------------------
// Main policy evaluation entry point
// ---------------------------------------------------------------------------

/**
 * Evaluate all policies against a context.
 * AND semantics: every policy must allow; first denial short-circuits.
 */
export async function evaluatePolicies(
  policies: OWSPolicy[],
  context: PolicyContext,
  nodeOnly = false,
): Promise<void> {
  for (const policy of policies) {
    const result = await evaluatePolicy(policy, context, nodeOnly)
    if (result === 'deny') {
      throw policyDenied(
        `Policy "${policy.name}" (${policy.id}) denied the request`,
      )
    }
  }
}

/**
 * Evaluate a single policy against a context.
 */
export async function evaluatePolicy(
  policy: OWSPolicy,
  context: PolicyContext,
  nodeOnly = false,
): Promise<PolicyResult> {
  // 1. Evaluate declarative rules first (fast, in-process)
  const declarativeResult = evaluateDeclarativeRules(policy.rules, context)
  if (declarativeResult === 'deny') return 'deny'

  // 2. If an executable is configured (Node.js only), spawn and evaluate
  if (policy.executable && nodeOnly) {
    const execResult = await evaluateExecutablePolicy(policy.executable, context)
    if (!execResult.allow) return 'deny'
  }

  return 'allow'
}

// ---------------------------------------------------------------------------
// Declarative rule evaluation
// ---------------------------------------------------------------------------

function evaluateDeclarativeRules(rules: PolicyRule[], context: PolicyContext): PolicyResult {
  for (const rule of rules) {
    const result = evaluateRule(rule, context)
    if (result === 'deny') return 'deny'
  }
  return 'allow'
}

function evaluateRule(rule: PolicyRule, context: PolicyContext): PolicyResult {
  switch (rule.type) {
    case 'allowed_chains': {
      const normalizedContext = normalizeChainId(context.chain_id)
      const allowed = rule.chain_ids.some(
        (id) => normalizeChainId(id) === normalizedContext,
      )
      return allowed ? 'allow' : 'deny'
    }

    case 'expires_at': {
      const expiry = new Date(rule.timestamp).getTime()
      const now = new Date(context.timestamp).getTime()
      return now < expiry ? 'allow' : 'deny'
    }

    case 'allowed_typed_data_contracts': {
      // Solana has no typed data — always pass through
      // This rule only applies to EVM sign_typed_data calls
      return 'allow'
    }

    default:
      // Unknown rule type: fail safe (deny)
      return 'deny'
  }
}

// ---------------------------------------------------------------------------
// Custom executable policy (Node.js only)
// ---------------------------------------------------------------------------

async function evaluateExecutablePolicy(
  executablePath: string,
  context: PolicyContext,
): Promise<ExecutablePolicyResult> {
  const { spawn } = await import('node:child_process')

  return new Promise((resolve) => {
    const contextJson = JSON.stringify(context)
    const child = spawn(executablePath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    child.stdin.write(contextJson)
    child.stdin.end()

    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ allow: false, reason: `Policy executable exited with code ${code}: ${stderr}` })
        return
      }
      try {
        const result = JSON.parse(stdout.trim()) as ExecutablePolicyResult
        resolve(result)
      } catch {
        resolve({ allow: false, reason: `Policy executable produced invalid JSON: ${stdout}` })
      }
    })

    child.on('error', (err) => {
      resolve({ allow: false, reason: `Failed to spawn policy executable: ${err.message}` })
    })
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a chain ID for comparison.
 * Shorthand aliases like "solana" are expanded to their canonical CAIP-2 form.
 */
function normalizeChainId(chainId: string): string {
  const aliases: Record<string, string> = {
    solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  }
  return aliases[chainId] ?? chainId
}

/**
 * Unavailable Agent Adapter
 *
 * Stand-in LLMAdapter installed when the configured backend cannot connect
 * (typically: no credential configured). It keeps the server — and every
 * deterministic UI action (taps, forms, view filters) — running without an
 * LLM. Each chat turn answers with one explanatory message and ends; it never
 * requests a tool call, so nothing can mutate state through this adapter.
 *
 * The connect failure reason is logged by the server at boot; it is not
 * repeated to clients.
 */

import type { LLMAdapter, AgentEvent, AgentRequest, BackendConfig } from '../types.js'

export const AGENT_UNAVAILABLE_MESSAGE =
  'The AI assistant is unavailable on this server (the agent backend could not start). ' +
  'Buttons and forms still work. To enable the assistant, configure a credential ' +
  '(`task server:init`) and restart the server.'

export class UnavailableAgentAdapter implements LLMAdapter {
  async connect(_config: BackendConfig): Promise<void> {}

  async disconnect(): Promise<void> {}

  async *run(_request: AgentRequest): AsyncIterable<AgentEvent> {
    yield { type: 'text', text: AGENT_UNAVAILABLE_MESSAGE }
    yield { type: 'done' }
  }

  submitToolResult(): void {}

  async resetSession(): Promise<void> {}
}

import { describe, it, expect } from 'vitest'
import {
  UnavailableAgentAdapter,
  AGENT_UNAVAILABLE_MESSAGE,
} from '../../../../src/server/agent/unavailable/adapter.js'
import type { AgentEvent, AgentRequest } from '../../../../src/server/agent/types.js'

function request(): AgentRequest {
  return {
    conversationId: 'c1',
    message: 'add a task',
    mode: 'direct_user_chat',
    tools: [{ name: 'add_task', description: 'Add', parameters: {} }],
    context: {
      appId: 'todo',
      manifest: { id: 'todo', version: '0.0.0', name: 'Todo', icon: 'x', description: '' },
      turnMode: 'direct_user_chat',
    },
    cwd: '/tmp',
    sdkBound: false,
  }
}

describe('UnavailableAgentAdapter', () => {
  it('answers every turn with the explanatory message and ends', async () => {
    const adapter = new UnavailableAgentAdapter()
    await adapter.connect({ type: 'claude' })
    const events: AgentEvent[] = []
    for await (const ev of adapter.run(request())) events.push(ev)
    expect(events).toEqual([{ type: 'text', text: AGENT_UNAVAILABLE_MESSAGE }, { type: 'done' }])
  })

  it('never requests a tool call, even when tools are offered', async () => {
    const adapter = new UnavailableAgentAdapter()
    const events: AgentEvent[] = []
    for await (const ev of adapter.run(request())) events.push(ev)
    expect(events.some((e) => e.type === 'toolCall')).toBe(false)
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '../../src/stores/chat-store'

/** Re-sent server rows (same id) must not duplicate a thread; new ids still append. */
function msg(id: string, text = id) {
  return {
    id,
    role: 'assistant' as const,
    text,
    timestamp: '2026-01-01T00:00:00Z',
    status: 'sent' as const,
  }
}

describe('chat-store addMessage de-duplication', () => {
  beforeEach(() => {
    useChatStore.setState({ messagesByApp: new Map(), pendingByApp: new Map() })
  })

  it('ignores a message whose id is already in the thread', () => {
    const s = useChatStore.getState()
    s.addMessage('todo', msg('change-request-1'), 'dev')
    s.addMessage('todo', msg('change-request-1'), 'dev')
    expect(useChatStore.getState().getMessages('todo', 'dev')).toHaveLength(1)
  })

  it('still appends messages with new ids, per thread', () => {
    const s = useChatStore.getState()
    s.addMessage('todo', msg('a'), 'dev')
    s.addMessage('todo', msg('b'), 'dev')
    s.addMessage('todo', msg('a'), 'chat')
    expect(
      useChatStore
        .getState()
        .getMessages('todo', 'dev')
        .map((m) => m.id),
    ).toEqual(['a', 'b'])
    expect(useChatStore.getState().getMessages('todo', 'chat')).toHaveLength(1)
  })
})

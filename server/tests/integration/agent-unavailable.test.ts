/**
 * Agent-unavailable boot: when the configured backend cannot connect (no
 * credential), the server still starts, deterministic UI tool invocations
 * still run, and chat answers with an explanatory message. When a credential
 * IS configured, the Claude adapter is still selected (old behaviour).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'net'
import { create } from '@bufbuild/protobuf'
import {
  ChatRole,
  ClientMessageSchema,
  DeviceClass,
  DeviceShape,
} from '@moumantai/protocol/generated/moumantai/v1'
import { createAdapter, createAppServer, type ServerComponents } from '../../src/server/main.js'
import { loadConfig } from '../../src/server/config.js'
import { ClaudeAgentAdapter } from '../../src/server/agent/claude/adapter.js'
import {
  UnavailableAgentAdapter,
  AGENT_UNAVAILABLE_MESSAGE,
} from '../../src/server/agent/unavailable/adapter.js'
import { notes } from '../fixtures/test-app/schema.js'
import { TestClient, waitFor } from '../helpers/test-client.js'

const CREDENTIAL_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const
const savedEnv: Record<string, string | undefined> = {}

function clearCredentials(): void {
  for (const k of CREDENTIAL_VARS) delete process.env[k]
}

beforeAll(() => {
  for (const k of CREDENTIAL_VARS) savedEnv[k] = process.env[k]
  clearCredentials()
})

afterAll(() => {
  for (const k of CREDENTIAL_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

function tmpHome(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe('createAdapter', () => {
  it('falls back to UnavailableAgentAdapter when the claude backend has no credential', async () => {
    clearCredentials()
    const config = {
      ...loadConfig({ home: tmpHome('moumantai-noagent-') }),
      backend: 'claude' as const,
    }
    delete config.anthropicApiKey
    const adapter = await createAdapter(config)
    expect(adapter).toBeInstanceOf(UnavailableAgentAdapter)
  })

  it('still selects ClaudeAgentAdapter when a credential is configured', async () => {
    clearCredentials()
    const config = {
      ...loadConfig({ home: tmpHome('moumantai-withagent-') }),
      backend: 'claude' as const,
      anthropicApiKey: 'sk-ant-api03-test-not-a-real-key',
    }
    try {
      const adapter = await createAdapter(config)
      expect(adapter).toBeInstanceOf(ClaudeAgentAdapter)
    } finally {
      clearCredentials() // connect() exports the key into process.env
    }
  })
})

describe('server without a credential', () => {
  let components: ServerComponents
  let port: number

  beforeAll(async () => {
    clearCredentials()
    components = await createAppServer({
      port: 0,
      home: tmpHome('moumantai-noagent-server-'),
      appDirs: ['tests/fixtures'],
      backend: 'claude',
      anthropicApiKey: undefined,
    })
    await new Promise<void>((resolve) => {
      components.httpServer.listen(0, '127.0.0.1', () => {
        port = (components.httpServer.address() as AddressInfo).port
        resolve()
      })
    })
  }, 15_000)

  afterAll(async () => {
    components.appEngine.shutdown()
    await components.wsServer.close()
    await components.adapter.disconnect()
    await new Promise<void>((resolve, reject) => {
      components.httpServer.close((err) => (err ? reject(err) : resolve()))
    })
  }, 10_000)

  async function connect(): Promise<TestClient> {
    const c = await TestClient.connect(port, {
      hello: {
        deviceClass: DeviceClass.PHONE,
        deviceProfile: { width: 390, height: 844, shape: DeviceShape.RECT },
      },
    })
    c.send(
      create(ClientMessageSchema, {
        payload: { case: 'viewing', value: { scope: 'app:test-app' } },
      }),
    )
    await waitFor(c.received, (buf) =>
      buf.some((m) => m.payload.case === 'faceList' && m.payload.value.appId === 'test-app'),
    )
    return c
  }

  it('boots with the unavailable adapter', () => {
    expect(components.adapter).toBeInstanceOf(UnavailableAgentAdapter)
  })

  it('runs a UI tool invocation without an agent', async () => {
    const c = await connect()
    try {
      const content = `offline-note-${Date.now()}`
      c.send(
        create(ClientMessageSchema, {
          payload: {
            case: 'invokeTool',
            value: {
              toolName: 'add_note',
              args: { content, category: 'work' },
              sourceFaceId: 'notes-list',
              clientRequestId: crypto.randomUUID(),
            },
          },
        }),
      )
      const db = (await components.appEngine.use('test-app')).db
      const row = await waitFor(c.received, () =>
        db
          .select()
          .from(notes)
          .all()
          .find((r) => r.content === content),
      )
      expect(row.category).toBe('work')
    } finally {
      c.close()
    }
  })

  it('answers chat with the explanatory message instead of failing', async () => {
    const c = await connect()
    try {
      c.send(
        create(ClientMessageSchema, {
          payload: { case: 'chatInput', value: { scope: 'app:test-app', text: 'add a note' } },
        }),
      )
      const reply = await waitFor(c.received, (buf) =>
        buf.find((m) => m.payload.case === 'chat' && m.payload.value.role === ChatRole.ASSISTANT),
      )
      if (reply.payload.case !== 'chat') throw new Error('unreachable')
      expect(reply.payload.value.text).toBe(AGENT_UNAVAILABLE_MESSAGE)
    } finally {
      c.close()
    }
  })
})

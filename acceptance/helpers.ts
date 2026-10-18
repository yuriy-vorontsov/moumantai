/**
 * Acceptance-test harness: a real `createAppServer` with only the named apps
 * installed, a real WebSocket client, and a scripted spy adapter that records
 * every agent turn and tool result.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'net'
import { create } from '@bufbuild/protobuf'
import {
  ChatKind,
  ClientMessageSchema,
  DeviceClass,
  DeviceShape,
  type ServerMessage,
} from '@moumantai/protocol/generated/moumantai/v1'
import {
  createAppServer,
  type CreateAppServerOpts,
  type ServerComponents,
} from '../server/src/server/main.js'
import type {
  AgentEvent,
  AgentRequest,
  BackendConfig,
  LLMAdapter,
  ToolResult,
} from '../server/src/server/agent/types.js'
import { TestClient, waitFor as baseWaitFor } from '../server/tests/helpers/test-client.js'

export { TestClient }

/** Poll until `pred` returns a value (not undefined/null/false); resolves with it. */
export async function waitFor<T>(
  buf: ServerMessage[],
  pred: (buf: ServerMessage[]) => T | undefined | null | false,
  timeoutMs = 5000,
): Promise<T> {
  return (await baseWaitFor(buf, (b) => pred(b) ?? false, timeoutMs)) as T
}

const REPO_APPS = path.resolve(__dirname, '..', 'apps')

export interface RunningServer {
  components: ServerComponents
  port: number
  stop(): Promise<void>
}

/** Boot a server with a fresh home and only `appIds` (copied from apps/) installed. */
export async function startServer(
  appIds: string[],
  opts: CreateAppServerOpts = {},
): Promise<RunningServer> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mutabl-acceptance-'))
  const appsDir = path.join(root, 'apps-src')
  fs.mkdirSync(appsDir)
  // Copy (not symlink): a promote in a test must never write into the repo.
  for (const id of appIds) {
    fs.cpSync(path.join(REPO_APPS, id), path.join(appsDir, id), {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}node_modules`),
    })
  }

  const components = await createAppServer({
    port: 0,
    home: path.join(root, 'home'),
    appDirs: [appsDir],
    ...opts,
  })
  const port = await new Promise<number>((resolve) => {
    components.httpServer.listen(0, '127.0.0.1', () => {
      resolve((components.httpServer.address() as AddressInfo).port)
    })
  })
  return {
    components,
    port,
    async stop() {
      components.appEngine.shutdown()
      await components.wsServer.close()
      await components.adapter.disconnect()
      await new Promise<void>((resolve, reject) => {
        components.httpServer.close((err) => (err ? reject(err) : resolve()))
      })
    },
  }
}

/** Connect a phone client and focus it on `appId` (so UI invocations route there). */
export async function connectTo(
  port: number,
  appId: string,
  deviceId?: string,
): Promise<TestClient> {
  const c = await TestClient.connect(port, {
    hello: {
      deviceClass: DeviceClass.PHONE,
      deviceProfile: { width: 390, height: 844, shape: DeviceShape.RECT },
      ...(deviceId ? { deviceId } : {}),
    },
  })
  c.send(
    create(ClientMessageSchema, { payload: { case: 'viewing', value: { scope: `app:${appId}` } } }),
  )
  await waitFor(c.received, (buf) =>
    buf.some((m) => m.payload.case === 'faceList' && m.payload.value.appId === appId),
  )
  return c
}

/** What a UI tap / form submit sends: an InvokeToolMsg with explicit args. */
export function invokeTool(
  c: TestClient,
  toolName: string,
  args: Record<string, unknown>,
  sourceFaceId = 'compose',
): void {
  c.send(
    create(ClientMessageSchema, {
      payload: {
        case: 'invokeTool',
        value: {
          toolName,
          args: args as never,
          sourceFaceId,
          clientRequestId: crypto.randomUUID(),
        },
      },
    }),
  )
}

/** Send a chat message; `dev` = the Developer Mode (edit-agent) thread. */
export function chat(c: TestClient, appId: string, text: string, dev = false): void {
  c.send(
    create(ClientMessageSchema, {
      payload: {
        case: 'chatInput',
        value: { scope: `app:${appId}`, text, ...(dev ? { kind: ChatKind.DEV } : {}) },
      },
    }),
  )
}

/**
 * Deterministic stand-in for the LLM: each `run()` replays the queued script
 * (tool calls block until the server submits the result, like the real
 * adapters). Records every turn and every tool result for assertions.
 */
export class SpyAgentAdapter implements LLMAdapter {
  readonly turns: AgentRequest[] = []
  readonly toolResults: ToolResult[] = []
  private script: AgentEvent[] = []
  private pending = new Map<string, (r: ToolResult) => void>()

  queue(events: AgentEvent[]): void {
    this.script = events
  }

  async connect(_config: BackendConfig): Promise<void> {}
  async disconnect(): Promise<void> {}
  async resetSession(): Promise<void> {}

  async *run(request: AgentRequest): AsyncIterable<AgentEvent> {
    this.turns.push(request)
    const events = this.script
    this.script = []
    for (const ev of events) {
      if (ev.type === 'toolCall') {
        const done = new Promise<ToolResult>((resolve) => this.pending.set(ev.callId, resolve))
        yield ev
        await done
        continue
      }
      yield ev
    }
  }

  submitToolResult(_conversationId: string, callId: string, result: ToolResult): void {
    this.toolResults.push(result)
    this.pending.get(callId)?.(result)
    this.pending.delete(callId)
  }
}

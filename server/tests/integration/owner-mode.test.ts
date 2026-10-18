/**
 * Owner-only Developer Mode: with pairing on, Developer Mode (ServerHello
 * advertisement, dev chat, draft actions) is available to owner devices only.
 * A 'user' device gets User Mode; every dev/draft message it sends is refused
 * by the server, independent of what the client UI shows.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'net'
import { create } from '@bufbuild/protobuf'
import {
  ChatKind,
  ChatRole,
  ClientMessageSchema,
  DeviceClass,
  DeviceShape,
} from '@moumantai/protocol/generated/moumantai/v1'
import { createAppServer, type ServerComponents } from '../../src/server/main.js'
import { connectMockAdapter } from '../../src/server/agent/mock/adapter.js'
import { TestClient, waitFor } from '../helpers/test-client.js'

const OWNER = 'owner-device-0000-0000-000000000001'
const USER = 'user-device-00000-0000-000000000002'

let components: ServerComponents
let port: number

beforeAll(async () => {
  components = await createAppServer({
    adapterOverride: await connectMockAdapter(),
    port: 0,
    home: fs.mkdtempSync(path.join(os.tmpdir(), 'moumantai-owner-')),
    appDirs: ['tests/fixtures'],
    pairingRequired: true,
    devModeEnabled: true,
  })
  components.store.setDevicePaired(OWNER, true)
  components.store.setDeviceRole(OWNER, 'owner')
  components.store.setDevicePaired(USER, true) // role defaults to 'user'
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

function connect(deviceId: string): Promise<TestClient> {
  return TestClient.connect(port, {
    hello: {
      deviceClass: DeviceClass.PHONE,
      deviceProfile: { width: 390, height: 844, shape: DeviceShape.RECT },
      deviceId,
    },
  })
}

describe('owner-only Developer Mode', () => {
  it('advertises Developer Mode only to the owner device', async () => {
    const owner = await connect(OWNER)
    const user = await connect(USER)
    try {
      expect(owner.devModeEnabled).toBe(true)
      expect(user.devModeEnabled).toBe(false)
      expect(components.wsServer.isOwner(owner.sessionId)).toBe(true)
      expect(components.wsServer.isOwner(user.sessionId)).toBe(false)
    } finally {
      owner.close()
      user.close()
    }
  })

  it('refuses a dev chat message from a user device and creates no draft', async () => {
    const user = await connect(USER)
    try {
      user.send(
        create(ClientMessageSchema, {
          payload: {
            case: 'chatInput',
            value: { scope: 'app:test-app', text: 'add a field', kind: ChatKind.DEV },
          },
        }),
      )
      const reply = await waitFor(user.received, (buf) =>
        buf.find((m) => m.payload.case === 'chat' && m.payload.value.kind === ChatKind.DEV),
      )
      if (reply.payload.case !== 'chat') throw new Error('unreachable')
      expect(reply.payload.value.text).toContain("owner's device")
      expect(components.draftStore!.listActiveDrafts()).toHaveLength(0)
    } finally {
      user.close()
    }
  })

  it.each(['draftPromote', 'draftDiscard', 'draftReload', 'previewOptIn'] as const)(
    'refuses %s from a user device',
    async (action) => {
      const user = await connect(USER)
      try {
        const value =
          action === 'previewOptIn' ? { draftId: 'd-1', optIn: true } : { draftId: 'd-1' }
        user.send(create(ClientMessageSchema, { payload: { case: action, value } as never }))
        const ack = await waitFor(user.received, (buf) =>
          buf.find((m) => m.payload.case === 'draftActionResult'),
        )
        if (ack.payload.case !== 'draftActionResult') throw new Error('unreachable')
        expect(ack.payload.value.ok).toBe(false)
        expect(ack.payload.value.error).toContain("owner's device")
      } finally {
        user.close()
      }
    },
  )

  it('lets the owner device through the gate to the dev-turn path', async () => {
    const owner = await connect(OWNER)
    try {
      owner.send(
        create(ClientMessageSchema, {
          payload: {
            case: 'chatInput',
            value: { scope: 'app:test-app', text: 'hello', kind: ChatKind.DEV },
          },
        }),
      )
      // Whatever the dev turn then does with the fixture (draft created and the
      // mock replies, or draft creation fails), the reply is not the owner
      // refusal: the gate let the owner through.
      const reply = await waitFor(owner.received, (buf) =>
        buf.find(
          (m) =>
            m.payload.case === 'chat' &&
            m.payload.value.kind === ChatKind.DEV &&
            m.payload.value.role === ChatRole.ASSISTANT,
        ),
      )
      if (reply.payload.case !== 'chat') throw new Error('unreachable')
      expect(reply.payload.value.text).not.toContain("owner's device")
    } finally {
      owner.close()
    }
  })
})

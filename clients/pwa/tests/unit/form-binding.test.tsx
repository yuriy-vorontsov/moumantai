import { describe, it, expect, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { create } from '@bufbuild/protobuf'
import {
  ComponentDefSchema,
  type AppInfo,
  type FaceInfo,
} from '@moumantai/protocol/generated/moumantai/v1'
import { RenderNode } from '../../src/renderer/RenderNode'
import { useAppStore } from '../../src/renderer/stores/app-store'

/**
 * Inputs created without an explicit `value` bind read+write to the per-face
 * form scope (`/$form/<id>`). The rendered value must come from that scope:
 * otherwise every keystroke is wiped on re-render and only the last character
 * reaches the submit action.
 */

const SURFACE = 'app1:main'

function seedTextField(value: { path: string } | { literal: string }) {
  const store = useAppStore.getState()
  store.reset()
  store.setAppList([{ appId: 'app1', label: 'App', icon: 'x', position: 0 } as AppInfo])
  store.setFaceList('app1', [{ faceId: 'main', label: 'Main', position: 0 } as FaceInfo])
  const dynamic =
    'path' in value
      ? { value: { case: 'path' as const, value: value.path } }
      : { value: { case: 'literal' as const, value: value.literal } }
  const field = create(ComponentDefSchema, {
    id: 'title',
    component: { case: 'textField', value: { label: 'Title', value: dynamic } },
  })
  store.updateFace('app1', 'main', [field], { server_value: 'from server' })
}

function renderField() {
  return render(<RenderNode componentId="title" surfaceId={SURFACE} dispatch={() => {}} />)
}

describe('form-scope binding', () => {
  beforeEach(() => {
    seedTextField({ path: '/$form/title' })
  })

  it('shows what the user typed and keeps the whole value in the form scope', () => {
    const { container } = renderField()
    const input = container.querySelector('input')!
    fireEvent.change(input, { target: { value: 'B' } })
    fireEvent.change(input, { target: { value: 'Bu' } })
    fireEvent.change(input, { target: { value: 'Buy milk' } })
    expect(input.value).toBe('Buy milk')
    expect(useAppStore.getState().apps.get('app1')!.faces.get('main')!.form.title).toBe('Buy milk')
  })

  it('keeps the typed value across a server face refresh', () => {
    const { container } = renderField()
    const input = container.querySelector('input')!
    fireEvent.change(input, { target: { value: 'draft' } })
    const face = useAppStore.getState().apps.get('app1')!.faces.get('main')!
    useAppStore.getState().updateFace('app1', 'main', [...face.components.values()], { other: 1 })
    expect(input.value).toBe('draft')
  })
})

describe('face-data binding (unchanged)', () => {
  it('still reads non-form paths from the face data', () => {
    seedTextField({ path: '/server_value' })
    const { container } = renderField()
    expect(container.querySelector('input')!.value).toBe('from server')
  })
})

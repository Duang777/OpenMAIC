// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SceneProvider,
  type SceneDataController,
  useSceneData,
} from '@/lib/contexts/scene-context';
import { createDefaultSlide, createDefaultTextElement } from '@/lib/edit/slide-edit-elements';
import type { SlideContent } from '@/lib/types/stage';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock('@/lib/store/stage', () => ({
  useStageStore: (selector: (state: { currentSceneId: null; scenes: never[] }) => unknown) =>
    selector({ currentSceneId: null, scenes: [] }),
}));

type SceneUpdater = (updater: (draft: SlideContent) => void) => void;

let root: Root | null = null;

function makeContent(top: number): SlideContent {
  const slide = createDefaultSlide('slide-1');
  const element = createDefaultTextElement('text-1');
  element.top = top;
  slide.elements.push(element);
  return { type: 'slide', canvas: slide };
}

function Probe({ onUpdate }: { onUpdate: (update: SceneUpdater) => void }) {
  const { updateSceneData } = useSceneData<SlideContent>();
  useEffect(() => {
    onUpdate(updateSceneData);
  }, [onUpdate, updateSceneData]);
  return null;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('SceneProvider controlled updates', () => {
  it('binds each update callback to the snapshot exposed by that render', () => {
    const firstSnapshot = makeContent(111);
    const secondSnapshot = makeContent(222);
    let snapshot = firstSnapshot;
    const updateSceneData = vi.fn(
      (_baseline: SlideContent, _updater: (draft: SlideContent) => void) => {},
    );
    const controller: SceneDataController<SlideContent> = {
      sceneId: 'scene-1',
      sceneType: 'slide',
      getSnapshot: () => snapshot,
      updateSceneData,
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const updates: SceneUpdater[] = [];
    const captureUpdate = (update: SceneUpdater) => updates.push(update);

    act(() => {
      root?.render(
        createElement(
          SceneProvider<SlideContent>,
          { controller },
          createElement(Probe, { onUpdate: captureUpdate }),
        ),
      );
    });
    const firstUpdate = updates.at(-1);

    snapshot = secondSnapshot;
    act(() => {
      root?.render(
        createElement(
          SceneProvider<SlideContent>,
          { controller },
          createElement(Probe, { onUpdate: captureUpdate }),
        ),
      );
    });
    const secondUpdate = updates.at(-1);
    const updater = (draft: SlideContent) => {
      draft.canvas.elements[0].top = 333;
    };

    firstUpdate?.(updater);
    secondUpdate?.(updater);

    expect(updateSceneData).toHaveBeenNthCalledWith(1, firstSnapshot, updater);
    expect(updateSceneData).toHaveBeenNthCalledWith(2, secondSnapshot, updater);
  });
});

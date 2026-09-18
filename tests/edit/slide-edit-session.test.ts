import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSlide, createDefaultTextElement } from '@/lib/edit/slide-edit-elements';
import type { PPTTextElement } from '@openmaic/dsl';
import type { SlideContent } from '@/lib/types/stage';

// Mock the canonical stage store so we can assert write-through and model
// an agent updating the same scene while the local edit session stays open.
const stageMock = vi.hoisted(() => ({
  liveContent: null as SlideContent | null,
  updateScene: vi.fn(),
}));
const updateScene = stageMock.updateScene;
vi.mock('@/lib/store/stage', () => ({
  useStageStore: {
    getState: () => ({
      scenes: stageMock.liveContent
        ? [{ id: 'scene-1', type: 'slide', content: stageMock.liveContent }]
        : [],
      updateScene,
    }),
  },
}));

// Imported AFTER the mock setup (vi.mock is hoisted by Vitest).
const { useSlideEditSession } = await import('@/components/edit/surfaces/slide/slide-edit-session');

// Fixture element 0 is the default text element; narrow so we can read
// text-only geometry props off the PPTElement union.
const rotateOf = (c: SlideContent) => (c.canvas.elements[0] as PPTTextElement).rotate;

function makeContent(): SlideContent {
  const slide = createDefaultSlide('slide-1');
  slide.elements.push(createDefaultTextElement('text-1'));
  return { type: 'slide', canvas: slide };
}

describe('useSlideEditSession (auto-save to stage store)', () => {
  beforeEach(() => {
    useSlideEditSession.getState().end();
    stageMock.liveContent = makeContent();
    updateScene.mockReset();
    updateScene.mockImplementation((_sceneId: string, updates: { content?: SlideContent }) => {
      if (updates.content) stageMock.liveContent = updates.content;
    });
  });

  it('seed adopts a baseline without touching the stage store', () => {
    useSlideEditSession.getState().seed('scene-1', makeContent());
    const { sceneId, history } = useSlideEditSession.getState();
    expect(sceneId).toBe('scene-1');
    expect(history?.past).toEqual([]);
    expect(history?.future).toEqual([]);
    expect(history?.present.canvas.elements[0].id).toBe('text-1');
    // The stage already has this content; redundant writes are noise.
    expect(updateScene).not.toHaveBeenCalled();
  });

  it('applyOp advances history by one step AND writes through to the stage store', () => {
    useSlideEditSession.getState().seed('scene-1', stageMock.liveContent!);
    useSlideEditSession.getState().applyOp({
      type: 'element.update',
      elementId: 'text-1',
      patch: { left: 500 },
    });
    const { history } = useSlideEditSession.getState();
    expect(history?.past).toHaveLength(1);
    expect(history?.present.canvas.elements[0].left).toBe(500);
    // Stage store sees the new content.
    expect(updateScene).toHaveBeenCalledTimes(1);
    expect(updateScene).toHaveBeenCalledWith(
      'scene-1',
      expect.objectContaining({ content: history!.present }),
    );
  });

  it('rebases a toolbar operation onto a concurrent canonical scene update', () => {
    useSlideEditSession.getState().seed('scene-1', stageMock.liveContent!);
    const agentContent = structuredClone(stageMock.liveContent!);
    agentContent.canvas.elements.push(createDefaultTextElement('agent-text'));
    stageMock.liveContent = agentContent;

    useSlideEditSession.getState().applyOp({
      type: 'element.update',
      elementId: 'text-1',
      patch: { left: 500 },
    });

    const present = useSlideEditSession.getState().history!.present;
    expect(present.canvas.elements.map((element) => element.id)).toEqual(['text-1', 'agent-text']);
    expect(present.canvas.elements[0].left).toBe(500);
    expect(stageMock.liveContent).toBe(present);
  });

  it('rebases a renderer snapshot onto a concurrent canonical scene update', () => {
    useSlideEditSession.getState().seed('scene-1', stageMock.liveContent!);
    const rendererCommit = structuredClone(useSlideEditSession.getState().history!.present);
    rendererCommit.canvas.elements[0].top = 222;

    const agentContent = structuredClone(stageMock.liveContent!);
    agentContent.canvas.elements.push(createDefaultTextElement('agent-text'));
    stageMock.liveContent = agentContent;

    useSlideEditSession.getState().commitContent(rendererCommit, true);

    const present = useSlideEditSession.getState().history!.present;
    expect(present.canvas.elements.map((element) => element.id)).toEqual(['text-1', 'agent-text']);
    expect(present.canvas.elements[0].top).toBe(222);
    expect(stageMock.liveContent).toBe(present);
  });

  it('does not add an agent element twice when the renderer already includes it', () => {
    useSlideEditSession.getState().seed('scene-1', stageMock.liveContent!);
    const rendererCommit = structuredClone(useSlideEditSession.getState().history!.present);
    rendererCommit.canvas.elements[0].top = 222;
    const rendererAgentElement = createDefaultTextElement('agent-text');
    rendererAgentElement.top = 111;
    rendererCommit.canvas.elements.push(rendererAgentElement);

    const agentContent = structuredClone(stageMock.liveContent!);
    const canonicalAgentElement = createDefaultTextElement('agent-text');
    canonicalAgentElement.top = 333;
    agentContent.canvas.elements.push(canonicalAgentElement);
    stageMock.liveContent = agentContent;

    expect(() => useSlideEditSession.getState().commitContent(rendererCommit, true)).not.toThrow();

    const present = useSlideEditSession.getState().history!.present;
    expect(present.canvas.elements.map((element) => element.id)).toEqual(['text-1', 'agent-text']);
    expect(present.canvas.elements[0].top).toBe(222);
    expect(present.canvas.elements[1].top).toBe(333);
    expect(stageMock.liveContent).toBe(present);
  });

  it('applies a local edit to an agent element from the renderer-observed baseline', () => {
    useSlideEditSession.getState().seed('scene-1', stageMock.liveContent!);

    const rendererBaseline = structuredClone(stageMock.liveContent!);
    const agentElement = createDefaultTextElement('agent-text');
    agentElement.left = 111;
    agentElement.top = 111;
    rendererBaseline.canvas.elements.push(agentElement);
    stageMock.liveContent = rendererBaseline;

    const rendererCommit = structuredClone(rendererBaseline);
    rendererCommit.canvas.elements[1].top = 222;

    const latestCanonical = structuredClone(rendererBaseline);
    latestCanonical.canvas.elements[1].left = 333;
    stageMock.liveContent = latestCanonical;

    useSlideEditSession.getState().commitContent(rendererCommit, true, rendererBaseline);

    const present = useSlideEditSession.getState().history!.present;
    expect(present.canvas.elements.map((element) => element.id)).toEqual(['text-1', 'agent-text']);
    expect(present.canvas.elements[1]).toMatchObject({ left: 333, top: 222 });
    expect(stageMock.liveContent).toBe(present);
  });

  it('does not let undo restore a snapshot older than a concurrent canonical update', () => {
    useSlideEditSession.getState().seed('scene-1', stageMock.liveContent!);
    useSlideEditSession.getState().applyOp({
      type: 'element.update',
      elementId: 'text-1',
      patch: { left: 500 },
    });

    const agentContent = structuredClone(stageMock.liveContent!);
    agentContent.canvas.elements.push(createDefaultTextElement('agent-text'));
    stageMock.liveContent = agentContent;
    updateScene.mockClear();

    useSlideEditSession.getState().undo();

    const present = useSlideEditSession.getState().history!.present;
    expect(present).toEqual(agentContent);
    expect(updateScene).not.toHaveBeenCalled();
  });

  it('rejects a transaction captured by a previous scene', () => {
    useSlideEditSession.getState().seed('scene-1', makeContent());
    const staleSceneId = useSlideEditSession.getState().sceneId!;
    const nextScene = makeContent();
    nextScene.canvas.id = 'slide-2';
    useSlideEditSession.getState().seed('scene-2', nextScene);

    useSlideEditSession.getState().applyTransactionForScene(staleSceneId, {
      origin: 'toolbar',
      history: 'record',
      operations: [{ type: 'element.update', elementId: 'text-1', patch: { left: 999 } }],
    });

    expect(useSlideEditSession.getState().history?.present.canvas.elements[0].left).not.toBe(999);
    expect(updateScene).not.toHaveBeenCalled();
  });

  it('applyOp ignores a no-op against a missing element (no stage write)', () => {
    useSlideEditSession.getState().seed('scene-1', makeContent());
    useSlideEditSession.getState().applyOp({
      type: 'element.update',
      elementId: 'does-not-exist',
      patch: { left: 1 },
    });
    expect(useSlideEditSession.getState().history?.past).toEqual([]);
    // The kernel returns the same history reference; replace() short-circuits.
    expect(updateScene).not.toHaveBeenCalled();
  });

  it('user-driven commit records one undo step + writes through', () => {
    useSlideEditSession.getState().seed('scene-1', makeContent());
    const next = structuredClone(useSlideEditSession.getState().history!.present);
    next.canvas.elements[0].left = 88;
    next.canvas.elements[0].top = 99;
    useSlideEditSession.getState().commitContent(next, true);
    const { history } = useSlideEditSession.getState();
    expect(history?.past).toHaveLength(1);
    expect(history?.present.canvas.elements[0]).toMatchObject({ left: 88, top: 99 });
    expect(updateScene).toHaveBeenCalledTimes(1);
  });

  it('non-user (ResizeObserver) commit folds into present without an undo step AND still writes through', () => {
    // Auto-fit height IS the new canonical state, so it must reach the
    // stage store. But it must NOT push an undo step (the reflow can
    // chase a user resize; wiping past/future would silently break undo).
    useSlideEditSession.getState().seed('scene-1', makeContent());
    const normalized = structuredClone(useSlideEditSession.getState().history!.present);
    (normalized.canvas.elements[0] as PPTTextElement).height = 999;
    useSlideEditSession.getState().commitContent(normalized, false);
    const { history } = useSlideEditSession.getState();
    expect(history?.past).toEqual([]);
    expect((history!.present.canvas.elements[0] as PPTTextElement).height).toBe(999);
    expect(updateScene).toHaveBeenCalledTimes(1);
    expect(updateScene).toHaveBeenCalledWith(
      'scene-1',
      expect.objectContaining({ content: history!.present }),
    );
  });

  it('a non-user commit after a user edit preserves the undo stack (and writes through both)', () => {
    useSlideEditSession.getState().seed('scene-1', makeContent());
    const resized = structuredClone(useSlideEditSession.getState().history!.present);
    resized.canvas.elements[0].width = 640;
    useSlideEditSession.getState().commitContent(resized, true);
    expect(useSlideEditSession.getState().history?.past).toHaveLength(1);

    const reflowed = structuredClone(useSlideEditSession.getState().history!.present);
    (reflowed.canvas.elements[0] as PPTTextElement).height = 333;
    useSlideEditSession.getState().commitContent(reflowed, false);

    const { history } = useSlideEditSession.getState();
    expect(history?.past).toHaveLength(1); // undo step survives
    expect((history!.present.canvas.elements[0] as PPTTextElement).height).toBe(333);
    expect(updateScene).toHaveBeenCalledTimes(2); // user commit + non-user commit
    // Undo returns to the pre-resize width, and writes that through too.
    updateScene.mockClear();
    useSlideEditSession.getState().undo();
    expect(useSlideEditSession.getState().history?.present.canvas.elements[0].width).toBe(
      makeContent().canvas.elements[0].width,
    );
    expect(updateScene).toHaveBeenCalledTimes(1);
  });

  it('a non-user commit after an undo clears the stale redo branch (no resurrected content)', () => {
    // Regression: user edit → undo (content moves to `future`) → the
    // ResizeObserver auto-height normalization fires a non-user commit. If
    // that commit folds into `present` but keeps the now-stale `future[0]`,
    // a later redo resurrects the pre-undo snapshot and silently discards
    // the normalization (canvas/store diverge). The non-user commit must
    // clear `future` so redo is a no-op.
    useSlideEditSession.getState().seed('scene-1', makeContent());
    const resized = structuredClone(useSlideEditSession.getState().history!.present);
    resized.canvas.elements[0].width = 640;
    useSlideEditSession.getState().commitContent(resized, true);
    expect(useSlideEditSession.getState().history?.past).toHaveLength(1);

    // Undo pushes the resized snapshot onto `future`.
    useSlideEditSession.getState().undo();
    expect(useSlideEditSession.getState().history?.future).toHaveLength(1);
    expect(useSlideEditSession.getState().history?.present.canvas.elements[0].width).toBe(
      makeContent().canvas.elements[0].width,
    );

    // Non-user (auto-height) commit lands on the undone present.
    const reflowed = structuredClone(useSlideEditSession.getState().history!.present);
    (reflowed.canvas.elements[0] as PPTTextElement).height = 333;
    useSlideEditSession.getState().commitContent(reflowed, false);

    const afterReflow = useSlideEditSession.getState().history;
    expect(afterReflow?.future).toEqual([]); // stale redo branch dropped
    expect((afterReflow!.present.canvas.elements[0] as PPTTextElement).height).toBe(333);

    // Redo must be a no-op now: it cannot resurrect the stale width=640.
    updateScene.mockClear();
    useSlideEditSession.getState().redo();
    const afterRedo = useSlideEditSession.getState().history;
    expect(afterRedo?.present.canvas.elements[0].width).toBe(
      makeContent().canvas.elements[0].width,
    );
    expect((afterRedo!.present.canvas.elements[0] as PPTTextElement).height).toBe(333);
    // future was empty → redo short-circuits to the same ref → no write-through.
    expect(updateScene).not.toHaveBeenCalled();
  });

  it('undo / redo move between history states AND write through on each move', () => {
    useSlideEditSession.getState().seed('scene-1', makeContent());
    useSlideEditSession.getState().applyOp({
      type: 'element.update',
      elementId: 'text-1',
      patch: { rotate: 30 },
    });
    updateScene.mockClear();
    useSlideEditSession.getState().undo();
    expect(rotateOf(useSlideEditSession.getState().history!.present)).toBe(0);
    expect(updateScene).toHaveBeenCalledTimes(1);
    useSlideEditSession.getState().redo();
    expect(rotateOf(useSlideEditSession.getState().history!.present)).toBe(30);
    expect(updateScene).toHaveBeenCalledTimes(2);
  });

  it('repeated non-user commits each write through but never grow past/future', () => {
    useSlideEditSession.getState().seed('scene-1', makeContent());
    for (let i = 0; i < 3; i++) {
      const n = structuredClone(useSlideEditSession.getState().history!.present);
      (n.canvas.elements[0] as PPTTextElement).height = 100 + i;
      useSlideEditSession.getState().commitContent(n, false);
    }
    expect(useSlideEditSession.getState().history?.past).toEqual([]);
    expect(
      (useSlideEditSession.getState().history!.present.canvas.elements[0] as PPTTextElement).height,
    ).toBe(102);
    expect(updateScene).toHaveBeenCalledTimes(3);
  });

  it('end clears the session (no further write-through possible)', () => {
    useSlideEditSession.getState().seed('scene-1', makeContent());
    useSlideEditSession.getState().end();
    expect(useSlideEditSession.getState().sceneId).toBeNull();
    expect(useSlideEditSession.getState().history).toBeNull();
    // applyOp after end must be a no-op (no sceneId → no writeThrough either).
    updateScene.mockClear();
    useSlideEditSession.getState().applyOp({
      type: 'element.update',
      elementId: 'text-1',
      patch: { left: 1 },
    });
    expect(updateScene).not.toHaveBeenCalled();
  });
});

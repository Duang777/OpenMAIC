// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizContent } from '@/lib/types/stage';
import {
  addQuestion,
  reorderOptions,
  updateQuestion,
} from '@/components/edit/surfaces/quiz/quiz-edit-ops';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Mock the canonical stage store so we can assert write-through and model
// an agent updating the same scene while the local edit session stays open.
const stageMock = vi.hoisted(() => ({
  liveContent: null as QuizContent | null,
  updateScene: vi.fn(),
}));
const updateScene = stageMock.updateScene;
vi.mock('@/lib/store/stage', () => ({
  useStageStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        currentSceneId: 'scene-1',
        scenes: stageMock.liveContent
          ? [{ id: 'scene-1', type: 'quiz', content: stageMock.liveContent }]
          : [],
        updateScene,
      }),
    {
      getState: () => ({
        scenes: stageMock.liveContent
          ? [{ id: 'scene-1', type: 'quiz', content: stageMock.liveContent }]
          : [],
        updateScene,
      }),
    },
  ),
}));

const { useQuizEditSession } = await import('@/components/edit/surfaces/quiz/quiz-edit-session');
const {
  deleteQuizOption,
  reorderQuizOptions,
  reorderQuizQuestions,
  toggleQuizCorrect,
  typeQuizOptionLabel,
  typeQuizQuestion,
  useResolvedQuizContent,
} = await import('@/components/edit/surfaces/quiz/use-quiz-surface');

function makeContent(): QuizContent {
  return {
    type: 'quiz',
    questions: [{ id: 'q1', type: 'single', question: 'Q?', options: [], answer: [], points: 1 }],
  };
}

function makeChoiceContent(): QuizContent {
  return {
    type: 'quiz',
    questions: [
      {
        id: 'q1',
        type: 'single',
        question: 'Pick a fruit',
        options: [
          { value: 'A', label: 'Apple' },
          { value: 'B', label: 'Banana' },
        ],
        answer: ['A'],
        points: 1,
      },
    ],
  };
}

describe('useQuizEditSession (auto-save to stage store)', () => {
  beforeEach(() => {
    useQuizEditSession.getState().end();
    stageMock.liveContent = makeContent();
    updateScene.mockReset();
    updateScene.mockImplementation((_sceneId: string, updates: { content?: QuizContent }) => {
      if (updates.content) stageMock.liveContent = updates.content;
    });
  });

  it('seed adopts a baseline without touching the stage store', () => {
    useQuizEditSession.getState().seed('scene-1', makeContent());
    const { sceneId, history } = useQuizEditSession.getState();
    expect(sceneId).toBe('scene-1');
    expect(history?.past).toEqual([]);
    expect(history?.present.questions[0].id).toBe('q1');
    expect(updateScene).not.toHaveBeenCalled();
  });

  it('commit advances history one step, writes through, and produces a NEW content ref', () => {
    useQuizEditSession.getState().seed('scene-1', makeContent());
    const before = useQuizEditSession.getState().history!.present;
    useQuizEditSession.getState().commit((content) => addQuestion(content, 'multiple', 'q2'));
    const { history } = useQuizEditSession.getState();
    expect(history?.past).toHaveLength(1);
    expect(history?.present).not.toBe(before); // ref change → surfaceStateEqual fires
    expect(history?.present.questions.map((q) => q.id)).toEqual(['q1', 'q2']);
    expect(updateScene).toHaveBeenCalledWith(
      'scene-1',
      expect.objectContaining({ content: history!.present }),
    );
  });

  it('commitText with the same key coalesces into one undo step (every keystroke writes through)', () => {
    useQuizEditSession.getState().seed('scene-1', makeContent());
    const s = () => useQuizEditSession.getState();
    s().commitText((content) => updateQuestion(content, 'q1', { question: 'C' }), 'q1:question');
    s().commitText((content) => updateQuestion(content, 'q1', { question: 'Ca' }), 'q1:question');
    s().commitText((content) => updateQuestion(content, 'q1', { question: 'Cap' }), 'q1:question');
    expect(s().history?.past).toHaveLength(1); // one burst → one step
    expect(s().history?.present.questions[0].question).toBe('Cap');
    expect(updateScene).toHaveBeenCalledTimes(3); // but all three persisted
  });

  it('commitText with a different key starts a new undo step', () => {
    useQuizEditSession.getState().seed('scene-1', makeContent());
    const s = () => useQuizEditSession.getState();
    s().commitText((content) => updateQuestion(content, 'q1', { question: 'X' }), 'q1:question');
    s().commitText((content) => updateQuestion(content, 'q1', { analysis: 'Y' }), 'q1:analysis');
    expect(s().history?.past).toHaveLength(2);
  });

  it('a discrete commit closes the current text burst', () => {
    useQuizEditSession.getState().seed('scene-1', makeContent());
    const s = () => useQuizEditSession.getState();
    s().commitText((content) => updateQuestion(content, 'q1', { question: 'X' }), 'q1:question');
    s().commit((content) => addQuestion(content, 'single', 'q2'));
    // Another text edit with the SAME key must NOT merge into the pre-commit burst.
    s().commitText((content) => updateQuestion(content, 'q1', { question: 'XY' }), 'q1:question');
    expect(s().history?.past).toHaveLength(3);
  });

  it('preserves an agent-added question when committing local text', () => {
    useQuizEditSession.getState().seed('scene-1', stageMock.liveContent!);
    const withAgentQuestion = addQuestion(stageMock.liveContent!, 'short_answer', 'agent-question');
    stageMock.liveContent = updateQuestion(withAgentQuestion, 'q1', {
      analysis: 'Agent analysis',
    });

    typeQuizQuestion('q1', { question: 'Locally edited' }, 'q1:question');

    expect(stageMock.liveContent?.questions.map((question) => question.id)).toEqual([
      'q1',
      'agent-question',
    ]);
    expect(stageMock.liveContent?.questions[0]).toMatchObject({
      question: 'Locally edited',
      analysis: 'Agent analysis',
    });
  });

  it('preserves an agent-added question when committing a stale reorder', () => {
    useQuizEditSession.getState().seed('scene-1', stageMock.liveContent!);
    stageMock.liveContent = addQuestion(stageMock.liveContent!, 'short_answer', 'agent-question');

    reorderQuizQuestions(['q1']);

    expect(stageMock.liveContent?.questions.map((question) => question.id)).toEqual([
      'q1',
      'agent-question',
    ]);
  });

  it('renders and adopts externally reordered options as the new session baseline', async () => {
    stageMock.liveContent = makeChoiceContent();
    useQuizEditSession.getState().seed('scene-1', stageMock.liveContent);
    const rendered: QuizContent[] = [];
    const container = document.createElement('div');
    const root = createRoot(container);
    const Probe = () => {
      rendered.push(useResolvedQuizContent());
      return null;
    };

    await act(async () => {
      root.render(createElement(Probe));
    });
    const reordered = reorderOptions(stageMock.liveContent, 'q1', 0, 1);
    stageMock.liveContent = reordered;
    await act(async () => {
      root.render(createElement(Probe));
    });

    expect(rendered.at(-1)?.questions[0].options?.map((option) => option.label)).toEqual([
      'Banana',
      'Apple',
    ]);
    expect(useQuizEditSession.getState().history?.present).toBe(reordered);

    act(() => root.unmount());
  });

  it.each([
    {
      name: 'text edit',
      invoke: (option: { value: string; label: string }) =>
        typeQuizOptionLabel('q1', 0, 'Edited Apple', option),
    },
    {
      name: 'correct-answer toggle',
      invoke: (option: { value: string; label: string }) => toggleQuizCorrect('q1', 0, option),
    },
    {
      name: 'delete',
      invoke: (option: { value: string; label: string }) => deleteQuizOption('q1', 0, option),
    },
    {
      name: 'reorder',
      invoke: (option: { value: string; label: string }) => reorderQuizOptions('q1', 0, 1, option),
    },
  ])('ignores a stale option $name after an external reorder', ({ invoke }) => {
    stageMock.liveContent = makeChoiceContent();
    useQuizEditSession.getState().seed('scene-1', stageMock.liveContent);
    const renderedOption = useQuizEditSession.getState().history!.present.questions[0].options![0];
    const reordered = reorderOptions(stageMock.liveContent, 'q1', 0, 1);
    stageMock.liveContent = reordered;
    updateScene.mockClear();

    invoke(renderedOption);

    expect(stageMock.liveContent).toBe(reordered);
    expect(useQuizEditSession.getState().history?.present).toBe(reordered);
    expect(updateScene).not.toHaveBeenCalled();
  });

  it('does not let undo restore a snapshot older than a concurrent canonical update', () => {
    useQuizEditSession.getState().seed('scene-1', stageMock.liveContent!);
    const s = () => useQuizEditSession.getState();
    s().commit((content) => addQuestion(content, 'single', 'local-question'));
    stageMock.liveContent = addQuestion(stageMock.liveContent!, 'short_answer', 'agent-question');
    updateScene.mockClear();

    s().undo();

    expect(stageMock.liveContent?.questions.map((question) => question.id)).toEqual([
      'q1',
      'local-question',
      'agent-question',
    ]);
    expect(s().history?.past).toEqual([]);
    expect(s().history?.future).toEqual([]);
    expect(updateScene).not.toHaveBeenCalled();
  });

  it('undo / redo write the restored snapshot through to the stage store', () => {
    useQuizEditSession.getState().seed('scene-1', makeContent());
    const s = () => useQuizEditSession.getState();
    const base = s().history!.present;
    s().commit((content) => addQuestion(content, 'single', 'q2'));
    updateScene.mockClear();
    s().undo();
    expect(s().history?.present).toBe(base);
    expect(updateScene).toHaveBeenLastCalledWith(
      'scene-1',
      expect.objectContaining({ content: base }),
    );
    s().redo();
    expect(s().history?.present.questions.map((q) => q.id)).toEqual(['q1', 'q2']);
  });
});

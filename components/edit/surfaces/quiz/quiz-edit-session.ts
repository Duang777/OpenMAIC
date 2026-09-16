/**
 * Module-level quiz-edit session — pure in-memory undo/redo for the quiz
 * content surface, mirroring `slide-edit-session` but over the structured
 * `QuizContent` DSL instead of a canvas.
 *
 * Like the slide session it writes every committed snapshot THROUGH to the
 * canonical `useStageStore` (auto-save via Dexie); this store only owns the
 * undo/redo timeline of an in-progress editing session and is torn down on
 * exit. There is deliberately no localStorage / "restore unsaved" UX — the
 * stage store is the source of truth.
 *
 * Two commit entry points:
 *   - `commit`     — a discrete structural edit (add/delete/reorder/toggle/
 *                    type-switch). Always a fresh undo step.
 *   - `commitText` — a coalescing text edit. Consecutive edits carrying the
 *                    same `coalesceKey` (e.g. typing into one field) fold into
 *                    a SINGLE undo step; every keystroke still writes through
 *                    so nothing is lost. Switching fields or any discrete
 *                    commit starts a new step.
 */

import { create } from 'zustand';
import { isEqual } from 'lodash';
import { useStageStore } from '@/lib/store/stage';
import type { QuizContent } from '@/lib/types/stage';
import {
  commitQuizContent,
  createQuizEditHistory,
  redoQuiz,
  undoQuiz,
  type QuizEditHistory,
} from './quiz-edit-ops';

type QuizEditMutation = (content: QuizContent) => QuizContent;

interface QuizEditSessionState {
  sceneId: string | null;
  history: QuizEditHistory | null;
  /** Identifies the field of the in-progress coalesced text edit, or null. */
  coalesceKey: string | null;

  /** Establish a fresh in-memory baseline for a scene. */
  seed: (sceneId: string, content: QuizContent) => void;
  /** Discrete structural edit — always its own undo step. */
  commit: (mutate: QuizEditMutation) => void;
  /** Coalescing text edit — same key folds into one undo step. */
  commitText: (mutate: QuizEditMutation, coalesceKey: string) => void;
  undo: () => void;
  redo: () => void;
  /** Tear the session down on exit from edit mode. */
  end: () => void;
}

export const useQuizEditSession = create<QuizEditSessionState>((set, get) => {
  const writeThrough = (next: QuizContent) => {
    const { sceneId } = get();
    if (!sceneId) return;
    useStageStore.getState().updateScene(sceneId, { content: next });
  };

  /** Adopt a new history, write its present through, and close any text burst. */
  const replace = (history: QuizEditHistory) => {
    const { history: prev } = get();
    if (history === prev) return;
    writeThrough(history.present);
    set({ history, coalesceKey: null });
  };

  /**
   * Adopt an externally updated scene as a new history baseline before a
   * local action runs. Old undo and redo snapshots cannot remain valid
   * because replaying them would replace the canonical update.
   */
  const freshHistory = (): QuizEditHistory | null => {
    const { sceneId, history } = get();
    if (!sceneId || !history) return null;
    const scene = useStageStore.getState().scenes.find((candidate) => candidate.id === sceneId);
    if (!scene || scene.type !== 'quiz') return null;
    const canonical = scene.content as QuizContent;
    if (isEqual(canonical, history.present)) return history;
    const nextHistory = createQuizEditHistory(canonical);
    set({ history: nextHistory, coalesceKey: null });
    return nextHistory;
  };

  return {
    sceneId: null,
    history: null,
    coalesceKey: null,

    seed: (sceneId, content) => {
      // Adopt the live scene content as the baseline without writing through:
      // an untouched scene shouldn't receive a redundant store write.
      set({ sceneId, history: createQuizEditHistory(content), coalesceKey: null });
    },

    commit: (mutate) => {
      const history = freshHistory();
      if (!history) return;
      replace(commitQuizContent(history, mutate(history.present)));
    },

    commitText: (mutate, coalesceKey) => {
      const history = freshHistory();
      if (!history) return;
      const { coalesceKey: activeKey } = get();
      const next = mutate(history.present);
      if (next === history.present) return;
      writeThrough(next);
      if (activeKey === coalesceKey) {
        // Continue the current burst: replace present, no new undo step.
        set({ history: { ...history, present: next, future: [] } });
      } else {
        // Start a new burst: this push is the burst's single undo step.
        set({ history: commitQuizContent(history, next), coalesceKey });
      }
    },

    undo: () => {
      const history = freshHistory();
      if (!history) return;
      replace(undoQuiz(history));
    },

    redo: () => {
      const history = freshHistory();
      if (!history) return;
      replace(redoQuiz(history));
    },

    end: () => {
      set({ sceneId: null, history: null, coalesceKey: null });
    },
  };
});

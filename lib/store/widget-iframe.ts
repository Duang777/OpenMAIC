/**
 * Widget iframe messaging store.
 * Tracks iframe postMessage callbacks per scene to prevent race conditions
 * when switching between interactive scenes.
 */

import { create } from 'zustand';

type WidgetMessagePayload = Record<string, unknown>;
type WidgetSendMessage = (type: string, payload: WidgetMessagePayload) => void;

interface PendingWidgetMessage {
  readonly type: string;
  readonly payload: WidgetMessagePayload;
}

interface WidgetIframeState {
  /** Callbacks keyed by sceneId for targeted postMessage communication */
  sendMessageByScene: Record<string, WidgetSendMessage>;
  /** Whether the current iframe document has emitted its load event */
  readyByScene: Record<string, boolean>;
  /** Messages waiting for the target iframe document to become ready */
  pendingMessagesByScene: Record<string, PendingWidgetMessage[]>;
  /** Currently active scene ID (used for fallback/legacy support) */
  activeSceneId: string | null;
  /** Register an iframe callback for a specific scene */
  registerIframe: (sceneId: string, callback: WidgetSendMessage | null) => void;
  /** Mark the current iframe document ready and flush its pending messages */
  markIframeReady: (sceneId: string) => void;
  /** Set the active scene ID */
  setActiveScene: (sceneId: string | null) => void;
  /** Get sendMessage callback for a specific scene (or current active scene) */
  getSendMessage: (sceneId?: string) => WidgetSendMessage | null;
}

export const useWidgetIframeStore = create<WidgetIframeState>((set, get) => ({
  sendMessageByScene: {},
  readyByScene: {},
  pendingMessagesByScene: {},
  activeSceneId: null,
  registerIframe: (sceneId, callback) =>
    set((state) => {
      if (callback === null) {
        const sendMessageByScene = { ...state.sendMessageByScene };
        const readyByScene = { ...state.readyByScene };
        const pendingMessagesByScene = { ...state.pendingMessagesByScene };
        delete sendMessageByScene[sceneId];
        delete readyByScene[sceneId];
        delete pendingMessagesByScene[sceneId];
        return { sendMessageByScene, readyByScene, pendingMessagesByScene };
      }
      return {
        sendMessageByScene: { ...state.sendMessageByScene, [sceneId]: callback },
        readyByScene: { ...state.readyByScene, [sceneId]: false },
      };
    }),
  markIframeReady: (sceneId) => {
    const state = get();
    const send = state.sendMessageByScene[sceneId];
    if (!send) return;
    const pending = state.pendingMessagesByScene[sceneId] ?? [];
    set((current) => {
      const pendingMessagesByScene = { ...current.pendingMessagesByScene };
      delete pendingMessagesByScene[sceneId];
      return {
        readyByScene: { ...current.readyByScene, [sceneId]: true },
        pendingMessagesByScene,
      };
    });
    pending.forEach(({ type, payload }) => send(type, payload));
  },
  setActiveScene: (sceneId) => set({ activeSceneId: sceneId }),
  getSendMessage: (sceneId) => {
    const state = get();
    const targetId = sceneId ?? state.activeSceneId;
    if (!targetId) return null;
    return (type, payload) => {
      const current = get();
      const send = current.sendMessageByScene[targetId];
      if (send && current.readyByScene[targetId]) {
        send(type, payload);
        return;
      }
      set((latest) => ({
        pendingMessagesByScene: {
          ...latest.pendingMessagesByScene,
          [targetId]: [...(latest.pendingMessagesByScene[targetId] ?? []), { type, payload }],
        },
      }));
    };
  },
}));

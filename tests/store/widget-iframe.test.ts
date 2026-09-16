import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWidgetIframeStore } from '@/lib/store/widget-iframe';

describe('useWidgetIframeStore', () => {
  beforeEach(() => {
    useWidgetIframeStore.setState({
      sendMessageByScene: {},
      readyByScene: {},
      pendingMessagesByScene: {},
      activeSceneId: null,
    });
  });

  it('queues a message sent before the iframe registers and flushes it on ready', () => {
    const send = useWidgetIframeStore.getState().getSendMessage('scene-1');
    expect(send).not.toBeNull();
    send?.('SET_WIDGET_STATE', { value: 1 });

    const postMessage = vi.fn();
    useWidgetIframeStore.getState().registerIframe('scene-1', postMessage);
    expect(postMessage).not.toHaveBeenCalled();

    useWidgetIframeStore.getState().markIframeReady('scene-1');
    expect(postMessage).toHaveBeenCalledWith('SET_WIDGET_STATE', { value: 1 });
  });

  it('flushes queued messages in order and sends later messages immediately', () => {
    const send = useWidgetIframeStore.getState().getSendMessage('scene-1');
    const postMessage = vi.fn();
    useWidgetIframeStore.getState().registerIframe('scene-1', postMessage);

    send?.('FIRST', { order: 1 });
    send?.('SECOND', { order: 2 });
    expect(postMessage).not.toHaveBeenCalled();

    useWidgetIframeStore.getState().markIframeReady('scene-1');
    send?.('THIRD', { order: 3 });

    expect(postMessage.mock.calls).toEqual([
      ['FIRST', { order: 1 }],
      ['SECOND', { order: 2 }],
      ['THIRD', { order: 3 }],
    ]);
  });

  it('returns to queueing when the iframe registers a replacement document', () => {
    const send = useWidgetIframeStore.getState().getSendMessage('scene-1');
    const firstDocument = vi.fn();
    useWidgetIframeStore.getState().registerIframe('scene-1', firstDocument);
    useWidgetIframeStore.getState().markIframeReady('scene-1');
    send?.('BEFORE_RELOAD', {});
    expect(firstDocument).toHaveBeenCalledTimes(1);

    const replacementDocument = vi.fn();
    useWidgetIframeStore.getState().registerIframe('scene-1', replacementDocument);
    send?.('DURING_RELOAD', {});
    expect(replacementDocument).not.toHaveBeenCalled();

    useWidgetIframeStore.getState().markIframeReady('scene-1');
    expect(replacementDocument).toHaveBeenCalledWith('DURING_RELOAD', {});
  });

  it('drops queued messages when a scene iframe is unregistered', () => {
    const send = useWidgetIframeStore.getState().getSendMessage('scene-1');
    send?.('STALE', {});

    useWidgetIframeStore.getState().registerIframe('scene-1', null);
    const postMessage = vi.fn();
    useWidgetIframeStore.getState().registerIframe('scene-1', postMessage);
    useWidgetIframeStore.getState().markIframeReady('scene-1');

    expect(postMessage).not.toHaveBeenCalled();
  });
});

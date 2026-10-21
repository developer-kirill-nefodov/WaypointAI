import { useCallback, useEffect, useRef } from "react";

const MESSAGE_ANCHOR_OFFSET_PX = 16;
/** Scrolled this close to the bottom, the chat follows new messages again. */
const FOLLOW_THRESHOLD_PX = 48;
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"];

/**
 * Keeps the chat on its latest message while the user has not scrolled away: the start of a long answer stays in
 * view instead of jumping to its end. `changes` are the values whose change may grow the chat.
 */
export function useChatScroll({ visible, chatId, changes }: { visible: boolean; chatId: string; changes: unknown[] }) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);

  const scrollToLatest = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
    const latestMessage = viewport.querySelector<HTMLElement>("article.message:last-of-type");
    if (latestMessage?.classList.contains("assistant")) {
      viewport.scrollTop = Math.min(latestMessage.offsetTop - MESSAGE_ANCHOR_OFFSET_PX, maxScrollTop);
      return;
    }
    viewport.scrollTop = maxScrollTop;
  }, []);

  useEffect(() => {
    if (followRef.current) scrollToLatest();
  }, [...changes, scrollToLatest]);

  // When the chat is shown, its answers render lazily and keep growing for a moment: stay on the latest one until
  // they settle or the user scrolls.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!visible || !viewport) return;
    let settling = true;
    const stop = () => { settling = false; };
    const observer = new ResizeObserver(() => { if (settling) scrollToLatest(); });
    observer.observe(viewport);
    viewport.querySelectorAll("article.message").forEach((message) => observer.observe(message));
    scrollToLatest();
    const timer = window.setTimeout(stop, 1500);
    for (const type of USER_SCROLL_EVENTS) viewport.addEventListener(type, stop, { passive: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
      for (const type of USER_SCROLL_EVENTS) viewport.removeEventListener(type, stop);
    };
  }, [visible, chatId, scrollToLatest]);

  const onScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followRef.current = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= FOLLOW_THRESHOLD_PX;
  }, []);
  /** A sent message or another chat brings the conversation back into follow mode. */
  const follow = useCallback(() => { followRef.current = true; }, []);

  return { viewportRef, onScroll, follow };
}

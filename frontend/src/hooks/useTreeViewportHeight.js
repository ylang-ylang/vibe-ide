import { useLayoutEffect, useState } from "react";

export function useTreeViewportHeight(viewportRef, deps = []) {
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) {
      return undefined;
    }

    let animationFrameId = 0;

    function updateHeight(nextHeight) {
      const normalizedHeight = Math.max(0, Math.floor(nextHeight));
      setHeight((previousHeight) => (
        previousHeight === normalizedHeight ? previousHeight : normalizedHeight
      ));
    }

    function measure() {
      updateHeight(element.getBoundingClientRect().height);
    }

    measure();
    animationFrameId = window.requestAnimationFrame(measure);

    if (typeof ResizeObserver === "undefined") {
      return () => {
        window.cancelAnimationFrame(animationFrameId);
      };
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        updateHeight(entry.contentRect.height);
        return;
      }

      measure();
    });

    observer.observe(element);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      observer.disconnect();
    };
  }, [viewportRef, ...deps]);

  return height;
}

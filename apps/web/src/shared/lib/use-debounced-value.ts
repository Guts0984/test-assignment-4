"use client";

import { useEffect, useState } from "react";

/** The value, but only after it stopped changing for `delayMs`. Typing quickly asks the server once, not once per letter. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

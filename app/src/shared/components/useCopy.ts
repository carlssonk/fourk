import { useEffect, useRef, useState } from "react";

/** Report success only after the browser accepts the clipboard write. */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async (text: string) => {
    clearTimeout(timer.current);
    setCopied(false);
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopyError("Couldn't copy. Select the text and copy it manually.");
    }
  };
  return { copied, copyError, copy };
}

"use client";

import { useState } from "react";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API unavailable — nothing to fall back to safely
    }
  }

  return (
    <button className="copy-button" onClick={copy} type="button">
      {copied ? "Copied ✓" : label}
    </button>
  );
}

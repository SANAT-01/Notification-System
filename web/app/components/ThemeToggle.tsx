"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    try {
      const saved = localStorage.getItem("lab-theme");
      if (saved === "light" || saved === "dark") setTheme(saved);
    } catch {
      // ignore
    }
  }, []);

  function apply(next: Theme) {
    setTheme(next);
    try {
      if (next === "system") {
        localStorage.removeItem("lab-theme");
        document.documentElement.removeAttribute("data-theme");
      } else {
        localStorage.setItem("lab-theme", next);
        document.documentElement.setAttribute("data-theme", next);
      }
    } catch {
      // ignore
    }
  }

  const next: Theme = theme === "system" ? "dark" : theme === "dark" ? "light" : "system";
  const icon = theme === "light" ? "☀" : theme === "dark" ? "☾" : "◐";
  const label = theme === "system" ? "Theme: system" : theme === "dark" ? "Theme: dark" : "Theme: light";

  return (
    <button className="button button-ghost icon-button" onClick={() => apply(next)} title={label} aria-label={label}>
      <span aria-hidden>{icon}</span>
    </button>
  );
}

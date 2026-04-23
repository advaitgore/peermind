"use client";

import { useEffect, useState } from "react";

// Dark is default (no class). Light is opt-in via html.light.
export function ThemeToggle() {
  const [light, setLight] = useState(false);
  useEffect(() => {
    const stored = localStorage.getItem("peermind-theme");
    const isLight = stored === "light";
    setLight(isLight);
    document.documentElement.classList.toggle("light", isLight);
  }, []);
  const toggle = () => {
    const next = !light;
    setLight(next);
    document.documentElement.classList.toggle("light", next);
    localStorage.setItem("peermind-theme", next ? "light" : "dark");
  };
  return (
    <button
      onClick={toggle}
      className="icon-btn text-sm"
      aria-label="toggle theme"
      title={light ? "switch to dark" : "switch to light"}
    >
      {light ? "☾" : "☀"}
    </button>
  );
}

export function useIsDark() {
  const [dark, setDark] = useState(true);
  useEffect(() => {
    const check = () => setDark(!document.documentElement.classList.contains("light"));
    check();
    const obs = new MutationObserver(check);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

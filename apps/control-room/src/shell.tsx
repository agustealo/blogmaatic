import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router";

import { useConnection } from "./connection";

const nav = [
  ["/", "Overview"],
  ["/publish", "Publish"],
  ["/connections", "Destinations"],
  ["/groups", "Publishing groups"],
  ["/automations", "Automations"],
  ["/schedules", "Schedules"],
  ["/runs", "Runs"],
  ["/approvals", "Approvals"],
  ["/operations", "Operations"],
  ["/audit", "Audit"],
] as const;

type Theme = "light" | "dark";

function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem("blogmaatic-control-room-theme");
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Storage preference is optional; the product remains usable without it.
  }
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function AppShell() {
  const { session } = useConnection();
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("blogmaatic-control-room-theme", theme);
    } catch {
      // A blocked preference store must never block the Control Room.
    }
  }, [theme]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <aside className="sidebar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">B</span>
          <div><strong>Blogmaatic</strong><span>Control Room</span></div>
        </div>
        <nav className="primary-nav" aria-label="Primary">
          {nav.map(([path, label]) => (
            <NavLink key={path} to={path} end={path === "/"}>
              <span className="nav-dot" aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar__footer">
          <span className="connection-chip"><i /> Runtime session</span>
          <small title={session?.baseUrl}>{session?.baseUrl}</small>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div>
            <span className="topbar__product">Publishing workspace</span>
          </div>
          <div className="topbar__actions">
            <button className="icon-button" type="button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Toggle theme">
              {theme === "dark" ? "☀" : "◐"}
            </button>
          </div>
        </header>
        <div className="mobile-nav" aria-label="Mobile navigation">
          {nav.map(([path, label]) => <NavLink key={path} to={path} end={path === "/"}>{label}</NavLink>)}
        </div>
        <main className="page" id="main-content" tabIndex={-1}><Outlet /></main>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router";

import { useConnection } from "./connection";

const nav = [
  ["/", "Overview"],
  ["/operations", "Operations"],
  ["/approvals", "Approvals"],
  ["/runs", "Runs"],
  ["/automations", "Automations"],
  ["/schedules", "Schedules"],
  ["/audit", "Audit"],
] as const;

type Theme = "light" | "dark";

function initialTheme(): Theme {
  const stored = localStorage.getItem("blogmaatic-control-room-theme");
  if (stored === "light" || stored === "dark") return stored;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function AppShell() {
  const { session } = useConnection();
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("blogmaatic-control-room-theme", theme);
  }, [theme]);

  return (
    <div className="app-shell">
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
            <span className="topbar__product">Operator workspace</span>
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
        <main className="page"><Outlet /></main>
      </div>
    </div>
  );
}

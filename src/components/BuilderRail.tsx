'use client';
import { useEffect, useState, type ReactNode } from 'react';

// The slim menu on the window's left edge, laid out like cqx's dashboard
// sidebar (cqxai/dashboard src/components/DashboardTabBar.tsx): 68px
// collapsed and 220px open, 48px rows, 22px icon wells, the selected label
// underlined, settings pinned to the bottom above the collapse toggle.
const COLLAPSED_KEY = 'zega.builder.rail-collapsed';

type Item = { id: string; label: string; href: string; icon: ReactNode };

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const Icon = ({ children }: { children: ReactNode }) => <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" {...stroke}>{children}</svg>;

const TOP: Item[] = [
  { id: 'build', label: 'Build', href: '/', icon: <Icon><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></Icon> },
  { id: 'history', label: 'History', href: '/history/', icon: <Icon><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 7v5l3 2" /></Icon> },
  { id: 'search', label: 'Search', href: '/search/', icon: <Icon><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon> },
];
const SETTINGS: Item = { id: 'settings', label: 'Settings', href: '/settings/', icon: <Icon><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></Icon> };

export default function BuilderRail({ current }: { current: string }) {
  const [collapsed, setCollapsed] = useState(true);
  useEffect(() => {
    try { setCollapsed(localStorage.getItem(COLLAPSED_KEY) !== 'false'); } catch { /* private storage */ }
  }, []);
  const toggle = () => setCollapsed(value => {
    try { localStorage.setItem(COLLAPSED_KEY, String(!value)); } catch { /* private storage */ }
    return !value;
  });
  const row = (item: Item) => <a key={item.id} className="brail-row" href={item.href} aria-current={item.id === current ? 'page' : undefined} data-tip={item.label} aria-label={item.label}>
    <span className="brail-well">{item.icon}</span><span className="brail-label">{item.label}</span>
  </a>;
  const label = collapsed ? 'Expand' : 'Collapse';
  return <nav className="brail" data-collapsed={collapsed} aria-label="Menu">
    {TOP.map(row)}
    <div className="brail-foot">
      <hr />
      {row(SETTINGS)}
      <hr />
      <button type="button" className="brail-toggle" onClick={toggle} aria-label={label} aria-expanded={!collapsed} data-tip={label}>
        <span className="brail-glyph" data-open={!collapsed}><i /></span>
      </button>
    </div>
  </nav>;
}

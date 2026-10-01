'use client';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

// A low-poly mock desktop that the app's window sits on, so the preview feels
// like the native app it will become: macOS (menu bar + dock), Windows
// (taskbar) or Omarchy (Hyprland tiling with a waybar). The window keeps the
// app's real logical size and is scaled to fit the pane.
export type DesktopTheme = 'macos' | 'windows' | 'omarchy';

export const defaultDesktop = (): DesktopTheme => {
  if (typeof navigator === 'undefined') return 'macos';
  if (/Mac/.test(navigator.userAgent)) return 'macos';
  if (/Windows/.test(navigator.userAgent)) return 'windows';
  return 'omarchy';
};

const PALETTES: Record<DesktopTheme, string[]> = {
  macos: ['#1d2b64', '#3a4d9a', '#7b5ea7', '#c7709a', '#f1a77a'],
  windows: ['#0b2a5b', '#11469c', '#1f6fd1', '#4fa3e8', '#a9d6f5'],
  omarchy: ['#14161d', '#1e2230', '#2b2f45', '#3d3a5a', '#6b5b8a'],
};

// Chrome sizes in logical pixels, kept out of the scaled app area.
const CHROME = {
  macos: { top: 24, bottom: 76, title: 28 },
  windows: { top: 0, bottom: 48, title: 32 },
  omarchy: { top: 30, bottom: 0, title: 0 },
} as const;

function mix(a: string, b: string, t: number) {
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
  return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * t)).join(',')})`;
}

// A jittered triangle grid coloured along a diagonal gradient; seeded so it is
// the same on every render.
function LowPoly({ theme }: { theme: DesktopTheme }) {
  const triangles = useMemo(() => {
    let seed = theme === 'macos' ? 7 : theme === 'windows' ? 11 : 13;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const cols = 14, rows = 9, w = 1600, h = 1000;
    const points: [number, number][][] = [];
    for (let r = 0; r <= rows; r++) {
      points.push([]);
      for (let c = 0; c <= cols; c++) {
        const edge = r === 0 || c === 0 || r === rows || c === cols;
        points[r].push([c * w / cols + (edge ? 0 : (rand() - 0.5) * w / cols * 0.8), r * h / rows + (edge ? 0 : (rand() - 0.5) * h / rows * 0.8)]);
      }
    }
    const palette = PALETTES[theme];
    const colour = (x: number, y: number) => {
      const t = Math.min(0.999, Math.max(0, (x / w) * 0.6 + (y / h) * 0.4 + (rand() - 0.5) * 0.08));
      const i = Math.floor(t * (palette.length - 1));
      return mix(palette[i], palette[i + 1], t * (palette.length - 1) - i);
    };
    const out: { d: string; fill: string }[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const [a, b, d, e] = [points[r][c], points[r][c + 1], points[r + 1][c], points[r + 1][c + 1]];
      for (const tri of [[a, b, e], [a, e, d]]) {
        const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3, cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
        out.push({ d: `M${tri.map(p => p.map(v => v.toFixed(1)).join(' ')).join('L')}Z`, fill: colour(cx, cy) });
      }
    }
    return out;
  }, [theme]);
  return <svg className="desk-wallpaper" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    {triangles.map((t, i) => <path key={i} d={t.d} fill={t.fill} stroke={t.fill} strokeWidth="0.6" />)}
  </svg>;
}

function Clock() {
  // Rendered after mount only: the server's clock and locale would never match.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => { setNow(new Date()); const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t); }, []);
  return <span>{now?.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>;
}

const DOCK = ['#5ac8fa', '#34c759', '#ff9f0a', '#ff375f', '#bf5af2'];

export default function DesktopStage({ theme, name, width, height, children, footer, onResize }: {
  theme: DesktopTheme; name: string; width: number; height: number;
  children: (zoom: number) => ReactNode;
  /** A slim bar right under the window (status and refresh). */
  footer?: ReactNode;
  /** Dragging the window's right edge, bottom edge or corner resizes the app. */
  onResize?: (width: number, height: number) => void;
}) {
  // While dragging, the scale stays what it was when the drag began, so the
  // window follows the pointer instead of rescaling under it.
  const drag = useRef<{ x: number; y: number; w: number; h: number; zoom: number; edge: 'x' | 'y' | 'xy' } | null>(null);
  const [dragZoom, setDragZoom] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setArea({ w: entry.contentRect.width, h: entry.contentRect.height }));
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const chrome = CHROME[theme];
  const margin = 28;
  const FOOTER = 30;
  const fit = area.w ? Math.min(1, (area.w - margin * 2) / width, (area.h - chrome.top - chrome.bottom - chrome.title - FOOTER - margin * 2) / height) : 0;
  const zoom = dragZoom ?? fit;
  const startResize = (edge: 'x' | 'y' | 'xy') => (event: React.PointerEvent) => {
    if (!onResize || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, w: width, h: height, zoom, edge };
    setDragZoom(zoom);
  };
  const moveResize = (event: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !onResize) return;
    // The window is centred, so an edge moves half as far as its size changes.
    const w = d.edge === 'y' ? d.w : Math.round(Math.min(2560, Math.max(320, d.w + 2 * (event.clientX - d.x) / d.zoom)));
    const h = d.edge === 'x' ? d.h : Math.round(Math.min(1600, Math.max(240, d.h + 2 * (event.clientY - d.y) / d.zoom)));
    onResize(w, h);
  };
  const endResize = () => { drag.current = null; setDragZoom(null); };
  const handle = (edge: 'x' | 'y' | 'xy', label: string) => onResize
    ? <div className={`win-resize win-resize-${edge}`} role="separator" aria-label={label} onPointerDown={startResize(edge)} onPointerMove={moveResize} onPointerUp={endResize} onLostPointerCapture={endResize} />
    : null;
  const title = name || 'Untitled app';

  return <div ref={ref} className="desk" data-desktop={theme}>
    <LowPoly theme={theme} />
    {theme === 'macos' && <div className="desk-menubar"><b>{title}</b><span>File</span><span>Edit</span><span>View</span><span>Window</span><span>Help</span><span className="desk-sp" /><Clock /></div>}
    {theme === 'omarchy' && <div className="desk-waybar"><span className="ws on">1</span><span className="ws">2</span><span className="ws">3</span><span className="desk-sp" /><span>{title}</span><span className="desk-sp" /><Clock /></div>}
    {zoom > 0 && <div className="desk-window" style={{ width: width * zoom, top: `calc(50% + ${(chrome.top - chrome.bottom - FOOTER) / 2}px)` }}>
      <div className="win-frame">
        {theme === 'macos' && <div className="win-title mac"><span className="lights"><i /><i /><i /></span><span className="win-name">{title}</span></div>}
        {theme === 'windows' && <div className="win-title win"><span className="win-name">{title}</span><span className="win-btns"><i>―</i><i>▢</i><i className="close">✕</i></span></div>}
        <div className="win-body" style={{ width: width * zoom, height: height * zoom }}>{children(zoom)}</div>
        {handle('x', 'Resize width')}{handle('y', 'Resize height')}{handle('xy', 'Resize window')}
      </div>
      {footer && <div className="win-footer">{footer}</div>}
    </div>}
    {theme === 'macos' && <div className="desk-dock">{DOCK.map((c, i) => <i key={c} style={{ background: `linear-gradient(160deg, ${c}, ${mix(c, '#000000', 0.35)})` }} className={i === 0 ? 'running' : undefined} />)}</div>}
    {theme === 'windows' && <div className="desk-taskbar"><span className="tb-icons">{DOCK.map((c, i) => <i key={c} style={{ background: c }} className={i === 0 ? 'running' : undefined} />)}</span><span className="tb-clock"><Clock /></span></div>}
    <p className="desk-size">{width} × {height}{zoom < 1 && zoom > 0 ? ` · shown at ${Math.round(zoom * 100)}%` : ''}{onResize ? ' · drag an edge to resize' : ''}</p>
  </div>;
}

import { useEffect, useMemo, useRef, useState } from 'react';

export interface Point {
  t: string;
  v: number;
}

/**
 * Single-series time chart (one per measure — small multiples, never a dual axis).
 * 2px line, recessive grid, optional shaded normal range, crosshair + tooltip on hover,
 * and a table view so the values are never available only visually.
 */
export function LineChart({
  title,
  unit,
  points,
  normal,
  decimals = 0,
}: {
  title: string;
  unit: string;
  points: Point[];
  normal?: [number, number];
  decimals?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  // Render at the container's real pixel width so text and strokes stay true size.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(520);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [asTable, points.length > 0]);
  const H = 160;
  const pad = { l: 36, r: 12, t: 10, b: 24 };

  const geo = useMemo(() => {
    if (!points.length) return null;
    const ts = points.map((p) => new Date(p.t).getTime());
    const vs = points.map((p) => p.v);
    let lo = Math.min(...vs, ...(normal ?? []));
    let hi = Math.max(...vs, ...(normal ?? []));
    const span = hi - lo || 1;
    lo = Math.floor(lo - span * 0.1);
    hi = Math.ceil(hi + span * 0.1);
    const t0 = Math.min(...ts);
    const t1 = Math.max(...ts) || t0 + 1;
    const x = (t: number) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (W - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
    const ticks = [lo, (lo + hi) / 2, hi].map((v) => Math.round(v));
    const xs = ts.map(x);
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${xs[i]!.toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    return { x, y, xs, ticks, path, t0, t1 };
  }, [points, normal, W]);

  const latest = points[points.length - 1];
  const fmt = (v: number) => v.toFixed(decimals);
  const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!geo || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < geo.xs.length; i++) if (Math.abs(geo.xs[i]! - px) < Math.abs(geo.xs[best]! - px)) best = i;
    setHover(best);
  }

  const hp = hover !== null ? points[hover] : undefined;

  return (
    <div className="card">
      <div className="chart-head">
        <h3>{title}</h3>
        <button className="link small" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {latest && (
        <div className="chart-latest">
          {fmt(latest.v)} <span className="muted small">{unit}</span>
        </div>
      )}
      {!geo ? (
        <div className="empty">No readings yet</div>
      ) : asTable ? (
        <div className="table-wrap" style={{ maxHeight: 200, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th className="num">{unit}</th>
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map((p) => (
                <tr key={p.t}>
                  <td>{new Date(p.t).toLocaleString()}</td>
                  <td className="num">{fmt(p.v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart" ref={wrapRef}>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`${title}: ${points.length} readings, latest ${latest ? fmt(latest.v) : ''} ${unit}`}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          >
            {normal && (
              <rect className="band" x={pad.l} width={W - pad.l - pad.r} y={geo.y(normal[1])} height={geo.y(normal[0]) - geo.y(normal[1])} />
            )}
            <g className="axis">
              {geo.ticks.map((t) => (
                <g key={t}>
                  <line className="gridline" x1={pad.l} x2={W - pad.r} y1={geo.y(t)} y2={geo.y(t)} />
                  <text x={pad.l - 6} y={geo.y(t) + 4} textAnchor="end">
                    {t}
                  </text>
                </g>
              ))}
              <text x={pad.l} y={H - 4}>
                {time(points[0]!.t)}
              </text>
              <text x={W - pad.r} y={H - 4} textAnchor="end">
                {time(latest!.t)}
              </text>
            </g>
            <path className="series" d={geo.path} />
            {hp && hover !== null && (
              <>
                <line className="crosshair" x1={geo.xs[hover]} x2={geo.xs[hover]} y1={pad.t} y2={H - pad.b} />
                <circle className="dot" cx={geo.xs[hover]} cy={geo.y(hp.v)} r={4.5} />
              </>
            )}
          </svg>
          {hp && hover !== null && (
            <div className="tooltip" style={{ left: `${(geo.xs[hover]! / W) * 100}%`, top: `${(geo.y(hp.v) / H) * 100}%` }}>
              <strong>
                {fmt(hp.v)} {unit}
              </strong>{' '}
              <span className="muted">· {time(hp.t)}</span>
            </div>
          )}
          {normal && (
            <div className="muted small">
              Shaded band: normal range {normal[0]}–{normal[1]} {unit}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

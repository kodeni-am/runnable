import { useState, useEffect, useRef, useMemo, useCallback, type ReactNode } from 'react';
import {
    RefreshCw, Radio, Search, Download, Copy, Trash2,
    WrapText, ArrowDownToLine, Braces, AlertTriangle,
} from 'lucide-react';

type Level = 'error' | 'warn' | 'info' | 'debug';
const LEVELS: Level[] = ['error', 'warn', 'info', 'debug'];

interface ParsedLine {
    raw: string;
    ts: Date | null;
    msg: string;
    level: Level | null;
    json: unknown | null;
}

// docker logs --timestamps prefixes RFC3339Nano, e.g. 2026-05-19T12:00:00.123456789Z
const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+([\s\S]*)$/;

function detectLevel(s: string): Level | null {
    if (/\b(fatal|critical|panic|error|err)\b/i.test(s)) return 'error';
    if (/\b(warn|warning)\b/i.test(s)) return 'warn';
    if (/\b(debug|trace|verbose)\b/i.test(s)) return 'debug';
    if (/\b(info|notice|log)\b/i.test(s)) return 'info';
    return null;
}

function tryJson(s: string): unknown | null {
    const t = s.trim();
    if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
    try { return JSON.parse(t); } catch { return null; }
}

function parse(raw: string): ParsedLine {
    let ts: Date | null = null;
    let body = raw;
    const m = raw.match(TS_RE);
    if (m) {
        const d = new Date(m[1]);
        if (!isNaN(d.getTime())) { ts = d; body = m[2]; }
    }
    const json = tryJson(body);
    let level: Level | null = null;
    if (json && typeof json === 'object' && json !== null) {
        const lv = (json as Record<string, unknown>).level ?? (json as Record<string, unknown>).severity;
        if (typeof lv === 'string') level = detectLevel(lv);
        // Caddy-style epoch ts inside JSON
        const jts = (json as Record<string, unknown>).ts;
        if (!ts && typeof jts === 'number') {
            const d = new Date(jts * 1000);
            if (!isNaN(d.getTime())) ts = d;
        }
    }
    if (!level) level = detectLevel(body);
    return { raw, ts, msg: body, level, json };
}

function highlight(text: string, query: string, regex: boolean): ReactNode {
    if (!query) return text;
    let re: RegExp;
    try {
        re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    } catch { return text; }
    const out: ReactNode[] = [];
    let last = 0;
    let mm: RegExpExecArray | null;
    let i = 0;
    while ((mm = re.exec(text)) !== null) {
        if (mm.index > last) out.push(text.slice(last, mm.index));
        out.push(<mark key={i++} className="lc-mark">{mm[0]}</mark>);
        last = mm.index + mm[0].length;
        if (mm[0].length === 0) re.lastIndex++;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
}

export interface LogConsoleProps {
    title: string;
    fetchLogs: () => Promise<string[]>;
    /** Slot rendered at the far left of the header (e.g. a back button). */
    leftAccessory?: ReactNode;
    /** Re-fetch trigger key — changing it refetches (e.g. selected container). */
    sourceKey?: string;
}

export default function LogConsole({ title, fetchLogs, leftAccessory, sourceKey }: LogConsoleProps) {
    const [lines, setLines] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const [live, setLive] = useState(false);
    const [query, setQuery] = useState('');
    const [regex, setRegex] = useState(false);
    const [off, setOff] = useState<Set<Level>>(new Set());
    const [issuesOnly, setIssuesOnly] = useState(false);
    const [wrap, setWrap] = useState(true);
    const [follow, setFollow] = useState(true);
    const [expanded, setExpanded] = useState<Set<number>>(new Set());
    const endRef = useRef<HTMLDivElement>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            setLines(await fetchLogs());
        } catch {
            setLines(['Failed to fetch logs']);
        }
        setLoading(false);
    }, [fetchLogs]);

    useEffect(() => { load(); }, [load, sourceKey]);

    useEffect(() => {
        if (!live) return;
        const t = setInterval(load, 2000);
        return () => clearInterval(t);
    }, [live, load]);

    const parsed = useMemo(() => lines.map(parse), [lines]);

    const counts = useMemo(() => {
        const c: Record<Level, number> = { error: 0, warn: 0, info: 0, debug: 0 };
        for (const p of parsed) if (p.level) c[p.level]++;
        return c;
    }, [parsed]);

    const filtered = useMemo(() => {
        let re: RegExp | null = null;
        if (query) {
            try {
                re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            } catch { re = null; }
        }
        return parsed
            .map((p, i) => ({ p, i }))
            .filter(({ p }) => {
                // "Issues only" hides everything except error/warn — including
                // untagged lines — and overrides the per-level filters.
                if (issuesOnly) {
                    if (p.level !== 'error' && p.level !== 'warn') return false;
                } else if (p.level && off.has(p.level)) {
                    return false;
                }
                if (query && re && !re.test(p.raw)) return false;
                return true;
            });
    }, [parsed, query, regex, off, issuesOnly]);

    useEffect(() => {
        if (follow) endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [filtered, follow]);

    const toggleLevel = (l: Level) =>
        setOff(prev => {
            const n = new Set(prev);
            n.has(l) ? n.delete(l) : n.add(l);
            return n;
        });

    const visibleText = () => filtered.map(({ p }) => p.raw).join('\n');

    const copy = () => navigator.clipboard?.writeText(visibleText());
    const download = () => {
        const blob = new Blob([visibleText()], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${title.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.log`;
        a.click();
        URL.revokeObjectURL(url);
    };

    // Cap the DOM to the most recent 3000 matching lines for performance.
    const shown = filtered.length > 3000 ? filtered.slice(-3000) : filtered;

    return (
        <div className="lc">
            <div className="lc-header">
                <div className="lc-header-left">
                    {leftAccessory}
                    <h3 className="lc-title">{title}</h3>
                </div>
                <div className="lc-actions">
                    <button
                        className={`btn ${live ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => setLive(v => !v)}
                        style={{ fontSize: 13, padding: '6px 14px' }}
                    >
                        <Radio size={14} className={live ? 'spinning' : ''} /> {live ? 'Live' : 'Go Live'}
                    </button>
                    <button className="btn btn-secondary" onClick={load} disabled={loading} style={{ fontSize: 13, padding: '6px 14px' }}>
                        <RefreshCw size={14} className={loading ? 'spinning' : ''} /> Refresh
                    </button>
                </div>
            </div>

            <div className="lc-toolbar">
                <div className="lc-search">
                    <Search size={14} className="lc-search-icon" />
                    <input
                        className="lc-search-input"
                        placeholder={regex ? 'Search (regex)…' : 'Search logs…'}
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        spellCheck={false}
                    />
                    <button
                        className={`lc-chip ${regex ? 'lc-chip--on' : ''}`}
                        onClick={() => setRegex(r => !r)}
                        title="Toggle regular expression search"
                    >.*</button>
                </div>

                <div className={`lc-levels ${issuesOnly ? 'lc-levels--disabled' : ''}`}>
                    {LEVELS.map(l => (
                        <button
                            key={l}
                            className={`lc-level lc-level--${l} ${off.has(l) ? 'lc-level--off' : ''}`}
                            onClick={() => toggleLevel(l)}
                            disabled={issuesOnly}
                            title={issuesOnly ? 'Disabled while "Issues only" is on' : `Toggle ${l} lines`}
                        >
                            <span className="lc-level-dot" />
                            {l} <span className="lc-level-count">{counts[l]}</span>
                        </button>
                    ))}
                </div>

                <div className="lc-tools">
                    <button
                        className={`lc-tool ${issuesOnly ? 'lc-tool--on' : ''}`}
                        onClick={() => setIssuesOnly(v => !v)}
                        title="Issues only — show errors & warnings, hide all other logs"
                    ><AlertTriangle size={15} /></button>
                    <button className={`lc-tool ${wrap ? 'lc-tool--on' : ''}`} onClick={() => setWrap(w => !w)} title="Wrap lines"><WrapText size={15} /></button>
                    <button className={`lc-tool ${follow ? 'lc-tool--on' : ''}`} onClick={() => setFollow(f => !f)} title="Auto-scroll to newest"><ArrowDownToLine size={15} /></button>
                    <button className="lc-tool" onClick={copy} title="Copy visible logs"><Copy size={15} /></button>
                    <button className="lc-tool" onClick={download} title="Download visible logs"><Download size={15} /></button>
                    <button className="lc-tool" onClick={() => setLines([])} title="Clear view"><Trash2 size={15} /></button>
                </div>
            </div>

            <div className="lc-meta">
                {filtered.length} / {lines.length} lines
                {shown.length < filtered.length && ` · showing last ${shown.length}`}
            </div>

            <div className={`lc-body ${wrap ? '' : 'lc-body--nowrap'}`}>
                {shown.length === 0 ? (
                    <div className="lc-empty">{loading ? 'Loading…' : 'No matching log lines.'}</div>
                ) : shown.map(({ p, i }) => {
                    const isOpen = expanded.has(i);
                    return (
                        <div key={i} className={`lc-line ${p.level ? `lc-line--${p.level}` : ''}`}>
                            {p.ts && (
                                <span className="lc-ts" title={p.ts.toISOString()}>
                                    {p.ts.toLocaleTimeString()}
                                </span>
                            )}
                            {p.level && <span className={`lc-tag lc-tag--${p.level}`}>{p.level}</span>}
                            {p.json ? (
                                <span className="lc-msg">
                                    <button
                                        className="lc-json-toggle"
                                        onClick={() => setExpanded(prev => {
                                            const n = new Set(prev);
                                            n.has(i) ? n.delete(i) : n.add(i);
                                            return n;
                                        })}
                                        title="Toggle JSON formatting"
                                    >
                                        <Braces size={12} /> {isOpen ? 'collapse' : 'json'}
                                    </button>
                                    {isOpen
                                        ? <pre className="lc-json">{JSON.stringify(p.json, null, 2)}</pre>
                                        : <span className="lc-msg-text">{highlight(p.msg, query, regex)}</span>}
                                </span>
                            ) : (
                                <span className="lc-msg"><span className="lc-msg-text">{highlight(p.msg, query, regex)}</span></span>
                            )}
                        </div>
                    );
                })}
                <div ref={endRef} />
            </div>
        </div>
    );
}

// Small shared pieces: the icon set, notices, a copy button, tabs, and the dialog that asks before something irreversible.
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";

// One icon set, drawn for Braid on a 16px grid with a 1.5px stroke. Several are small strand drawings.
const ICONS = {
	check: <path d="M3 8.5l3.2 3.2L13 5" />,
	x: <path d="M4 4l8 8M12 4l-8 8" />,
	plus: <path d="M8 3v10M3 8h10" />,
	arrow: <path d="M3 8h10M9 4l4 4-4 4" />,
	back: <path d="M13 8H3M7 4L3 8l4 4" />,
	"chevron-right": <path d="M6 3.5l4.5 4.5L6 12.5" />,
	"chevron-down": <path d="M3.5 6l4.5 4.5L12.5 6" />,
	land: <><path d="M2 4h12M2 12h3c3 0 2-8 5-8" /><circle cx="10.5" cy="4" r="1.6" fill="currentColor" stroke="none" /></>,
	fork: <path d="M2 4h12M4 4c3 0 2 8 5 8h5" />,
	conflict: <path d="M2 5h3.5l5 6H14M2 11h3.5l5-6H14" />,
	overlap: <path d="M2 6c2-2 4 2 6 0s4-2 6 0M2 10c2-2 4 2 6 0s4-2 6 0" />,
	reconcile: <path d="M2 4h2.5c3 0 2 4 5 4H14M2 12h2.5c3 0 2-4 5-4" />,
	decision: <path d="M8 2l6 6-6 6-6-6z" />,
	assumption: <path d="M8 2l6 6-6 6-6-6z" strokeDasharray="2 2" />,
	question: <><path d="M6 6.2a2 2 0 1 1 3 1.7c-.7.4-1 .9-1 1.7" /><circle cx="8" cy="12.2" r=".9" fill="currentColor" stroke="none" /></>,
	rejected: <><circle cx="8" cy="8" r="5.5" /><path d="M4.2 11.8l7.6-7.6" /></>,
	note: <path d="M3 4.5h10M3 8h10M3 11.5h6" />,
	feedback: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />,
	answer: <path d="M6 4L2.5 7.5 6 11M2.5 7.5H10a3.5 3.5 0 0 1 3.5 3.5v1" />,
	running: <path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5" />,
	file: <path d="M4 2h5l3 3v9H4zM9 2v3h3" />,
	folder: <path d="M2 4.5h4.5L8 6h6v7H2z" />,
	copy: <path d="M6 6h7.5v7.5H6zM10 6V2.5H2.5V10H6" />,
	external: <path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5" />,
	clock: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></>,
	agent: <><path d="M3.5 5.5h9v7h-9zM8 5.5V3" /><circle cx="6.2" cy="9" r=".9" fill="currentColor" stroke="none" /><circle cx="9.8" cy="9" r=".9" fill="currentColor" stroke="none" /></>,
	sandbox: <path d="M2.5 5L8 2.5 13.5 5v6L8 13.5 2.5 11zM2.5 5L8 7.5 13.5 5M8 7.5v6" />,
	push: <path d="M8 13V3M4 7l4-4 4 4" />,
	claim: <circle cx="8" cy="8" r="5.5" strokeDasharray="2 2" />,
	intent: <><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="1.7" fill="currentColor" stroke="none" /></>,
	eye: <><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></>,
	lock: <path d="M3.5 7.5h9v6h-9zM5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5" />,
	globe: <><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11" /></>,
	search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></>,
	trash: <path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.5 9h6l.5-9" />,
	edit: <path d="M3 13l.5-3L10.5 3 13 5.5l-7 7z" />,
	stop: <path d="M4.5 4.5h7v7h-7z" />,
	undo: <path d="M5.5 3L2.5 6l3 3M2.5 6h7a3.5 3.5 0 0 1 0 7H7" />,
	message: <path d="M2.5 4h11v8.5h-11zM2.5 4.5L8 9l5.5-4.5" />,
	warning: <><path d="M8 2.5l6 10.5H2zM8 6.5v3" /><circle cx="8" cy="11.2" r=".8" fill="currentColor" stroke="none" /></>,
	info: <><circle cx="8" cy="8" r="5.5" /><path d="M8 7.5V11" /><circle cx="8" cy="5.3" r=".8" fill="currentColor" stroke="none" /></>,
	terminal: <path d="M2.5 3.5h11v9h-11zM5 6.5L7 8 5 9.5M8.5 10H11" />,
	play: <path d="M5 3.5l7 4.5-7 4.5z" />,
	changes: <path d="M5 2.5v5M2.5 5h5M8.5 11h5M3 13.5L13 2.5" />,
	say: <circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none" />,
	result: <path d="M13 4v3.5a2 2 0 0 1-2 2H3.5M6.5 6.5l-3 3 3 3" />,
	dot: <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />,
	strands: <path d="M2 4.5c6 0 6 7 12 7M2 11.5c6 0 6-7 12-7" />,
} as const;
export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, label, className = "" }: { name: IconName; size?: number; label?: string; className?: string }) {
	return (
		<svg className={`icon ${className}`} viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
			{...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}>
			{ICONS[name]}
		</svg>
	);
}

/** A message about something that went wrong, might go wrong, or is worth knowing, with an icon so colour is not the only signal. */
export function Notice({ tone = "bad", children, small }: { tone?: "bad" | "warn" | "info"; children: ReactNode; small?: boolean }) {
	return (
		<p className={`notice ${tone} ${small ? "small" : ""}`} role={tone === "bad" ? "alert" : undefined}>
			<Icon name={tone === "info" ? "info" : "warning"} /><span>{children}</span>
		</p>
	);
}

/** Copies text and says so. Falls back to telling the reader to select it. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
	const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
	const copy = async () => {
		try { await navigator.clipboard.writeText(text); setState("copied"); } catch { setState("failed"); }
		setTimeout(() => setState("idle"), 1800);
	};
	return (
		<button type="button" className="copy" onClick={copy} aria-live="polite">
			<Icon name={state === "copied" ? "check" : "copy"} />{state === "copied" ? "Copied" : state === "failed" ? "Select it instead" : label}
		</button>
	);
}

/** A command on the one dark surface, with its copy button. */
export function Command({ text, label }: { text: string; label?: string }) {
	return (
		<div className="command">
			<pre className="cmd" tabIndex={0} aria-label="Command"><code>{text}</code></pre>
			<CopyButton text={text} label={label} />
		</div>
	);
}

export type Tab<T extends string> = { id: T; label: string; icon: IconName; badge?: ReactNode };
/** Tabs that follow the keyboard pattern: arrows move between tabs, Home and End jump to the ends. */
export function Tabs<T extends string>({ tabs, value, onChange, label, idBase }: { tabs: Tab<T>[]; value: T; onChange: (id: T) => void; label: string; idBase: string }) {
	const key = (e: KeyboardEvent<HTMLDivElement>) => {
		const i = tabs.findIndex((t) => t.id === value);
		const next = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
		if (next < 0) return;
		e.preventDefault();
		onChange(tabs[next].id);
		(e.currentTarget.children[next] as HTMLElement | undefined)?.focus();
	};
	return (
		<div className="tabs" role="tablist" aria-label={label} onKeyDown={key}>
			{tabs.map((t) => (
				<button key={t.id} role="tab" id={`${idBase}-tab-${t.id}`} aria-controls={`${idBase}-panel`} aria-selected={value === t.id} tabIndex={value === t.id ? 0 : -1} onClick={() => onChange(t.id)}>
					<Icon name={t.icon} />{t.label}{t.badge}
				</button>
			))}
		</div>
	);
}

type Question = { title: string; body?: ReactNode; confirm: string; danger?: boolean; input?: { label: string; placeholder?: string } };
type Pending = Question & { done: (answer: string | null) => void };
/**
 * Ask before doing something that cannot be quietly undone. Resolves null when the person backs out,
 * otherwise what they typed (or an empty string when nothing was asked for).
 */
export function ask(q: Question): Promise<string | null> {
	return new Promise((done) => window.dispatchEvent(new CustomEvent<Pending>("braid:ask", { detail: { ...q, done } })));
}
export function AskHost() {
	const ref = useRef<HTMLDialogElement>(null);
	const [q, setQ] = useState<Pending | null>(null);
	const [text, setText] = useState("");
	const id = useId();
	useEffect(() => {
		const open = (e: Event) => { setQ((e as CustomEvent<Pending>).detail); setText(""); };
		window.addEventListener("braid:ask", open);
		return () => window.removeEventListener("braid:ask", open);
	}, []);
	useEffect(() => { if (q && !ref.current?.open) ref.current?.showModal(); }, [q]);
	const finish = (answer: string | null) => { q?.done(answer); ref.current?.close(); setQ(null); };
	const submit = (e: FormEvent) => { e.preventDefault(); finish(q?.input ? text.trim() : ""); };
	return (
		<dialog ref={ref} className="dialog" onCancel={(e) => { e.preventDefault(); finish(null); }} aria-labelledby={`${id}-t`}>
			{q && (
				<form onSubmit={submit} className="form">
					<h2 id={`${id}-t`}>{q.title}</h2>
					{q.body && <div className="dialog-body">{q.body}</div>}
					{q.input && <label>{q.input.label}<textarea rows={3} value={text} placeholder={q.input.placeholder} onChange={(e) => setText(e.target.value)} autoFocus required /></label>}
					<div className="row dialog-actions">
						<button type="button" onClick={() => finish(null)} autoFocus={!q.input}>Cancel</button>
						<button className={q.danger ? "danger solid" : "primary"} disabled={!!q.input && !text.trim()}>{q.confirm}</button>
					</div>
				</form>
			)}
		</dialog>
	);
}

/** The four corner ticks of a framed section. */
export function Corners() {
	return <><i className="corner tl" aria-hidden="true" /><i className="corner tr" aria-hidden="true" /><i className="corner bl" aria-hidden="true" /><i className="corner br" aria-hidden="true" /></>;
}

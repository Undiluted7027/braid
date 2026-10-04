import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionEvent, State } from "../shared/types";

// A protected instance answers 401 until the browser has signed in; ask for the admin token once,
// however many requests were refused at the same moment. The server keeps the session in a cookie.
let signingIn: Promise<boolean> | null = null;
/** Ask for the admin token in the sign-in dialog (see SignIn in App.tsx). Resolves true once the server has accepted it. */
export function signIn(): Promise<boolean> {
	signingIn ??= new Promise<boolean>((done) => window.dispatchEvent(new CustomEvent("braid:signin", { detail: done }))).finally(() => { signingIn = null; });
	return signingIn;
}
export async function tryToken(token: string) {
	const res = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
	if (res.ok) window.dispatchEvent(new Event("braid:signed-in"));
	return res.ok;
}

/** Whether this browser is signed in. On an instance with no admin token everyone is. */
export function useSignedIn() {
	const [me, setMe] = useState<{ signedIn: boolean; protected: boolean } | null>(null);
	useEffect(() => {
		const load = () => fetch("/api/me").then((r) => r.json()).then((m) => setMe(m as { signedIn: boolean; protected: boolean }), () => {});
		load();
		window.addEventListener("braid:signed-in", load);
		return () => window.removeEventListener("braid:signed-in", load);
	}, []);
	return me;
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
	const send = () => fetch(`/api${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } });
	let res = await send();
	if (res.status === 401 && await signIn()) res = await send();
	if (res.status === 401) throw new Error("Sign in with this instance's admin token to do that.");
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error((data as any).error ?? `${res.status} ${res.statusText}`);
	return data as T;
}

/** Project state, refetched whenever the project's Durable Object says something changed. */
export function useProject(slug: string) {
	const [state, setState] = useState<State | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [live, setLive] = useState(false);
	const pending = useRef<number | null>(null);

	const reload = useCallback(async () => {
		try {
			setState(await api<State>("GET", `/p/${slug}`));
			setError(null);
		} catch (e) {
			setError((e as Error).message);
		}
	}, [slug]);

	useEffect(() => {
		let closed = false;
		let ws: WebSocket | null = null;
		let retry: number | undefined;
		const connect = () => {
			ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/p/${slug}/ws`);
			ws.onopen = () => { setLive(true); reload(); };
			ws.onmessage = (message) => {
				// Session events are pushed whole; everything else is a hint to refetch state.
				if (typeof message.data === "string" && message.data.startsWith("{")) {
					const data = JSON.parse(message.data);
					if (data.type === "session") window.dispatchEvent(new CustomEvent("braid:session", { detail: data }));
					return;
				}
				// Bursts of changes (a push touches many rows) become one refetch.
				if (pending.current) return;
				pending.current = window.setTimeout(() => { pending.current = null; reload(); }, 120);
			};
			ws.onclose = () => { setLive(false); if (!closed) retry = window.setTimeout(connect, 1500); };
		};
		reload();
		connect();
		// Signing in turns a read-only view into the full one.
		window.addEventListener("braid:signed-in", reload);
		return () => { closed = true; clearTimeout(retry); ws?.close(); window.removeEventListener("braid:signed-in", reload); };
	}, [slug, reload]);

	return { state, error, live, reload };
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let stale = false;
		setError(null);
		fn().then((d) => { if (!stale) setData(d); }, (e) => { if (!stale) setError(e.message); });
		return () => { stale = true; };
	}, deps);
	return { data, error };
}

export const short = (sha: string) => sha.slice(0, 7);
export function ago(at: number) {
	const s = Math.max(0, Math.round((Date.now() - at) / 1000));
	if (s < 5) return "just now";
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
}

// One hue per intent, reused everywhere an intent appears (strands, chips, blame).
const HUES = ["#c2410c", "#0f766e", "#6d28d9", "#b45309", "#be185d", "#1d4ed8", "#4d7c0f", "#0e7490"];
export const intentColor = (id: number) => HUES[(id - 1) % HUES.length];

export function navigate(to: string) {
	history.pushState(null, "", to);
	window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Live session events for one attempt, as they are pushed over the project socket. */
export function onSession(attemptId: string, handler: (events: SessionEvent[]) => void) {
	const listen = (e: Event) => {
		const detail = (e as CustomEvent<{ attemptId: string; events: SessionEvent[] }>).detail;
		if (detail.attemptId === attemptId) handler(detail.events);
	};
	window.addEventListener("braid:session", listen);
	return () => window.removeEventListener("braid:session", listen);
}

/** What an attempt's agent is doing right now: the latest session event, kept current by the socket. */
export function useNow(attemptId: string, initial: { kind: string; tool: string | null; text: string; at: number } | null | undefined) {
	const [now, setNow] = useState(initial ?? null);
	useEffect(() => setNow(initial ?? null), [attemptId, initial?.at]);
	useEffect(() => onSession(attemptId, (events) => setNow(events[events.length - 1])), [attemptId]);
	return now;
}

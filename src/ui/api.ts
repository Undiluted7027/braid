import { useCallback, useEffect, useRef, useState } from "react";
import type { State } from "../shared/types";

const TOKEN_KEY = "braid:admin-token";
const stored = () => { try { return localStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; } };

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
	const send = (token: string) => fetch(`/api${path}`, {
		method, body: body ? JSON.stringify(body) : undefined,
		headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
	});
	let res = await send(stored());
	if (res.status === 401) {
		// A deployed instance protects changes with an admin token; ask once and remember it.
		const token = window.prompt("This Braid instance needs its admin token to make changes:") ?? "";
		if (token) {
			try { localStorage.setItem(TOKEN_KEY, token); } catch {}
			res = await send(token);
		}
	}
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
			ws.onmessage = () => {
				// Bursts of changes (a push touches many rows) become one refetch.
				if (pending.current) return;
				pending.current = window.setTimeout(() => { pending.current = null; reload(); }, 120);
			};
			ws.onclose = () => { setLive(false); if (!closed) retry = window.setTimeout(connect, 1500); };
		};
		reload();
		connect();
		return () => { closed = true; clearTimeout(retry); ws?.close(); };
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

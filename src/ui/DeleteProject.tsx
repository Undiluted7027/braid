import { useState, type FormEvent } from "react";
import type { State } from "../shared/types";
import { api, navigate } from "./api";
import { useAction } from "./App";
import { Icon, Notice } from "./Kit";

/** Deleting removes trunk and every attempt repo, so the name has to be typed out first. */
export function DeleteProject({ state }: { state: State }) {
	const { slug, name } = state.project;
	const [open, setOpen] = useState(false);
	const [typed, setTyped] = useState("");
	const remove = useAction();
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (typed !== name) return;
		if (await remove.run(() => api("DELETE", `/p/${slug}`))) navigate("/");
	};
	const close = () => { setOpen(false); setTyped(""); };
	if (!open) return <div className="danger-zone"><button className="danger" onClick={() => setOpen(true)}><Icon name="trash" />Delete this project…</button></div>;
	return (
		<form className="panel form danger-zone open" onSubmit={submit}>
			<h3>Delete {name}</h3>
			<p>This removes the trunk repository, all {state.attempts.length} attempt repositor{state.attempts.length === 1 ? "y" : "ies"}, and every intent and recorded decision. It cannot be undone.</p>
			<label>Type <strong className="mono">{name}</strong> to confirm<input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} autoFocus /></label>
			{remove.error && <Notice>{remove.error}</Notice>}
			<div className="row"><button className="danger solid" disabled={typed !== name || remove.busy}>{remove.busy ? "Deleting…" : "Delete this project"}</button><button type="button" onClick={close}>Cancel</button></div>
		</form>
	);
}

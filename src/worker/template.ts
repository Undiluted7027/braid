// Starter repo for a new project: a small no-build web app, so every attempt can be
// previewed straight from its Artifacts repo.
export const DEMO_FILES: Record<string, string> = {
	"README.md": `# Tally

A tiny counter board. No build step: open \`index.html\`.

- \`index.html\` — markup
- \`styles.css\` — all styling, colors are CSS variables on \`:root\`
- \`app.js\` — state, rendering, and event handling
`,
	"AGENTS.md": `# Working in this repo

- Plain HTML, CSS, and JavaScript. No dependencies, no build step.
- All state lives in the \`state\` object in \`app.js\`; \`render()\` redraws from it.
- Colors must come from the CSS variables in \`styles.css\`.
- Keep \`index.html\` loadable by opening the file directly.
`,
	"index.html": `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Tally</title>
	<link rel="stylesheet" href="styles.css">
</head>
<body>
	<header class="top">
		<h1>Tally</h1>
		<div class="actions">
			<button id="add">Add counter</button>
		</div>
	</header>
	<main id="board" class="board"></main>
	<footer class="foot"><span id="total"></span></footer>
	<script src="app.js"></script>
</body>
</html>
`,
	"styles.css": `:root {
	--bg: #f6f5f1;
	--card: #ffffff;
	--ink: #1c1b19;
	--muted: #77736b;
	--accent: #d9480f;
	--line: #e4e1da;
}

* { box-sizing: border-box; }

body {
	margin: 0;
	font-family: system-ui, sans-serif;
	background: var(--bg);
	color: var(--ink);
}

.top {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 20px 24px;
	border-bottom: 1px solid var(--line);
}

.top h1 { margin: 0; font-size: 20px; }

button {
	font: inherit;
	padding: 6px 12px;
	border: 1px solid var(--line);
	border-radius: 6px;
	background: var(--card);
	color: var(--ink);
	cursor: pointer;
}

.board {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
	gap: 16px;
	padding: 24px;
}

.card {
	background: var(--card);
	border: 1px solid var(--line);
	border-radius: 10px;
	padding: 16px;
}

.card .name { color: var(--muted); font-size: 13px; }
.card .count { font-size: 40px; font-weight: 700; margin: 8px 0; }
.card .row { display: flex; gap: 8px; }

.foot { padding: 0 24px 24px; color: var(--muted); font-size: 13px; }
`,
	"app.js": `const state = {
	counters: [
		{ id: 1, name: "Coffee", count: 2 },
		{ id: 2, name: "Walks", count: 1 },
	],
	nextId: 3,
};

function addCounter() {
	state.counters.push({ id: state.nextId++, name: "Counter " + state.counters.length, count: 0 });
	render();
}

function bump(id, delta) {
	const counter = state.counters.find((c) => c.id === id);
	if (!counter) return;
	counter.count = Math.max(0, counter.count + delta);
	render();
}

function render() {
	const board = document.getElementById("board");
	board.innerHTML = "";
	for (const counter of state.counters) {
		const card = document.createElement("div");
		card.className = "card";
		card.innerHTML =
			'<div class="name">' + counter.name + "</div>" +
			'<div class="count">' + counter.count + "</div>" +
			'<div class="row"><button data-d="-1">-</button><button data-d="1">+</button></div>';
		for (const button of card.querySelectorAll("button")) {
			button.addEventListener("click", () => bump(counter.id, Number(button.dataset.d)));
		}
		board.appendChild(card);
	}
	const total = state.counters.reduce((sum, c) => sum + c.count, 0);
	document.getElementById("total").textContent = "Total: " + total;
}

document.getElementById("add").addEventListener("click", addCounter);
render();
`,
};

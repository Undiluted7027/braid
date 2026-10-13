# The sandbox image: Braid verifies attempts in it (clone, install, checks, build) and runs hosted agents in it.
# One file builds an image per toolchain (see wrangler.jsonc): every image has Node, git and the agent CLIs, and
# TOOLCHAIN adds one language on top. Braid picks the image from the files of the commit it is about to run.
FROM node:24-trixie-slim

RUN apt-get update \
	&& apt-get install --yes --no-install-recommends bash ca-certificates curl git python3 ripgrep \
	&& rm -rf /var/lib/apt/lists/*

# Pinned: the flags and event formats of the agent CLIs change between releases.
# One layer per tool: a layer is sent to the registry in one piece, and smaller pieces survive a poor connection.
# Claude Code's install script puts its native binary in place, so it has to be allowed to run.
RUN npm install --global --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@2.1.289 \
	&& npm cache clean --force && claude --version
RUN npm install --global --ignore-scripts pnpm@11 @openai/codex@0.160.0 \
	&& npm cache clean --force && codex --version && pnpm --version

ARG TOOLCHAIN=node
ENV CARGO_HOME=/opt/cargo RUSTUP_HOME=/opt/rustup PATH=/opt/cargo/bin:/usr/local/go/bin:$PATH
# The toolchain goes on in two layers, system packages and then the language's own tools, so that no one layer is very large to send.
RUN set -eu; case "$TOOLCHAIN" in \
	node) exit 0 ;; \
	python) packages="python3-pip python3-venv python3-dev build-essential" ;; \
	go) packages="golang-go build-essential" ;; \
	rust) packages="build-essential pkg-config libssl-dev" ;; \
	java) packages="default-jdk-headless maven" ;; \
	*) echo "unknown TOOLCHAIN $TOOLCHAIN" >&2; exit 1 ;; \
	esac; apt-get update && apt-get install --yes --no-install-recommends $packages && rm -rf /var/lib/apt/lists/*
RUN set -eu; case "$TOOLCHAIN" in \
	python) \
		# The usual checkers, for projects that use them without listing them; a project's own versions win inside its environment.
		# --ignore-installed: Debian's own copies of a few shared packages cannot be replaced by pip, so pip's go beside them.
		pip install --break-system-packages --no-cache-dir --ignore-installed uv poetry pytest ruff mypy \
		&& python3 --version && uv --version && pytest --version ;; \
	go) go version ;; \
	rust) \
		curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --component clippy,rustfmt --no-modify-path \
		&& chmod -R a+rwX /opt/cargo /opt/rustup && cargo --version ;; \
	java) java -version && mvn --version ;; \
	*) ;; \
	esac

WORKDIR /workspace
CMD ["sleep", "infinity"]

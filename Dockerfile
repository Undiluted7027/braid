# The sandbox image: Braid verifies attempts in it (clone, install, checks, build) and runs hosted agents in it.
# One file builds an image per toolchain (see wrangler.jsonc): every image has Node, git and the agent CLIs, and
# TOOLCHAIN adds one language on top. Braid picks the image from the files of the commit it is about to run.
FROM node:24-trixie-slim

RUN apt-get update \
	&& apt-get install --yes --no-install-recommends bash ca-certificates curl git python3 ripgrep \
	&& rm -rf /var/lib/apt/lists/*

# Pinned: the flags and event formats of the agent CLIs change between releases.
# Claude Code's install script puts its native binary in place, so it has to be allowed to run.
RUN npm install --global --allow-scripts=@anthropic-ai/claude-code pnpm@11 @anthropic-ai/claude-code@2.1.289 \
	&& npm install --global --ignore-scripts @openai/codex@0.160.0 \
	&& npm cache clean --force \
	&& claude --version && codex --version && pnpm --version

ARG TOOLCHAIN=node
ENV CARGO_HOME=/opt/cargo RUSTUP_HOME=/opt/rustup PATH=/opt/cargo/bin:/usr/local/go/bin:$PATH
RUN set -eu; case "$TOOLCHAIN" in \
	node) ;; \
	python) \
		apt-get update && apt-get install --yes --no-install-recommends python3-pip python3-venv python3-dev build-essential && rm -rf /var/lib/apt/lists/* \
		# The usual checkers, for projects that use them without listing them; a project's own versions win inside its environment.
		# --ignore-installed: Debian's own copies of a few shared packages cannot be replaced by pip, so pip's go beside them.
		&& pip install --break-system-packages --no-cache-dir --ignore-installed uv poetry pytest ruff mypy \
		&& python3 --version && uv --version && pytest --version ;; \
	go) \
		apt-get update && apt-get install --yes --no-install-recommends golang-go build-essential && rm -rf /var/lib/apt/lists/* \
		&& go version ;; \
	rust) \
		apt-get update && apt-get install --yes --no-install-recommends build-essential pkg-config libssl-dev && rm -rf /var/lib/apt/lists/* \
		&& curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --component clippy,rustfmt --no-modify-path \
		&& chmod -R a+rwX /opt/cargo /opt/rustup && cargo --version ;; \
	java) \
		apt-get update && apt-get install --yes --no-install-recommends default-jdk-headless maven && rm -rf /var/lib/apt/lists/* \
		&& java -version && mvn --version ;; \
	*) echo "unknown TOOLCHAIN $TOOLCHAIN" >&2; exit 1 ;; \
	esac

WORKDIR /workspace
CMD ["sleep", "infinity"]

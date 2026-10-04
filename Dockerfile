# The sandbox image: Braid verifies attempts in it (clone, install, checks, build) and runs hosted agents in it.
FROM node:24-trixie-slim

RUN apt-get update \
	&& apt-get install --yes --no-install-recommends bash ca-certificates git ripgrep \
	&& rm -rf /var/lib/apt/lists/*

# Pinned: the flags and event formats of the agent CLIs change between releases.
# Claude Code's install script puts its native binary in place, so it has to be allowed to run.
RUN npm install --global --allow-scripts=@anthropic-ai/claude-code pnpm@11 @anthropic-ai/claude-code@2.1.289 \
	&& npm install --global --ignore-scripts @openai/codex@0.160.0 \
	&& npm cache clean --force \
	&& claude --version && codex --version && pnpm --version

WORKDIR /workspace
CMD ["sleep", "infinity"]

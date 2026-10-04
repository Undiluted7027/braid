# The sandbox Braid verifies attempts in: clone, install, run the project's checks, build.
FROM node:24-trixie-slim

RUN apt-get update \
	&& apt-get install --yes --no-install-recommends ca-certificates git \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm install --global pnpm@11 \
	&& npm cache clean --force

CMD ["sleep", "infinity"]

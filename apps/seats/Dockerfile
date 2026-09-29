# Flare Actions seat image: a plain Linux toolchain box. The seat Durable
# Object drives everything through exec calls, so the entrypoint just
# sleeps — no agent code lives in here, and runner logic changes never
# require an image rebuild.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
  git python3 ca-certificates bash tar \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /work
CMD ["sleep", "infinity"]

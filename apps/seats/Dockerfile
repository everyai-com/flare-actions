# Flare Actions seat image: a plain Linux toolchain box. The seat Durable
# Object drives everything through exec calls, so the entrypoint just
# sleeps — no agent code lives in here, and runner logic changes never
# require an image rebuild.
FROM node:22-slim

# Per-domain egress shim (egress.c): compiled in-image so the .so always
# matches the runtime glibc, then the toolchain is purged in the same
# layer — the final image carries only /opt/flare/egress.so (~70KB).
COPY egress.c /tmp/egress.c
RUN apt-get update && apt-get install -y --no-install-recommends \
  git python3 ca-certificates bash tar gcc libc6-dev \
  && mkdir -p /opt/flare \
  && gcc -O2 -Wall -Wextra -shared -fPIC -o /opt/flare/egress.so /tmp/egress.c -ldl \
  && rm /tmp/egress.c \
  && apt-get purge -y gcc libc6-dev && apt-get autoremove -y --purge \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/*

WORKDIR /work
CMD ["sleep", "infinity"]

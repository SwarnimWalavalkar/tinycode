FROM docker.io/cloudflare/sandbox:0.12.4

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv python3-pip \
    && apt-get clean

WORKDIR /workspace

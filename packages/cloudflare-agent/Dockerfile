FROM docker.io/cloudflare/sandbox:0.12.4

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv python3-pip python3-aiohttp git gh zsh zsh-syntax-highlighting \
    && git --version \
    && gh --version \
    && apt-get clean

WORKDIR /workspace

COPY supervisor.py /usr/local/lib/tinycode-supervisor.py
COPY terminal.py /usr/local/lib/tinycode-terminal.py
COPY terminal.zshrc /etc/zsh/zshrc
COPY terminal_test.py /tmp/terminal_test.py
RUN python3 -m unittest discover -s /tmp -p terminal_test.py -v \
    && rm -f /tmp/terminal_test.py

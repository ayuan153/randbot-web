FROM nvidia/cuda:12.1.0-runtime-ubuntu22.04

# Install Node.js 20 and Python
RUN apt-get update && \
    apt-get install -y curl python3 python3-pip && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Node.js sim server
WORKDIR /app/self-play
COPY self-play/package*.json ./
RUN npm ci
COPY self-play/sim/ ./sim/
COPY self-play/mcts/ ./mcts/
COPY self-play/tsconfig.json ./

# Python training
WORKDIR /app/training
COPY self-play/training/requirements.txt ./
RUN pip3 install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cu121 -r requirements.txt
COPY self-play/training/ ./

# Feature extraction from main training pipeline
COPY training/features/ /app/features/

# Run script
WORKDIR /app
COPY self-play/run.sh ./
RUN chmod +x run.sh

ENV NUM_GAMES=50000
ENV NUM_WORKERS=8
ENV NUM_ITERATIONS=50
ENV EPOCHS=20
ENV OUTPUT_DIR=/app/output

ENTRYPOINT ["./run.sh"]

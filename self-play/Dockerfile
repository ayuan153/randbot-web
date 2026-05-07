FROM nvidia/cuda:12.1-runtime-ubuntu22.04

# Install Node.js 20 and Python
RUN apt-get update && \
    apt-get install -y curl python3 python3-pip && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Node.js sim server
WORKDIR /app/self-play
COPY self-play/package*.json ./
RUN npm ci --production
COPY self-play/ ./

# Python training
WORKDIR /app/training
COPY self-play/training/requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt
COPY self-play/training/ ./
COPY training/features/ /app/features/

WORKDIR /app
COPY self-play/run.sh ./
RUN chmod +x run.sh

ENTRYPOINT ["./run.sh"]

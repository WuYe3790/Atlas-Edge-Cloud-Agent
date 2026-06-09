FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# System dependencies:
#   build-essential  – C compiler for numpy / faiss
#   curl              – health-check and apt transport
#   libgl1-mesa-glx   – shared library required by OpenCV (cv2)
#   libglib2.0-0      – OpenCV GUI backend (headless still needs this)
#
# Node.js 22.x (LTS) – required by 12306-mcp train ticket tools
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        curl \
        libgl1-mesa-glx \
        libglib2.0-0 \
        ca-certificates \
        gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 5000

CMD ["python", "app.py"]

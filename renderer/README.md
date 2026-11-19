PiShelf PDF.js server-side image renderer.

The Node.js service runs on the Docker Compose internal network and is not exposed on the host. The Python API validates requested PDF paths and forwards them to this service. PDF.js renders pages on the Raspberry Pi into JPEG or PNG; Safari receives only image bytes. Node 22 and @napi-rs/canvas are required. Password-protected PDFs are not supported.

Build and run: docker compose up -d --build

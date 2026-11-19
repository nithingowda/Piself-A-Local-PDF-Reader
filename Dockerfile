FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN python -m pip install --no-cache-dir --disable-pip-version-check -r requirements.txt
RUN groupadd --gid 1000 pishelf && useradd --uid 1000 --gid 1000 --no-create-home pishelf \
    && mkdir -p /data /magazines && chown 1000:1000 /data /magazines
COPY --chown=1000:1000 server.py /app/server.py
COPY --chown=1000:1000 static/ /app/static/
COPY docker-entrypoint.py /app/docker-entrypoint.py
USER 0:0
ENTRYPOINT ["python", "/app/docker-entrypoint.py"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=3)"
CMD ["python", "server.py", "--library", "/magazines", "--data", "/data"]

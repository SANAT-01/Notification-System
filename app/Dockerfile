FROM python:3.12-alpine
WORKDIR /app
# pika is vendored as a wheel and installed offline — no PyPI access needed at build.
COPY wheels /app/wheels
RUN pip install --no-index --find-links=/app/wheels pika
COPY worker.py publish.py /app/

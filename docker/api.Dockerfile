# Statistics + export service.
#
# Python is pinned to 3.12 (NOT the host's 3.14) to guarantee binary wheels for
# numpy/scipy/pandas/statsmodels.
#
# Chromium, Ghostscript and the fonts are pinned in this image on purpose: the
# export path renders through them, so pinning them is what makes exported
# vectors byte-reproducible across machines.
# Pinned to bookworm explicitly: bare `python:3.12-slim` now resolves to trixie,
# where Playwright's --with-deps asks for font packages Debian has dropped.
FROM docker.io/library/python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright

RUN apt-get update && apt-get install -y --no-install-recommends \
      ghostscript \
      fonts-liberation \
      fonts-dejavu-core \
      fontconfig \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY services/api/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Chromium for the PDF/raster export path.
RUN playwright install --with-deps chromium && fc-cache -f

EXPOSE 8000
CMD ["uvicorn", "figureforge.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

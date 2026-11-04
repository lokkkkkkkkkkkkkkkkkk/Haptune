FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt && python -m homr.main --init
COPY engine engine
COPY server server
# fetch the separation models into the image so the first band split does not wait for a download
RUN cd engine && python -c "from haptune.separate import MDX_MODELS, model_path; [model_path(MDX_MODELS[k]) for k in ('vocals', 'drums', 'bass')]"
WORKDIR /srv/server
EXPOSE 8000
ENV HAPTUNE_WORKERS=1
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]

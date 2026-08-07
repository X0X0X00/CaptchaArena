FROM python:3.11-slim

WORKDIR /app

# Dependencies first so a code change does not re-install Chromium.
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt \
 && playwright install --with-deps chromium

COPY . /app/

# The dataset is not in the image — mount it:
#   docker run -p 7860:7860 -v /path/to/data:/app/data captcha-arena
ENV CAPTCHA_DATA_DIRS=data/Test

EXPOSE 7860

CMD ["python", "app.py"]

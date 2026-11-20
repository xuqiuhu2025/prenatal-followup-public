# 中文语音识别服务（sherpa-onnx paraformer int8，CPU）
# 模型由宿主机 /opt/smart-cs/models/asr-model 挂载提供（model.int8.onnx + tokens.txt）
FROM python:3.10-slim

RUN pip install --no-cache-dir sherpa-onnx fastapi uvicorn python-multipart numpy

COPY asr_server.py /app/asr_server.py
WORKDIR /app

EXPOSE 8000
CMD ["uvicorn", "asr_server:app", "--host", "0.0.0.0", "--port", "8000"]

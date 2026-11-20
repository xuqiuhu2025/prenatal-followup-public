"""中文语音识别服务：POST /asr (multipart wav 16k/任意采样率 mono) → {"text": ...}"""
import io
import wave

import numpy as np
import sherpa_onnx
from fastapi import FastAPI, File, UploadFile

MODEL_DIR = "/models"

recognizer = sherpa_onnx.OfflineRecognizer.from_paraformer(
    paraformer=f"{MODEL_DIR}/model.int8.onnx",
    tokens=f"{MODEL_DIR}/tokens.txt",
    num_threads=2,
    debug=False,
)

app = FastAPI()


@app.post("/asr")
async def asr(file: UploadFile = File(...)):
    data = await file.read()
    if not data:
        return {"text": ""}
    with wave.open(io.BytesIO(data)) as w:
        sample_rate = w.getframerate()
        channels = w.getnchannels()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    if channels > 1:
        pcm = pcm[::channels]
    stream = recognizer.create_stream()
    stream.accept_waveform(sample_rate, pcm)
    recognizer.decode_stream(stream)
    return {"text": stream.result.text.strip()}


@app.get("/healthz")
def healthz():
    return {"ok": True}

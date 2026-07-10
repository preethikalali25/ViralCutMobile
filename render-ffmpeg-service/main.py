import os
import tempfile
import subprocess
import asyncio
import shutil
import httpx
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()


class SpeakerSegment(BaseModel):
    speaker: str
    start: int  # ms
    end: int    # ms
    text: str


class MixRequest(BaseModel):
    jobId: str
    inputUrl: str
    speakerSegments: list[SpeakerSegment]
    speakerVolumes: dict[str, float]
    supabaseUrl: str
    supabaseKey: str
    outputBucket: str
    outputPath: str


async def update_job(supabase_url: str, supabase_key: str, job_id: str, payload: dict):
    url = f"{supabase_url}/rest/v1/voice_mix_jobs?id=eq.{job_id}"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.patch(url, json=payload, headers={
                "apikey": supabase_key,
                "Authorization": f"Bearer {supabase_key}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            })
    except Exception:
        pass


def build_audio_filter(segments: list[SpeakerSegment], volumes: dict[str, float]) -> str:
    by_speaker: dict[str, list[SpeakerSegment]] = {}
    for seg in segments:
        by_speaker.setdefault(seg.speaker, []).append(seg)

    parts = []
    prev = "[0:a]"

    for i, (speaker, segs) in enumerate(by_speaker.items()):
        vol = volumes.get(speaker, 1.0)
        if abs(vol - 1.0) < 0.01:
            continue
        conditions = "+".join(
            f"between(t,{seg.start/1000:.3f},{seg.end/1000:.3f})"
            for seg in segs
        )
        label = f"[av{i}]"
        parts.append(f"{prev}volume={vol:.4f}:enable='{conditions}'{label}")
        prev = label

    return ",".join(parts)


async def process_mix(req: MixRequest):
    tmp_dir = tempfile.mkdtemp()
    input_path = os.path.join(tmp_dir, "input.mp4")
    output_path = os.path.join(tmp_dir, "output.mp4")

    try:
        print(f"[mix] {req.jobId} starting download from {req.inputUrl[:80]}")
        # Stream download to disk (avoids loading full video into memory)
        async with httpx.AsyncClient(timeout=120) as client:
            async with client.stream("GET", req.inputUrl) as r:
                if r.status_code != 200:
                    raise Exception(f"Failed to download video: HTTP {r.status_code}")
                with open(input_path, "wb") as f:
                    async for chunk in r.aiter_bytes(chunk_size=1024 * 1024):
                        f.write(chunk)
        print(f"[mix] {req.jobId} downloaded {os.path.getsize(input_path)} bytes")

        audio_filter = build_audio_filter(req.speakerSegments, req.speakerVolumes)
        print(f"[mix] {req.jobId} audio_filter={'(none)' if not audio_filter else audio_filter[:100]}")

        if audio_filter:
            cmd = [
                "ffmpeg", "-y", "-i", input_path,
                "-af", audio_filter,
                "-c:v", "copy",
                "-c:a", "aac", "-b:a", "192k",
                "-movflags", "+faststart",
                output_path,
            ]
        else:
            cmd = ["ffmpeg", "-y", "-i", input_path, "-c", "copy", output_path]

        result = await asyncio.get_event_loop().run_in_executor(
            None, lambda: subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        )
        print(f"[mix] {req.jobId} ffmpeg returncode={result.returncode}")
        if result.returncode != 0:
            raise Exception(f"FFmpeg error: {result.stderr[-500:]}")
        print(f"[mix] {req.jobId} output size={os.path.getsize(output_path)} bytes")

        # Stream upload from disk (avoids loading full output into memory)
        upload_url = f"{req.supabaseUrl}/storage/v1/object/{req.outputBucket}/{req.outputPath}"
        file_size = os.path.getsize(output_path)
        async with httpx.AsyncClient(timeout=180) as client:
            with open(output_path, "rb") as f:
                up = await client.post(
                    upload_url,
                    content=f,
                    headers={
                        "Authorization": f"Bearer {req.supabaseKey}",
                        "Content-Type": "video/mp4",
                        "Content-Length": str(file_size),
                    },
                )
            print(f"[mix] {req.jobId} upload status={up.status_code}")
            if up.status_code not in (200, 201):
                raise Exception(f"Storage upload failed: {up.text[:300]}")

        public_url = f"{req.supabaseUrl}/storage/v1/object/public/{req.outputBucket}/{req.outputPath}"
        await update_job(req.supabaseUrl, req.supabaseKey, req.jobId, {
            "status": "completed",
            "output_url": public_url,
        })

    except Exception as e:
        print(f"[mix] {req.jobId} FAILED: {e}")
        await update_job(req.supabaseUrl, req.supabaseKey, req.jobId, {
            "status": "failed",
            "error_message": str(e)[:500],
        })
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/mix")
async def mix(req: MixRequest):
    await process_mix(req)
    return {"jobId": req.jobId, "status": "processing"}

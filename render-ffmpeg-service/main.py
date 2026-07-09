import os
import uuid
import tempfile
import subprocess
import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Any

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


def update_job(supabase_url: str, supabase_key: str, job_id: str, payload: dict):
    url = f"{supabase_url}/rest/v1/voice_mix_jobs?id=eq.{job_id}"
    try:
        httpx.patch(url, json=payload, headers={
            "apikey": supabase_key,
            "Authorization": f"Bearer {supabase_key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        }, timeout=10)
    except Exception:
        pass


def build_audio_filter(segments: list[SpeakerSegment], volumes: dict[str, float]) -> str:
    # Group segments by speaker
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


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/mix")
async def mix(req: MixRequest):
    tmp_dir = tempfile.mkdtemp()
    input_path = os.path.join(tmp_dir, "input.mp4")
    output_path = os.path.join(tmp_dir, "output.mp4")

    try:
        # Download input video
        async with httpx.AsyncClient(timeout=120) as client:
            r = await client.get(req.inputUrl)
            if r.status_code != 200:
                raise HTTPException(status_code=400, detail=f"Failed to download video: HTTP {r.status_code}")
            with open(input_path, "wb") as f:
                f.write(r.content)

        # Build audio filter
        audio_filter = build_audio_filter(req.speakerSegments, req.speakerVolumes)

        # Run FFmpeg
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

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=f"FFmpeg error: {result.stderr[-500:]}")

        # Upload to Supabase Storage
        with open(output_path, "rb") as f:
            video_bytes = f.read()

        upload_url = f"{req.supabaseUrl}/storage/v1/object/{req.outputBucket}/{req.outputPath}"
        async with httpx.AsyncClient(timeout=120) as client:
            up = await client.post(
                upload_url,
                content=video_bytes,
                headers={
                    "Authorization": f"Bearer {req.supabaseKey}",
                    "Content-Type": "video/mp4",
                },
            )
            if up.status_code not in (200, 201):
                raise HTTPException(status_code=500, detail=f"Storage upload failed: {up.text[:300]}")

        public_url = f"{req.supabaseUrl}/storage/v1/object/public/{req.outputBucket}/{req.outputPath}"

        update_job(req.supabaseUrl, req.supabaseKey, req.jobId, {
            "status": "completed",
            "output_url": public_url,
        })

        return {"jobId": req.jobId, "outputUrl": public_url}

    except HTTPException as e:
        update_job(req.supabaseUrl, req.supabaseKey, req.jobId, {
            "status": "failed",
            "error_message": e.detail,
        })
        raise
    except Exception as e:
        update_job(req.supabaseUrl, req.supabaseKey, req.jobId, {
            "status": "failed",
            "error_message": str(e)[:500],
        })
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        import shutil
        shutil.rmtree(tmp_dir, ignore_errors=True)

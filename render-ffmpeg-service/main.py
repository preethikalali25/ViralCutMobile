"""
ShortReel FFmpeg Mixing Service
Deployed on Render.com (Python + FFmpeg buildpack)

Receives mix jobs from the voice-mixer Supabase edge function,
applies per-speaker volume adjustments using FFmpeg timestamp-based
volume automation, and uploads the result to Supabase Storage.
"""

import os
import uuid
import subprocess
import tempfile
import threading
import httpx

from fastapi import FastAPI, BackgroundTasks, HTTPException
from pydantic import BaseModel
from typing import Any

app = FastAPI()

# In-memory job status (Render free tier is single-instance; for multi-instance use Redis)
jobs: dict[str, dict] = {}


class MixRequest(BaseModel):
    jobId: str
    inputUrl: str
    speakerSegments: list[dict[str, Any]]  # [{speaker, start, end, text}]
    speakerVolumes: dict[str, float]        # {A: 0.8, B: 0.6}
    supabaseUrl: str
    supabaseKey: str
    outputBucket: str
    outputPath: str


def build_ffmpeg_filter(segments: list[dict], volumes: dict[str, float], duration_ms: float) -> str:
    """
    Build an FFmpeg complex filter that applies per-speaker volume levels
    using `volume` filter with `enable` time expressions.

    Strategy:
    - For each speaker, create a volume filter that activates only during
      their speaking segments and applies their volume level.
    - Merge all speaker filters with amix.
    """
    if not segments or not volumes:
        return ""

    # Group segments by speaker
    speaker_segments: dict[str, list[dict]] = {}
    for seg in segments:
        s = seg.get("speaker", "A")
        speaker_segments.setdefault(s, []).append(seg)

    speakers = list(speaker_segments.keys())
    if len(speakers) <= 1:
        # Single speaker — just apply volume directly
        vol = volumes.get(speakers[0] if speakers else "A", 1.0)
        return f"[0:a]volume={vol}[aout]"

    # Build time-range enable expressions per speaker
    filter_parts = []
    output_labels = []

    for i, speaker in enumerate(speakers):
        vol = volumes.get(speaker, 1.0)
        segs = speaker_segments[speaker]

        # Build enable expression: between(t, start_s, end_s) OR between(...)
        time_expr = "+".join(
            f"between(t,{seg['start'] / 1000:.3f},{seg['end'] / 1000:.3f})"
            for seg in segs
        )
        label = f"spk{i}"
        filter_parts.append(
            f"[0:a]volume=enable='{time_expr}':volume={vol}[{label}]"
        )
        output_labels.append(f"[{label}]")

    # Mix all speaker tracks
    n = len(output_labels)
    mix_inputs = "".join(output_labels)
    filter_chain = ";".join(filter_parts)
    filter_chain += f";{mix_inputs}amix=inputs={n}:duration=longest:dropout_transition=0[aout]"
    return filter_chain


def process_mix(job_id: str, req: MixRequest):
    jobs[job_id] = {"status": "processing"}

    with tempfile.TemporaryDirectory() as tmpdir:
        input_path = os.path.join(tmpdir, "input.mp4")
        output_path = os.path.join(tmpdir, "output.mp4")

        try:
            # Download input video
            with httpx.Client(timeout=300) as client:
                r = client.get(req.inputUrl)
                r.raise_for_status()
                with open(input_path, "wb") as f:
                    f.write(r.content)

            # Get video duration via ffprobe
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=noprint_wrappers=1:nokey=1", input_path],
                capture_output=True, text=True
            )
            duration_ms = float(probe.stdout.strip() or "0") * 1000

            # Build FFmpeg filter
            filter_complex = build_ffmpeg_filter(req.speakerSegments, req.speakerVolumes, duration_ms)

            if filter_complex:
                cmd = [
                    "ffmpeg", "-y", "-i", input_path,
                    "-filter_complex", filter_complex,
                    "-map", "0:v", "-map", "[aout]",
                    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                    output_path
                ]
            else:
                # No filter needed — copy as-is
                cmd = ["ffmpeg", "-y", "-i", input_path, "-c", "copy", output_path]

            result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            if result.returncode != 0:
                raise RuntimeError(f"FFmpeg failed: {result.stderr[-500:]}")

            # Upload to Supabase Storage
            with open(output_path, "rb") as f:
                video_bytes = f.read()

            upload_url = f"{req.supabaseUrl}/storage/v1/object/{req.outputBucket}/{req.outputPath}"
            with httpx.Client(timeout=300) as client:
                up = client.post(
                    upload_url,
                    content=video_bytes,
                    headers={
                        "Authorization": f"Bearer {req.supabaseKey}",
                        "Content-Type": "video/mp4",
                    }
                )
                up.raise_for_status()

            public_url = f"{req.supabaseUrl}/storage/v1/object/public/{req.outputBucket}/{req.outputPath}"

            # Update voice_mix_jobs row in Supabase
            with httpx.Client(timeout=30) as client:
                client.patch(
                    f"{req.supabaseUrl}/rest/v1/voice_mix_jobs?id=eq.{job_id}",
                    json={"status": "completed", "output_url": public_url},
                    headers={
                        "Authorization": f"Bearer {req.supabaseKey}",
                        "apikey": req.supabaseKey,
                        "Content-Type": "application/json",
                        "Prefer": "return=minimal",
                    }
                )

            jobs[job_id] = {"status": "completed", "outputUrl": public_url}

        except Exception as e:
            error_msg = str(e)[:500]
            jobs[job_id] = {"status": "failed", "error": error_msg}
            try:
                with httpx.Client(timeout=10) as client:
                    client.patch(
                        f"{req.supabaseUrl}/rest/v1/voice_mix_jobs?id=eq.{job_id}",
                        json={"status": "failed", "error_message": error_msg},
                        headers={
                            "Authorization": f"Bearer {req.supabaseKey}",
                            "apikey": req.supabaseKey,
                            "Content-Type": "application/json",
                            "Prefer": "return=minimal",
                        }
                    )
            except Exception:
                pass


@app.post("/mix")
async def submit_mix(req: MixRequest, background_tasks: BackgroundTasks):
    job_id = req.jobId
    jobs[job_id] = {"status": "pending"}
    background_tasks.add_task(process_mix, job_id, req)
    return {"jobId": job_id, "status": "pending"}


@app.get("/status/{job_id}")
async def get_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.get("/health")
async def health():
    return {"status": "ok"}

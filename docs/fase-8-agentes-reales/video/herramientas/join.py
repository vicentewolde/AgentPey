import subprocess, os, json
FF = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"; FP = "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe"
M = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(M, "..", "entrega", "AgentPey-find-your-way-video-final.mp4")
T = 0.3
files = [f"{M}/escena{n}_f.mp4" for n in (0, 1, 2, 3, 4, 5)]
durs = [float(subprocess.check_output([FP, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).decode()) for f in files]
print("duraciones", [round(d, 2) for d in durs])
inputs = sum([["-i", f] for f in files], [])
parts = []
for i in range(6):
    parts.append(f"[{i}:v]settb=AVTB,fps=30,format=yuv420p,setsar=1[v{i}];[{i}:a]aresample=48000,aformat=channel_layouts=stereo[a{i}]")
v, a, acc = "v0", "a0", durs[0]
for k in range(1, 6):
    off = acc - T
    parts.append(f"[{v}][v{k}]xfade=transition=fade:duration={T}:offset={off:.3f}[vx{k}]")
    parts.append(f"[{a}][a{k}]acrossfade=d={T}:c1=tri:c2=tri[ax{k}]")
    v, a = f"vx{k}", f"ax{k}"
    acc = acc + durs[k] - T
total = acc
print("duración total", round(total, 2))
parts.append(f"[{v}]fade=t=in:st=0:d=0.3,fade=t=out:st={total - 0.6:.3f}:d=0.6[vout]")
parts.append(f"[{a}]loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=out:st={total - 0.6:.3f}:d=0.6[aout]")
subprocess.run([FF, "-v", "error", "-y", *inputs, "-filter_complex", ";".join(parts), "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-movflags", "+faststart", OUT], check=True)
print("ok", OUT)

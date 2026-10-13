import os, re, json, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build import FF, chunks, wrap2, make_ass
import texts_v4 as T
HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.expanduser(os.environ.get("AGENTPEY_VIDEO_RAW", "~/Desktop/AgentPey video"))  # folder with the raw screen recordings (not versioned)
LEAD, TAIL, GAP, PRE = 0.4, 0.5, 0.40, 0.2
PG = "crop=2766:1556:57:244"          # the whole page, same framing as every scene
CL = "crop=2766:1556:114:244"         # claude.ai: whole page shifted so "Share" is whole (sidebar is blurred)

EXTRAS = {"escena0": [0, 0, 0.5], "escena1": [0, 0, 0.5, 1.0], "escena2": [2.0, 0, 0, 0.3, 0.7, 0.0],
          "escena3": [0, 0.5, 1.2], "escena4": [0, 0.5, 2.5, 1.0, 1.5, 0.6, 1.7, 1.0, 1.2], "escena5": [1.2, 0, 0, 0]}

def entries(name):
    al = json.load(open(f"{HERE}/audio2/{name}-v4.align.json")); ch = al["characters"]; full = "".join(ch)
    st, en = al["character_start_times_seconds"], al["character_end_times_seconds"]; pos = 0; out = []
    for e, s in T.SCENES[name]:
        t = re.sub(r"\bSEP\b", "S-E-P", e); i = full.find(t, pos); assert i >= 0, (name, t[:30]); pos = i + len(t)
        out.append(dict(en=e, es=s, a=st[i], b=en[i + len(t) - 1]))
    return out

def timeline(name):
    es = entries(name); cur = LEAD
    for k, x in enumerate(es):
        x["S"] = cur; x["d"] = x["b"] - x["a"]; cur += x["d"] + GAP + EXTRAS[name][k]
    total = cur - GAP + TAIL
    S = [x["S"] for x in es]
    bounds = [0.0] + [s - PRE for s in S[1:]] + [total]
    return es, total, bounds

def P(src, ss, to, dur=None, crop=PG, blur=None, zoom=None, kind="auto"):
    return dict(src=src, ss=ss, to=to, dur=dur, crop=crop, blur=blur, zoom=zoom, kind=kind)

def render(name, pieces, es, total, out_name=None):
    # fill the one open duration with the remainder
    known = sum(p["dur"] for p in pieces if p["dur"] is not None); opens = [p for p in pieces if p["dur"] is None]
    assert len(opens) <= 1, "only one open piece"
    if opens: opens[0]["dur"] = total - known; assert opens[0]["dur"] > 0.05, (name, opens[0]["dur"])
    else: assert abs(known - total) < 0.03, (name, known, total)
    inputs, chains = [], []
    for i, p in enumerate(pieces):
        span = p["to"] - p["ss"]; dur = p["dur"]; inputs += ["-ss", f"{p['ss']:.3f}", "-t", f"{span + 0.2:.3f}", "-i", p["src"]]
        if p["kind"] == "fit" or dur < span - 1e-6:
            sp = f"setpts=(PTS-STARTPTS)*{dur / span:.6f},fps=30"; speed = span / dur
        else:
            extra = dur - span; speed = 1.0
            sp = "setpts=PTS-STARTPTS,fps=30" + (f",tpad=stop_mode=clone:stop_duration={extra:.3f}" if extra > 0.02 else "")
        p["speed"] = speed
        base = f"[{i}:v]trim=end={span:.3f},{sp},{p['crop']}"
        if p["blur"]:
            base += f",split[a{i}][b{i}];[b{i}]crop={p['blur']}:1556:0:0,boxblur=36:6[bl{i}];[a{i}][bl{i}]overlay=0:0"
        if p["zoom"]:
            zmax, cx, cy, rin, rout = p["zoom"]; tt = "(on/30)"
            u1 = f"clip({tt}/{rin},0,1)"; u2 = f"clip(({dur:.3f}-{tt})/{max(rout, 0.001)},0,1)"
            Z = f"(1+({zmax}-1)*(pow({u1},2)*(3-2*{u1}))*(pow({u2},2)*(3-2*{u2})))"
            base += (f",zoompan=z='{Z}':x='clip({cx}*iw-iw/{Z}/2,0,iw-iw/{Z})':y='clip({cy}*ih-ih/{Z}/2,0,ih-ih/{Z})'"
                     f":d=1:s=1920x1080:fps=30,setsar=1")
        else:
            base += ",scale=1920:1080:flags=lanczos,setsar=1"
        chains.append(base + f"[s{i}]")
    n = len(pieces)
    # subtitles
    cues = []
    for x in es:
        cs = chunks(x["es"]); tot = sum(len(c) for c in cs); t0 = x["S"]; span = x["d"] + 0.25
        for c in cs:
            d = span * len(c) / tot; cues.append((t0, t0 + d, wrap2(c))); t0 += d
    ass = f"{HERE}/{name}.ass"; make_ass(ass, cues)
    # voice: each phrase cut from the TTS file and placed at its start
    inputs += ["-i", f"{HERE}/audio2/{name}-v4.wav"]; k = len(es)
    a_chain = [f"[{n}:a]asplit={k}" + "".join(f"[x{j}]" for j in range(k))]
    for j, x in enumerate(es):
        a_chain.append(f"[x{j}]atrim=start={max(x['a'] - 0.03, 0):.3f}:end={x['b'] + 0.10:.3f},asetpts=PTS-STARTPTS,adelay={int(x['S'] * 1000)}:all=1[a{j}]")
    a_chain.append(f"anullsrc=r=44100:cl=mono,atrim=0:{total:.3f},asetpts=PTS-STARTPTS[sil]")
    amix = "[sil]" + "".join(f"[a{j}]" for j in range(k)) + f"amix=inputs={k + 1}:normalize=0:duration=first[a]"
    fc = ";".join(chains) + ";" + "".join(f"[s{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0[c];[c]subtitles={ass}[v];" + ";".join(a_chain) + ";" + amix
    out = f"{HERE}/{out_name or name}_f.mp4"
    subprocess.run([FF, "-nostdin", "-v", "error", "-y", *inputs, "-filter_complex", fc, "-map", "[v]", "-map", "[a]", "-t", f"{total:.3f}",
                    "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", out], check=True)
    print(f"ok {name}: {total:.2f}s  pieces:", [f"{p['dur']:.1f}s x{p['speed']:.1f}" for p in pieces])
    return out

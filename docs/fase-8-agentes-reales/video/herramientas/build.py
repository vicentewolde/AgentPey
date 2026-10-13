import json, re, subprocess, sys, os
FF = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"
HERE = os.path.dirname(os.path.abspath(__file__))
G = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "GUION-VIDEO.md"), encoding="utf-8").read()

def en_text(scene, k=0):
    body = re.split(r"\n### (?=\d · )", G)
    sec = [b for b in body if b.startswith(f"{scene} · ")][0].split("\n## ")[0]
    blocks = re.findall(r"\*\*Subt[^\n]*\*\*:?\s*\n\n((?:>[^\n]*\n?)+)", sec)
    return " ".join(l[1:].strip() for l in blocks[k].splitlines() if l[1:].strip())

def es_sentences(align):
    ch, st, en = align["characters"], align["character_start_times_seconds"], align["character_end_times_seconds"]
    out, s = [], 0
    for i, c in enumerate(ch):
        if c in ".?!" and (i == len(ch) - 1 or ch[i + 1] in " \n"):
            out.append((st[s], en[i])); s = i + 1
    return out

def split_sentences(t):
    return [x.strip() for x in re.split(r"(?<=[.?!])\s+(?=[A-ZÁÉÍÓÚÑÜ¿¡\"'])", t) if x.strip()]

def chunks(sentence, max_chars=42):
    """Split a long sentence into cues of at most two lines, cutting after : ; , and packing clauses greedily."""
    limit = max_chars * 2
    if len(sentence) <= limit:
        return [sentence]
    pieces = [p for p in re.split(r"(?<=[:;,])\s+", sentence) if p]
    cues, cur = [], ""
    for p in pieces:
        if len(p) > limit:  # a single clause too long: balanced word split
            if cur: cues.append(cur); cur = ""
            n = -(-len(p) // limit); target = len(p) / n; c2 = ""
            for w in p.split():
                if len(c2) + len(w) + 1 > target and c2 and len(cues) < 99:
                    cues.append(c2); c2 = w
                else:
                    c2 = (c2 + " " + w).strip()
            cur = c2
        elif cur and len(cur) + 1 + len(p) > limit:
            cues.append(cur); cur = p
        else:
            cur = (cur + " " + p).strip()
    if cur: cues.append(cur)
    # avoid a tiny orphan at the end: merge into the previous cue if it fits
    if len(cues) > 1 and len(cues[-1]) < 18 and len(cues[-2]) + 1 + len(cues[-1]) <= limit + 10:
        cues[-2] += " " + cues.pop()
    return cues


def wrap2(t, max_chars=42):
    if len(t) <= max_chars: return t
    mid = len(t) // 2
    sp = [i for i, c in enumerate(t) if c == " "]
    i = min(sp, key=lambda i: abs(i - mid))
    return t[:i] + "\\N" + t[i + 1:]

def ts(x):
    h, m, s = int(x // 3600), int(x % 3600 // 60), x % 60
    return f"{h:01d}:{m:02d}:{s:05.2f}"

def make_ass(path, cues):
    hdr = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Helvetica Neue,42,&H00FFFFFF,&H00FFFFFF,&H55000000,&H55000000,0,0,0,0,100,100,0,0,3,9,0,2,120,120,50,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    with open(path, "w", encoding="utf-8") as f:
        f.write(hdr)
        for a, b, t in cues:
            f.write(f"Dialogue: 0,{ts(a)},{ts(b)},Default,,0,0,0,,{t}\n")

def cues_for(parts, lead):
    """parts: list of (align_json, en_text, offset_seconds_in_scene)"""
    cues = []
    for align, en, off in parts:
        es = es_sentences(align); enS = split_sentences(en)
        assert len(es) == len(enS), f"sentence mismatch ES {len(es)} vs EN {len(enS)}: {enS}"
        for (a, b), s in zip(es, enS):
            cs = chunks(s)
            tot = sum(len(c) for c in cs); t = a
            for c in cs:
                d = (b - a) * len(c) / tot
                cues.append((off + t, off + t + d, wrap2(c))); t += d
    return cues


def render_scene(name, segments, audio_base, scene_no, lead=0.4, tail=0.5, k=0, crop="crop=2880:1556:0:244", parts_audio=None):
    """segments: list of (file, start, duration); concatenated, cropped to the page, 16:9, 30 fps.
    The voice starts `lead` seconds in; Spanish subtitles follow the English voice sentence by sentence."""
    import json as _j
    al = _j.load(open(f"{HERE}/{audio_base}.align.json"))
    voice = al["character_end_times_seconds"][-1]
    total = lead + voice + tail
    cues = cues_for([(al, en_text(scene_no, k), lead)], lead)
    ass = f"{HERE}/{name}.ass"; make_ass(ass, cues)
    for c in cues: print(f"{c[0]:6.2f} {c[1]:6.2f}  {c[2]}")
    inputs, chains = [], []
    for i, (f, st, du) in enumerate(segments):
        inputs += ["-i", f]
        chains.append(f"[{i}:v]trim=start={st}:duration={du},setpts=PTS-STARTPTS,{crop},crop=2766:1556:57:0,fps=30[s{i}]")
    n = len(segments)
    cat = "".join(f"[s{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0[c]"
    fc = ";".join(chains) + ";" + cat + (
        f";[c]crop=2766:1556:0:0,scale=1920:1080:flags=lanczos,tpad=stop_mode=clone:stop_duration={tail + 1:.2f},"
        f"subtitles={ass}[v];[{n}:a]adelay={int(lead*1000)}:all=1,apad[a]")
    out = f"{HERE}/{name}.mp4"
    subprocess.run([FF, "-v", "error", "-y", *inputs, "-i", f"{HERE}/{audio_base}.mp3", "-filter_complex", fc,
        "-map", "[v]", "-map", "[a]", "-t", f"{total:.2f}", "-c:v", "libx264", "-crf", "18", "-preset", "medium",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", out], check=True)
    print("ok", name, f"{total:.2f}s")
    return out


def sent_starts(al):
    ch, st = al["characters"], al["character_start_times_seconds"]
    out = [st[0]]
    for i, c in enumerate(ch):
        if c in ".?!" and i < len(ch) - 1 and ch[i + 1] in " \n":
            k = i + 1
            while k < len(ch) and ch[k] in " \n": k += 1
            if k < len(ch): out.append(st[k])
    return out


def render_pieces(name, pieces, voices, subs, tail=0.5):
    """pieces: dicts {src, ss, to, dur, crop, freeze}. Final length = last voice end + tail.
    voices: [(audio_base, offset_s)], subs: [(audio_base, es_text, offset_s)]."""
    import json as _j
    als = [(_j.load(open(f"{HERE}/{b}.align.json")), off) for b, off in voices]
    total = max(al["character_end_times_seconds"][-1] + off for al, off in als) + tail
    # the last piece absorbs rounding so that the picture matches the audio exactly
    used = sum(p["dur"] for p in pieces[:-1]); pieces[-1]["dur"] = total - used
    cues = []
    for (b, text, off) in subs:
        al = _j.load(open(f"{HERE}/{b}.align.json")); cues += cues_for([(al, text, off)], off)
    cues.sort()
    ass = f"{HERE}/{name}.ass"; make_ass(ass, cues)
    for c in cues: print(f"{c[0]:6.2f} {c[1]:6.2f}  {c[2]}")
    inputs, chains = [], []
    for i, p in enumerate(pieces):
        inputs += ["-i", p["src"]]
        span = p["to"] - p["ss"] if p.get("to") else p["dur"]
        if p.get("freeze"):
            span = p["to"] - p["ss"]
            sp = f"setpts=PTS-STARTPTS,fps=30,tpad=stop_mode=clone:stop_duration={p['dur'] - span:.3f}"
        else:
            sp = f"setpts=(PTS-STARTPTS)*{p['dur'] / span:.6f},fps=30"
        if p.get("blur"):  # whole page, left sidebar blurred (it lists personal chats)
            chains.append(f"[{i}:v]trim=start={p['ss']}:end={p['ss'] + span:.3f},{sp},{p['crop']},split[a{i}][b{i}];"
                          f"[b{i}]crop={p['blur']}:1556:0:0,boxblur=36:6[bl{i}];[a{i}][bl{i}]overlay=0:0,scale=1920:1080:flags=lanczos,setsar=1[s{i}]")
        else:
            chains.append(f"[{i}:v]trim=start={p['ss']}:end={p['ss'] + span:.3f},{sp},{p['crop']},scale=1920:1080:flags=lanczos,setsar=1[s{i}]")
        p["_span"] = span
    n = len(pieces)
    cat = "".join(f"[s{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0[c]"
    a_in = []; a_chain = []
    for j, (b, off) in enumerate(voices):
        inputs += ["-i", f"{HERE}/{b}.mp3"]
        a_chain.append(f"[{n + j}:a]adelay={int(off * 1000)}:all=1[a{j}]"); a_in.append(f"[a{j}]")
    amix = "".join(a_in) + f"amix=inputs={len(voices)}:normalize=0:duration=longest,apad[a]" if len(voices) > 1 else f"[a0]apad[a]"
    fc = ";".join(chains) + ";" + cat + f";[c]subtitles={ass}[v];" + ";".join(a_chain) + ";" + amix
    out = f"{HERE}/{name}.mp4"
    subprocess.run([FF, "-v", "error", "-y", *inputs, "-filter_complex", fc, "-map", "[v]", "-map", "[a]",
        "-t", f"{total:.3f}", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", out], check=True)
    print("ok", name, f"{total:.2f}s", [round(p['dur'], 2) for p in pieces])
    return out


def render_timeline(name, pieces, phrases, audio_base, tail=0.5, gap=0.12):
    """Picture = pieces (fixed durations, optionally sped up); voice = phrases cut out of one TTS file and
    placed at the moment their screen appears. phrases: dicts {en, es, piece, delay}."""
    import json as _j
    al = _j.load(open(f"{HERE}/{audio_base}.align.json"))
    ch, st, en = al["characters"], al["character_start_times_seconds"], al["character_end_times_seconds"]
    full = "".join(ch)
    starts, t = {}, 0.0
    for p in pieces: starts[p["name"]] = t; t += p["dur"]
    total = t
    pos, prev_end, placed = 0, 0.0, []
    for ph in phrases:
        i = full.find(ph["en"], pos); assert i >= 0, ph["en"]
        a, b = st[i], en[i + len(ph["en"]) - 1]; pos = i + len(ph["en"])
        s = max(starts[ph["piece"]] + ph.get("delay", 0.0), prev_end + gap)
        e = s + (b - a); prev_end = e
        placed.append(dict(ph, src_a=a, src_b=b, s=s, e=e))
    assert placed[-1]["e"] <= total + 0.05, f"voice ends {placed[-1]['e']:.2f} after picture {total:.2f}"
    cues = []
    for ph in placed:
        cs = chunks(ph["es"]); tot = sum(len(c) for c in cs); x = ph["s"]; dur = (ph["e"] - ph["s"]) + 0.25
        for c in cs:
            d = dur * len(c) / tot; cues.append((x, x + d, wrap2(c))); x += d
    ass = f"{HERE}/{name}.ass"; make_ass(ass, cues)
    for ph in placed: print(f"{ph['s']:6.2f}-{ph['e']:6.2f}  [{ph['piece']}]  {ph['en']}")
    inputs, chains = [], []
    for i, p in enumerate(pieces):
        inputs += ["-i", p["src"]]
        span = p["to"] - p["ss"]
        sp = f"setpts=(PTS-STARTPTS)*{p['dur'] / span:.6f},fps=30"
        base = f"[{i}:v]trim=start={p['ss']}:end={p['to']},{sp},{p['crop']}"
        if p.get("blur"):
            chains.append(base + f",split[a{i}][b{i}];[b{i}]crop={p['blur']}:1556:0:0,boxblur=36:6[bl{i}];[a{i}][bl{i}]overlay=0:0,scale=1920:1080:flags=lanczos,setsar=1[s{i}]")
        else:
            chains.append(base + f",scale=1920:1080:flags=lanczos,setsar=1[s{i}]")
    n = len(pieces)
    inputs += ["-i", f"{HERE}/{audio_base}.mp3"]
    k = len(placed)
    a_chain = [f"[{n}:a]asplit={k}" + "".join(f"[x{j}]" for j in range(k))]
    for j, ph in enumerate(placed):
        a_chain.append(f"[x{j}]atrim=start={max(ph['src_a'] - 0.03, 0):.3f}:end={ph['src_b'] + 0.08:.3f},asetpts=PTS-STARTPTS,adelay={int(ph['s'] * 1000)}:all=1[a{j}]")
    amix = "".join(f"[a{j}]" for j in range(k)) + f"amix=inputs={k}:normalize=0:duration=longest,apad[a]"
    fc = ";".join(chains) + ";" + "".join(f"[s{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0[c];[c]subtitles={ass}[v];" + ";".join(a_chain) + ";" + amix
    out = f"{HERE}/{name}.mp4"
    subprocess.run([FF, "-v", "error", "-y", *inputs, "-filter_complex", fc, "-map", "[v]", "-map", "[a]", "-t", f"{total:.3f}",
        "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", out], check=True)
    print("ok", name, f"{total:.2f}s")
    return out

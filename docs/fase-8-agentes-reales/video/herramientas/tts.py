import base64, json, os, re, sys, urllib.request, urllib.error
VOICE = os.environ["ELEVENLABS_VOICE_ID"]  # the id of the voice clone; not versioned
env = dict(l.strip().split("=", 1) for l in open(os.path.expanduser("~/.config/elevenlabs.env")) if "=" in l)
KEY = env["ELEVENLABS_API_KEY"]

def tts(text, model, out, seed=7, speed=None):
    payload = {"text": text, "model_id": model, "seed": seed}
    if speed is not None: payload["voice_settings"] = {"speed": speed}
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE}/with-timestamps?output_format=mp3_44100_128",
        data=body, headers={"xi-api-key": KEY, "Content-Type": "application/json"})
    try:
        r = json.load(urllib.request.urlopen(req, timeout=120))
    except urllib.error.HTTPError as e:
        print(model, "ERROR", e.code, e.read().decode()[:300]); return None
    open(out + ".mp3", "wb").write(base64.b64decode(r["audio_base64"]))
    json.dump(r["alignment"], open(out + ".align.json", "w"))
    a = r["alignment"]; ch, st, en = a["characters"], a["character_start_times_seconds"], a["character_end_times_seconds"]
    print(f"\n== {model}: {en[-1]:.2f} s ==")
    # sentence timings
    start = 0
    for i, c in enumerate(ch):
        if c in ".?!" and (i == len(ch) - 1 or ch[i + 1] in " \n"):
            print(f"{st[start]:6.2f} - {en[i]:6.2f}  {''.join(ch[start:i+1]).strip()}")
            start = i + 1
    return en[-1]

if __name__ == "__main__":
    text = sys.argv[1]; name = sys.argv[2]
    for model in sys.argv[3:]:
        tts(text, model, f"{os.path.dirname(__file__)}/audio/{name}-{model}")

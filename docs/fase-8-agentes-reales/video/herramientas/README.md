# Herramientas del video de la hackatón (T142)

Scripts que armaron el video del 13-oct. **No son parte del producto**: viven aquí para poder rehacer el video (o uno
nuevo) con el mismo método. Nada de esto se despliega ni entra en `pnpm check`.

## Qué hace cada archivo

| Archivo | Para qué |
|---|---|
| `texts_v4.py` | La voz en inglés y su subtítulo en español, frase por frase, por escena. Es el texto final del video |
| `tts.py` | Llama a la API de ElevenLabs (`/with-timestamps`) y guarda el audio y el tiempo de cada letra |
| `final.py` | El montaje: pone cada frase de la voz en su pantalla, las pausas, los acercamientos y los subtítulos |
| `scenes_final.py` | Los tramos de cada escena: qué segundos de qué grabación, a qué velocidad, con qué acercamiento |
| `join.py` | Une las seis escenas con un fundido de 0,3 s y normaliza el volumen (−16 LUFS) |
| `build.py` | Funciones de apoyo (subtítulos, cortes de líneas) |
| `audio2/*.align.json` | El tiempo de cada letra de la voz final, por escena. Los `.mp3` y `.wav` de la voz **no se versionan** (es una voz clonada) |

## Lo que hace falta

- `ffmpeg-full` (Homebrew): trae `libass`, `libfreetype` y `drawtext`. El `ffmpeg` normal de Homebrew no los trae.
  `brew install ffmpeg-full`. Los scripts lo llaman por `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg`.
- Una clave de ElevenLabs en `~/.config/elevenlabs.env` (línea `ELEVENLABS_API_KEY=…`), con permiso solo de texto a voz,
  y el id de la voz en la variable `ELEVENLABS_VOICE_ID`.
- Las grabaciones de pantalla originales (`.mov`, 2880×1800) en una carpeta, que se indica con `AGENTPEY_VIDEO_RAW`.
  No se versionan (pesan unos 270 MB).

## Cómo se rehace

Desde esta carpeta. La voz, a velocidad 0,85, una llamada por escena (ver `texts_v4.py` para el texto):

```bash
ELEVENLABS_VOICE_ID=<id de la voz> python3 -c "import re, texts_v4 as T; from tts import tts; [tts(re.sub(r'\bSEP\b','S-E-P',' '.join(e for e,_ in p)), 'eleven_multilingual_v2', f'audio2/{n}-v4', speed=0.85) for n,p in T.SCENES.items()]"
```

Cada escena (necesita `audio2/escenaN-v4.wav`; se saca del `.mp3` con `ffmpeg -i X.mp3 -ar 44100 -ac 1 X.wav`):

```bash
AGENTPEY_VIDEO_RAW="$HOME/Desktop/AgentPey video" python3 scenes_final.py escena0 escena1 escena2 escena3 escena4 escena5
```

La unión final, que escribe `../entrega/AgentPey-find-your-way-video-final.mp4`:

```bash
python3 join.py
```

## Cosas que aprendí al hacerlo (para no repetirlas)

- Cada trozo debe abrirse con `-ss` en la entrada, no con el filtro `trim` desde el segundo 0: con `trim`, la escena 4
  decodificaba hasta 222 s de video por trozo y tardaba más de 10 minutos.
- La pista de audio se arma sobre una pista de silencio de largo exacto (`anullsrc` + `amix duration=first`); con `apad`
  infinito el audio no terminaba nunca y desfasaba el video.
- Un acercamiento mayor que 1,25× sobre `/live` corta el borde de la página: su contenido ocupa el 77 % del ancho.
- El filtro `fps` toma el último cuadro de cada intervalo: para ubicar un evento hay que buscar con `-ss` en la entrada,
  no leer la hora de una hoja de cuadros hecha con `fps`.

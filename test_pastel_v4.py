"""
파스텔 게임 에셋 v4 — Animagine XL 3.1 + 퀄리티 확보
- Animagine XL 3.1 (애니메/일러스트 특화 SDXL)
- watercolor + pastel LoRA 스택
- Scenario.com 프롬프트 기반
- DPM++ 2M Karras, 40 steps, cfg 9
"""
import torch
import gc
import time
from pathlib import Path

OUTPUT_DIR = Path.home() / "scenario-engine" / "pastel_v4"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

print("=" * 60)
print("v4 — Animagine XL 3.1 + 게임 에셋 퀄리티 확보")
print("=" * 60)

device = "mps"
dtype = torch.float16

# Step 1: Animagine XL 3.1 다운로드 + 로드
print("\n[1/5] Animagine XL 3.1 로드 (첫 실행 시 다운로드)...")
from diffusers import StableDiffusionXLPipeline, DPMSolverMultistepScheduler

pipe = StableDiffusionXLPipeline.from_pretrained(
    "cagliostrolab/animagine-xl-3.1",
    torch_dtype=dtype,
    use_safetensors=True,
)

pipe.scheduler = DPMSolverMultistepScheduler.from_config(
    pipe.scheduler.config,
    algorithm_type="dpmsolver++",
    use_karras_sigmas=True,
)
pipe.to(device)
print("  Animagine XL 3.1 + DPM++ OK")

gc.collect()
torch.mps.empty_cache()

# Step 2: LoRA 스택
print("\n[2/5] LoRA 스택...")
lora_ok = []

try:
    pipe.load_lora_weights(
        "ostris/watercolor_style_lora_sdxl",
        adapter_name="watercolor",
    )
    lora_ok.append("watercolor")
    print("  watercolor OK")
except Exception as e:
    print(f"  watercolor 실패: {e}")

try:
    pipe.load_lora_weights(
        "Linaqruf/pastel-anime-xl-lora",
        weight_name="pastel-anime-xl-latest.safetensors",
        adapter_name="pastel",
    )
    lora_ok.append("pastel")
    print("  pastel OK")
except Exception as e:
    print(f"  pastel 실패: {e}")

if len(lora_ok) == 2:
    try:
        pipe.set_adapters(["watercolor", "pastel"], adapter_weights=[0.4, 0.55])
        print("  스택: watercolor=0.4, pastel=0.55")
    except Exception as e:
        print(f"  set_adapters 실패: {e}")
elif len(lora_ok) == 1:
    try:
        pipe.set_adapters(lora_ok, adapter_weights=[0.6])
        print(f"  단독: {lora_ok[0]}=0.6")
    except Exception:
        pass

gc.collect()
torch.mps.empty_cache()

# Animagine XL 3.1 전용 프롬프트 포맷
# Animagine은 태그 스타일이 잘 먹음 (Danbooru 태그 기반 학습)
# 퀄리티 태그 + 스타일 태그 + 내용 태그 순서

QUALITY = "masterpiece, best quality, very aesthetic, absurdres"
STYLE = "watercolor (medium), pastel colors, soft lighting, no outline, white background"

NEG = (
    "nsfw, lowres, bad anatomy, bad hands, text, error, missing fingers, "
    "extra digit, fewer digits, cropped, worst quality, low quality, "
    "normal quality, jpeg artifacts, signature, watermark, username, blurry, "
    "realistic, photorealistic, 3d, photograph"
)

NEG_NOBG = NEG + ", background, scenery, landscape, detailed background"

print("\n[3/5] 해상도 테스트 (832x832)...")
# Animagine XL은 832x832가 sweet spot (SDXL 학습 해상도 중 하나)
test_sizes = [832, 768]
SIZE = 768  # fallback

for s in test_sizes:
    try:
        test = pipe(
            prompt=f"{QUALITY}, {STYLE}, 1girl, chibi, simple background",
            negative_prompt=NEG,
            num_inference_steps=8,
            guidance_scale=7.0,
            height=s, width=s,
            generator=torch.Generator(device="cpu").manual_seed(42),
        ).images[0]
        tp = OUTPUT_DIR / f"_test_{s}.png"
        test.save(tp)
        if tp.stat().st_size > 5000:
            SIZE = s
            print(f"  {s}x{s} OK!")
            tp.unlink()
            break
        tp.unlink()
    except Exception as e:
        print(f"  {s} 실패: {e}")
    gc.collect()
    torch.mps.empty_cache()

print(f"  최종: {SIZE}x{SIZE}")

# Step 4: 게임 에셋 생성
print(f"\n[4/5] 게임 에셋 생성 ({SIZE}x{SIZE}, 40 steps)...")

TESTS = [
    # === 유령 강아지 — 개별 포즈 ===
    ("ghost_dog_stand",
     f"{QUALITY}, {STYLE}, "
     "no humans, 1other, ghost dog, small fluffy white dog, "
     "translucent body, glowing, ethereal, lavender tint, pink tint, "
     "sparkles, star particles, standing, looking at viewer, "
     "full body, simple background, white background, game sprite",
     NEG_NOBG),

    ("ghost_dog_walk",
     f"{QUALITY}, {STYLE}, "
     "no humans, 1other, ghost dog, small fluffy white dog, "
     "translucent body, glowing, ethereal, lavender aura, "
     "walking, from side, one paw forward, sparkle trail, "
     "full body, simple background, white background, game sprite",
     NEG_NOBG),

    ("ghost_dog_jump",
     f"{QUALITY}, {STYLE}, "
     "no humans, 1other, ghost dog, small fluffy white dog, "
     "translucent body, glowing, ethereal, sparkles, "
     "jumping, all paws off ground, happy, excited, "
     "full body, simple background, white background, game sprite",
     NEG_NOBG),

    ("ghost_dog_sleep",
     f"{QUALITY}, {STYLE}, "
     "no humans, 1other, ghost dog, small fluffy white dog, "
     "translucent body, soft glow, ethereal, peaceful, "
     "sleeping, lying down, curled up, relaxed, "
     "full body, simple background, white background, game sprite",
     NEG_NOBG),

    # === 유령 강아지 캐릭터 시트 ===
    ("ghost_dog_sheet",
     f"{QUALITY}, {STYLE}, "
     "no humans, character sheet, reference sheet, "
     "multiple views, ghost dog, small fluffy white dog, "
     "translucent body, glowing lavender pink, sparkles, "
     "(standing:1.2), (sitting:1.2), (walking:1.2), "
     "consistent design, white background",
     NEG + ", merged, overlapping"),

    # === 소녀 치비 캐릭터 시트 (앞/뒤) ===
    ("girl_chibi_sheet",
     f"{QUALITY}, {STYLE}, "
     "1girl, chibi, character sheet, reference sheet, "
     "multiple views, front and back, turnaround, "
     "long dark brown hair, gentle expression, sleepy eyes, "
     "cream sweater, pastel pink sleeves, pink pants, "
     "2.5 head ratio, full body, white background",
     NEG + ", merged, overlapping"),

    # === 소녀 치비 단독 (정면) ===
    ("girl_chibi_front",
     f"{QUALITY}, {STYLE}, "
     "1girl, chibi, solo, standing, looking at viewer, "
     "long dark brown hair, brown eyes, gentle expression, "
     "cream sweater, pastel pink sleeves, pink pants, "
     "full body, simple background, white background, game sprite",
     NEG_NOBG),

    # === 소녀 벤치 (단독 에셋) ===
    ("girl_bench",
     f"{QUALITY}, {STYLE}, "
     "1girl, solo, sitting, park bench, looking up, "
     "long dark brown hair, hair blowing, gentle expression, "
     "cream top, pastel pink accents, "
     "full body, simple background, white background, game sprite",
     NEG_NOBG),

    # === 유령 고양이 ===
    ("ghost_cat",
     f"{QUALITY}, {STYLE}, "
     "no humans, 1other, ghost cat, translucent white cat, "
     "blue tint, glowing ethereal body, sparkles, "
     "sitting, tail wrapped around paws, elegant, "
     "full body, simple background, white background, game sprite",
     NEG_NOBG),

    # === 유령 햄스터 ===
    ("ghost_hamster",
     f"{QUALITY}, {STYLE}, "
     "no humans, 1other, ghost hamster, tiny translucent hamster, "
     "white with pink tint, glowing, ethereal, sparkles, "
     "standing on hind legs, paws together, round fluffy, "
     "full body, simple background, white background, game sprite",
     NEG_NOBG),

    # === 골든 리트리버 유령 ===
    ("ghost_golden",
     f"{QUALITY}, {STYLE}, "
     "no humans, 1other, ghost golden retriever, large translucent dog, "
     "white with golden tint, glowing ethereal body, "
     "gentle wise expression, standing, sparkles, "
     "full body, simple background, white background, game sprite",
     NEG_NOBG),

    # === 배경 — 방 ===
    ("bg_bedroom",
     f"{QUALITY}, watercolor (medium), pastel colors, soft lighting, "
     "no humans, scenery, indoors, bedroom, "
     "small apartment, slightly messy, curtains half open, "
     "overcast daylight, desk, laptop, bed, white sheets, "
     "warm tones, cozy, lived-in, game background",
     "nsfw, lowres, text, watermark, worst quality, low quality, "
     "characters, people, animals, 3d, photograph"),

    # === 배경 — 무지개다리 ===
    ("bg_rainbow_bridge",
     f"{QUALITY}, watercolor (medium), pastel colors, soft lighting, "
     "no humans, scenery, outdoors, fantasy, "
     "rainbow bridge, pastel clouds, ethereal heavenly path, "
     "glowing golden bridge, lavender pink sky, "
     "sparkles, flower petals floating, dreamy, game background",
     "nsfw, lowres, text, watermark, worst quality, low quality, "
     "characters, people, animals, 3d, photograph"),

    # === 배경 — 벚꽃길 ===
    ("bg_cherry_blossom",
     f"{QUALITY}, watercolor (medium), pastel colors, soft lighting, "
     "no humans, scenery, outdoors, cherry blossoms, "
     "tree-lined path, pink petals falling, "
     "dappled sunlight, spring, gentle breeze, "
     "dreamy atmosphere, game background",
     "nsfw, lowres, text, watermark, worst quality, low quality, "
     "characters, people, animals, 3d, photograph"),
]

for i, (name, prompt, neg) in enumerate(TESTS):
    t0 = time.time()
    seed = 7777 + i * 23

    img = pipe(
        prompt=prompt,
        negative_prompt=neg,
        num_inference_steps=40,
        guidance_scale=9.0,
        height=SIZE,
        width=SIZE,
        generator=torch.Generator(device="cpu").manual_seed(seed),
    ).images[0]

    elapsed = time.time() - t0
    path = OUTPUT_DIR / f"{name}.png"
    img.save(path)
    fsize = path.stat().st_size
    status = "OK" if fsize > 5000 else "BLACK"
    print(f"  [{i+1}/{len(TESTS)}] {name} — {elapsed:.1f}s ({fsize//1024}KB) {status}")

    if fsize <= 5000:
        for rs in [seed + 111, seed + 222, seed + 444]:
            img2 = pipe(
                prompt=prompt, negative_prompt=neg,
                num_inference_steps=40, guidance_scale=9.0,
                height=SIZE, width=SIZE,
                generator=torch.Generator(device="cpu").manual_seed(rs),
            ).images[0]
            img2.save(path)
            if path.stat().st_size > 5000:
                print(f"    retry seed={rs} OK")
                break
            gc.collect(); torch.mps.empty_cache()

    gc.collect()
    torch.mps.empty_cache()

# Step 5: 후처리
print("\n[5/5] 후처리...")

# 배경 제거
try:
    from rembg import remove
    from PIL import Image
    nobg = OUTPUT_DIR / "no_background"
    nobg.mkdir(exist_ok=True)
    chars = [n for n, _, _ in TESTS if not n.startswith("bg_")]
    for name in chars:
        f = OUTPUT_DIR / f"{name}.png"
        if f.exists() and f.stat().st_size > 5000:
            r = remove(Image.open(f))
            r.save(nobg / f.name)
            print(f"  bg remove: {name} OK")
except Exception as e:
    print(f"  bg remove 실패: {e}")

# 1024 업스케일
from PIL import Image
up = OUTPUT_DIR / "upscaled_1024"
up.mkdir(exist_ok=True)
for f in OUTPUT_DIR.glob("*.png"):
    if f.name.startswith("_"): continue
    img = Image.open(f)
    if img.size[0] < 1024:
        img.resize((1024, 1024), Image.LANCZOS).save(up / f.name)
print(f"  upscale: {len(list(up.glob('*.png')))}장")

print("\n" + "=" * 60)
print(f"결과: {OUTPUT_DIR}")
print(f"모델: Animagine XL 3.1 + LoRA 스택")
print(f"해상도: {SIZE} → 1024 업스케일")
print("=" * 60)

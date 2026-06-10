"""
파스텔 수채화 게임 에셋 PoC v3
- 게임 캐릭터 스프라이트 (흰 배경, 단독 캐릭터)
- 캐릭터 시트 (앞/뒤 턴어라운드)
- 치비 비율, 투명 유령 효과
- Scenario.com 레퍼런스 매칭
"""
import torch
import gc
import time
from pathlib import Path

OUTPUT_DIR = Path.home() / "scenario-engine" / "pastel_v3"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

print("=" * 60)
print("파스텔 게임 에셋 v3 — 캐릭터 스프라이트 + 시트")
print("=" * 60)

device = "mps"
dtype = torch.float16

# Step 1: SDXL + DPM++
print("\n[1/4] SDXL + DPM++ 로드...")
from diffusers import StableDiffusionXLPipeline, DPMSolverMultistepScheduler

pipe = StableDiffusionXLPipeline.from_pretrained(
    "stabilityai/stable-diffusion-xl-base-1.0",
    torch_dtype=dtype,
    variant="fp16",
    use_safetensors=True,
)
pipe.scheduler = DPMSolverMultistepScheduler.from_config(
    pipe.scheduler.config,
    algorithm_type="dpmsolver++",
    use_karras_sigmas=True,
)
pipe.to(device)
print("  SDXL + DPM++ OK")

# Step 2: LoRA 이중 스택
print("\n[2/4] LoRA 로드...")
try:
    pipe.load_lora_weights(
        "ostris/watercolor_style_lora_sdxl",
        adapter_name="watercolor",
    )
    print("  watercolor OK")
except Exception as e:
    print(f"  watercolor 실패: {e}")

try:
    pipe.load_lora_weights(
        "Linaqruf/pastel-anime-xl-lora",
        weight_name="pastel-anime-xl-latest.safetensors",
        adapter_name="pastel",
    )
    print("  pastel-anime OK")
except Exception as e:
    print(f"  pastel-anime 실패: {e}")

try:
    pipe.set_adapters(["watercolor", "pastel"], adapter_weights=[0.45, 0.6])
    print("  LoRA 스택: watercolor=0.45, pastel=0.6")
except Exception:
    print("  (fused 모드)")

gc.collect()
torch.mps.empty_cache()

# 게임 에셋 프롬프트 — 핵심: 흰 배경 + 캐릭터 단독
STYLE = (
    "masterpiece, best quality, "
    "pastel watercolor style, soft pencil outlines, "
    "gentle muted pastel colors, delicate brush strokes, "
)

# 게임 에셋 전용 네거티브 — 배경 요소 강하게 제거
NEG = (
    "worst quality, low quality, realistic, photograph, 3D render, "
    "background, scenery, landscape, room, sky, grass, trees, "
    "dark, horror, ugly, deformed, blurry, watermark, text, "
    "extra limbs, bad anatomy, bad hands, missing fingers, "
    "harsh colors, neon, oversaturated, multiple characters"
)

# 캐릭터 시트 네거티브 — 배경 제거 + 겹침 방지
NEG_SHEET = (
    "worst quality, low quality, realistic, photograph, 3D render, "
    "background, scenery, landscape, dark, horror, ugly, deformed, "
    "blurry, watermark, text, extra limbs, bad anatomy, "
    "harsh colors, neon, oversaturated, overlapping characters, merged bodies"
)

print("\n[3/4] 게임 에셋 생성 (768x768, 35 steps)...")

TESTS = [
    # === 유령 강아지 스프라이트 (개별 포즈) ===
    ("ghost_dog_stand",
     f"{STYLE}"
     "small fluffy white ghost dog, standing on all fours, front view, "
     "translucent glowing body, soft lavender and pink tint, "
     "sparkles around body, wide round cute eyes, tiny nose, "
     "clean white background, isolated character, game sprite",
     NEG),

    ("ghost_dog_walk",
     f"{STYLE}"
     "small fluffy white ghost dog, walking pose, side view, "
     "translucent ethereal glowing body, lavender pink aura, "
     "one paw forward, sparkle trail, cute expression, "
     "clean white background, isolated character, game sprite",
     NEG),

    ("ghost_dog_jump",
     f"{STYLE}"
     "small fluffy white ghost dog, jumping upward joyfully, "
     "all paws off ground, excited happy expression, "
     "translucent glowing body, sparkle effects around, "
     "clean white background, isolated character, game sprite",
     NEG),

    ("ghost_dog_sleep",
     f"{STYLE}"
     "small fluffy white ghost dog, sleeping on side, "
     "belly exposed, legs stretched relaxed, peaceful face, "
     "translucent soft glow, gentle sparkles, "
     "clean white background, isolated character, game sprite",
     NEG),

    # === 유령 강아지 캐릭터 시트 (3포즈) ===
    ("ghost_dog_sheet",
     f"{STYLE}"
     "character sheet, three poses of same fluffy ghost dog, "
     "walking standing sitting, translucent lavender pink glow, "
     "sparkles, wide round eyes, consistent design, "
     "clean white background, reference sheet, game asset",
     NEG_SHEET),

    # === 소녀 치비 캐릭터 (앞뒤) ===
    ("girl_chibi_sheet",
     f"{STYLE}"
     "chibi character sheet, young girl, front view and back view, "
     "long dark brown hair, gentle sleepy expression, "
     "cream sweater with pastel pink sleeves, pink pants, "
     "2.5 head ratio chibi proportions, full body, "
     "clean white background, character turnaround, game asset",
     NEG_SHEET),

    # === 소녀 치비 단독 (앞면) ===
    ("girl_chibi_front",
     f"{STYLE}"
     "chibi girl, front view, full body standing, "
     "long dark brown hair, big gentle eyes, sleepy expression, "
     "loose cream sweater with pastel pink sleeves, pink pants, "
     "small cute proportions, 2.5 head ratio, "
     "clean white background, isolated character, game sprite",
     NEG),

    # === 소녀 벤치 앉기 (단독) ===
    ("girl_sitting_bench",
     f"{STYLE}"
     "chibi girl sitting on wooden bench, looking up at sky, "
     "long dark brown hair flowing, gentle expression, "
     "cream top with pink accents, wind blowing hair, "
     "clean white background, isolated character with bench, game asset",
     NEG),

    # === 유령 고양이 ===
    ("ghost_cat",
     f"{STYLE}"
     "small ghost cat, translucent white with blue tint, "
     "sitting elegantly, tail wrapped around paws, "
     "glowing ethereal body, sparkles, cute face, "
     "clean white background, isolated character, game sprite",
     NEG),

    # === 유령 햄스터 ===
    ("ghost_hamster",
     f"{STYLE}"
     "tiny ghost hamster, translucent white with pink tint, "
     "standing on hind legs, tiny paws together, "
     "round fluffy body, glowing ethereal, sparkles, "
     "clean white background, isolated character, game sprite",
     NEG),

    # === 골든 리트리버 유령 (큰 강아지) ===
    ("ghost_golden",
     f"{STYLE}"
     "large ghost golden retriever, translucent white with gold tint, "
     "standing on all fours, gentle wise expression, "
     "glowing ethereal body, soft sparkles, "
     "clean white background, isolated character, game sprite",
     NEG),

    # === 배경 에셋 (별도) ===
    ("bg_bedroom_light",
     f"{STYLE}"
     "small apartment bedroom, slightly messy, "
     "curtains half open, overcast gray daylight, "
     "desk with laptop, bed with white sheets, warm tones, "
     "cozy lived-in atmosphere, game background asset",
     "worst quality, low quality, realistic, photograph, 3D, "
     "characters, people, animals, dark, horror, ugly, deformed, "
     "blurry, watermark, text, harsh colors, neon"),

    ("bg_rainbow_bridge",
     f"{STYLE}"
     "rainbow bridge in soft pastel clouds, ethereal heavenly path, "
     "glowing golden bridge across lavender pink sky, "
     "sparkles and flower petals floating, "
     "dreamy panoramic, game background asset",
     "worst quality, low quality, realistic, photograph, 3D, "
     "characters, people, animals, dark, horror, ugly, watermark, text"),
]

for i, (name, prompt, neg) in enumerate(TESTS):
    t0 = time.time()
    seed = 2024 + i * 17

    img = pipe(
        prompt=prompt,
        negative_prompt=neg,
        num_inference_steps=35,
        guidance_scale=8.5,  # 약간 올림 — 프롬프트 충실도 향상
        height=768,
        width=768,
        generator=torch.Generator(device="cpu").manual_seed(seed),
    ).images[0]

    elapsed = time.time() - t0
    path = OUTPUT_DIR / f"{name}.png"
    img.save(path)
    fsize = path.stat().st_size
    status = "OK" if fsize > 5000 else "BLACK"

    print(f"  [{i+1}/{len(TESTS)}] {name} — {elapsed:.1f}s ({fsize//1024}KB) {status}")

    # NaN 재시도
    if fsize <= 5000:
        for retry_seed in [seed + 100, seed + 200, seed + 333]:
            img2 = pipe(
                prompt=prompt,
                negative_prompt=neg,
                num_inference_steps=35,
                guidance_scale=8.5,
                height=768, width=768,
                generator=torch.Generator(device="cpu").manual_seed(retry_seed),
            ).images[0]
            img2.save(path)
            if path.stat().st_size > 5000:
                print(f"    retry seed={retry_seed} OK")
                break
            gc.collect()
            torch.mps.empty_cache()

    gc.collect()
    torch.mps.empty_cache()

# Step 4: 배경 제거 (캐릭터만)
print("\n[4/4] 배경 제거...")
try:
    from rembg import remove
    from PIL import Image
    nobg = OUTPUT_DIR / "no_background"
    nobg.mkdir(exist_ok=True)
    char_names = [
        "ghost_dog_stand", "ghost_dog_walk", "ghost_dog_jump", "ghost_dog_sleep",
        "ghost_dog_sheet", "girl_chibi_sheet", "girl_chibi_front", "girl_sitting_bench",
        "ghost_cat", "ghost_hamster", "ghost_golden",
    ]
    for name in char_names:
        f = OUTPUT_DIR / f"{name}.png"
        if f.exists() and f.stat().st_size > 5000:
            r = remove(Image.open(f))
            r.save(nobg / f.name)
            print(f"  {name} OK")
except Exception as e:
    print(f"  실패: {e}")

# 1024 업스케일
print("\n[BONUS] 1024 업스케일...")
from PIL import Image
upscaled = OUTPUT_DIR / "upscaled_1024"
upscaled.mkdir(exist_ok=True)
for f in OUTPUT_DIR.glob("*.png"):
    img = Image.open(f)
    if img.size[0] < 1024:
        img.resize((1024, 1024), Image.LANCZOS).save(upscaled / f.name)
print(f"  {len(list(upscaled.glob('*.png')))}장 완료")

print("\n" + "=" * 60)
print(f"결과: {OUTPUT_DIR}")
print("캐릭터 스프라이트 + 시트 + 배경 분리")
print("=" * 60)

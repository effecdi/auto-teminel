"""
FLUX.1-schnell 로컬 — QuantoConfig로 로딩 시 양자화 (OOM 방지)
"""
import os
os.environ["HF_HUB_CACHE"] = "/Volumes/TrainingHDD/.cache/huggingface/hub"
os.environ["TRANSFORMERS_CACHE"] = "/Volumes/TrainingHDD/.cache/huggingface/hub"
os.environ["HF_TOKEN"] = "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"

import torch
import gc
import time
from pathlib import Path

OUTPUT_DIR = Path.home() / "scenario-engine" / "flux_schnell"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

print("=" * 60)
print("FLUX.1-schnell — QuantoConfig 8-bit")
print("=" * 60)

dtype = torch.bfloat16
MODEL_ID = "black-forest-labs/FLUX.1-schnell"

# QuantoConfig — 로딩하면서 바로 양자화 (메모리 피크 최소화)
print("\n[1/2] 파이프라인 로드 (QuantoConfig float8)...")
from diffusers import FluxPipeline, FluxTransformer2DModel, QuantoConfig

quant_config = QuantoConfig(weights="float8")

# Step 1: Transformer만 양자화 로드 (가장 큰 컴포넌트)
print("  Transformer 양자화 로드...")
transformer = FluxTransformer2DModel.from_pretrained(
    MODEL_ID,
    subfolder="transformer",
    quantization_config=quant_config,
    torch_dtype=dtype,
)
print(f"  Transformer OK")
gc.collect()

# Step 2: 전체 파이프라인 조립 (T5는 bf16 그대로, transformer는 양자화된 것 사용)
print("  파이프라인 조립...")
pipe = FluxPipeline.from_pretrained(
    MODEL_ID,
    transformer=transformer,
    torch_dtype=dtype,
)
# T5는 추론 후 자동 offload됨
pipe.enable_model_cpu_offload(device="mps")
pipe.vae.enable_slicing()
pipe.vae.enable_tiling()
print("  파이프라인 OK")

del transformer
gc.collect()
torch.mps.empty_cache()

# 생성
print("\n[2/2] 게임 에셋 생성 (512x512, 4 steps)...")

TESTS = [
    ("ghost_dog_stand",
     "A cute small fluffy white ghost dog standing on all fours facing the viewer, "
     "pastel watercolor illustration style with soft pencil outlines, "
     "translucent glowing body with lavender and pink luminescence, "
     "sparkles and tiny stars around it, wide round innocent eyes, "
     "isolated character on pure white background, game sprite asset"),

    ("ghost_dog_leap",
     "A cute small fluffy white ghost dog leaping forward mid-air, "
     "front paws extended, excited joyful expression, "
     "pastel watercolor style, soft dreamy storybook illustration, "
     "translucent ethereal glowing body, sparkle trail, "
     "isolated on pure white background, game sprite"),

    ("ghost_dog_jump",
     "A cute small fluffy white ghost dog jumping upward joyfully, "
     "all four paws off the ground reaching upward, happy expression, "
     "pastel watercolor style with soft pencil outlines, "
     "translucent glowing body with sparkle effects, "
     "isolated on pure white background, game character sprite"),

    ("ghost_dog_sleep",
     "A cute small fluffy white ghost dog sleeping peacefully on its side, "
     "belly exposed, legs stretched out relaxed, serene expression, "
     "pastel watercolor style, soft gentle glow around body, "
     "translucent ethereal, tiny sparkles, "
     "isolated on pure white background, game sprite asset"),

    ("ghost_dog_sheet",
     "Character reference sheet of a cute fluffy ghost dog with translucent "
     "glowing lavender and pink fur, shown in three poses: walking, standing, "
     "and sitting, consistent design across all poses, wide round eyes, "
     "soft pastel watercolor illustration style, sparkles, "
     "clean white background, game asset reference sheet"),

    ("girl_chibi_sheet",
     "Chibi character reference sheet showing front view and back view of "
     "a young girl with long dark brown hair and gentle sleepy expression, "
     "wearing a loose cream-colored sweater with pastel pink sleeves and "
     "matching pink pants, 2.5 head ratio chibi proportions, "
     "pastel watercolor style, clean white background"),

    ("girl_chibi_solo",
     "A chibi-style young woman with compact small body, 2.5 to 3 head ratio, "
     "long dark brown hair, gentle kind expression, "
     "wearing casual home clothes in cream and pastel pink colors, "
     "pastel watercolor illustration style with soft outlines, "
     "full body standing pose, isolated on pure white background, game sprite"),

    ("ghost_cat",
     "A small ghost cat sitting elegantly with tail wrapped around paws, "
     "translucent white body with blue tint, ethereal glowing, "
     "pastel watercolor style with soft pencil outlines, "
     "sparkles around body, cute face with big eyes, "
     "isolated on pure white background, game character sprite"),

    ("ghost_hamster",
     "A tiny ghost hamster standing on hind legs with tiny paws together, "
     "translucent white body with pink tint, round fluffy shape, "
     "pastel watercolor style, ethereal glow, sparkles, "
     "adorable big eyes, isolated on pure white background, game sprite"),

    ("ghost_golden",
     "A large ghost golden retriever standing on all fours, "
     "translucent white body with warm golden tint, gentle wise expression, "
     "pastel watercolor style with soft outlines, ethereal glowing, "
     "soft sparkles, isolated on pure white background, game character sprite"),

    ("bg_bedroom",
     "A small cozy apartment bedroom in pastel watercolor style, "
     "slightly messy but charming, sheer curtains half open, "
     "overcast gray daylight, desk with laptop, bed with white sheets, "
     "warm muted tones, lived-in atmosphere, "
     "dreamy storybook illustration, game background asset"),

    ("bg_rainbow_bridge",
     "A magnificent rainbow bridge stretching across a dreamy pastel sky, "
     "soft glowing golden bridge path through lavender and pink clouds, "
     "tiny sparkles and flower petals floating in the air, "
     "ethereal heavenly atmosphere, "
     "pastel watercolor illustration style, game background"),

    ("scene_girl_dog_park",
     "A girl walking with a small white ghost dog in a cherry blossom park, "
     "both looking happy, soft pink petals falling, "
     "pastel watercolor style with pencil outlines, "
     "gentle warm lighting, dreamy storybook illustration"),

    ("wise_old_man",
     "A wise celestial old man with long white flowing beard, "
     "wearing gentle glowing golden robes, kind wise eyes, "
     "pastel watercolor style with soft pencil outlines, "
     "ethereal warm glow, isolated on pure white background, game character"),
]

for i, (name, prompt) in enumerate(TESTS):
    t0 = time.time()
    seed = 12345 + i * 37

    try:
        img = pipe(
            prompt=prompt,
            num_inference_steps=4,
            guidance_scale=0.0,
            height=512,
            width=512,
            generator=torch.Generator("cpu").manual_seed(seed),
        ).images[0]

        elapsed = time.time() - t0
        path = OUTPUT_DIR / f"{name}.png"
        img.save(path)
        fsize = path.stat().st_size
        status = "OK" if fsize > 5000 else "FAIL"
        print(f"  [{i+1}/{len(TESTS)}] {name} — {elapsed:.1f}s ({fsize//1024}KB) {status}")

        if fsize <= 5000:
            for rs in [seed + 100, seed + 200, seed + 444]:
                img2 = pipe(
                    prompt=prompt,
                    num_inference_steps=4,
                    guidance_scale=0.0,
                    height=512, width=512,
                    generator=torch.Generator("cpu").manual_seed(rs),
                ).images[0]
                img2.save(path)
                if path.stat().st_size > 5000:
                    print(f"    retry seed={rs} OK")
                    break
                gc.collect(); torch.mps.empty_cache()

    except Exception as e:
        elapsed = time.time() - t0
        print(f"  [{i+1}/{len(TESTS)}] {name} — ERROR ({elapsed:.1f}s): {e}")

    gc.collect()
    torch.mps.empty_cache()

# 배경 제거
print("\n[BONUS] 배경 제거...")
try:
    from rembg import remove
    from PIL import Image
    nobg = OUTPUT_DIR / "no_background"
    nobg.mkdir(exist_ok=True)
    char_names = [n for n, _ in TESTS if not n.startswith("bg_") and not n.startswith("scene_")]
    for name in char_names:
        f = OUTPUT_DIR / f"{name}.png"
        if f.exists() and f.stat().st_size > 5000:
            r = remove(Image.open(f))
            r.save(nobg / f.name)
            print(f"  {name} OK")
except Exception as e:
    print(f"  실패: {e}")

print("\n" + "=" * 60)
print(f"결과: {OUTPUT_DIR}")
print("FLUX.1-schnell QuantoConfig 8-bit 완료")
print("=" * 60)

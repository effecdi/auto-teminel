"""
커스텀 LoRA로 게임 에셋 생성 — Scenario.com 스타일 매칭
"""
import torch
import gc
import time
from pathlib import Path

OUTPUT_DIR = Path.home() / "scenario-engine" / "custom_lora_test"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

print("=" * 60)
print("커스텀 LoRA 테스트 — Scenario.com 스타일")
print("=" * 60)

device = "mps"
dtype = torch.float16

# Animagine XL 3.1 + DPM++
print("\n[1/3] 파이프라인 로드...")
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
print("  Animagine XL 3.1 OK")

# 커스텀 LoRA 로드
print("\n[2/3] 커스텀 LoRA 로드...")
LORA_PATH = Path.home() / "scenario-engine" / "lora_output" / "final"

pipe.load_lora_weights(str(LORA_PATH))
pipe.fuse_lora(lora_scale=0.75)
print(f"  커스텀 LoRA OK (scale=0.75)")

gc.collect()
torch.mps.empty_cache()

# Scenario.com 레퍼런스에서 추출한 실제 프롬프트 사용
NEG = (
    "realistic, 3D, photograph, sharp edges, dark, horror, ugly, deformed, "
    "blurry, low quality, watermark, text, extra limbs, "
    "harsh colors, neon, oversaturated"
)
NEG_NOBG = NEG + ", background, scenery, landscape"

print("\n[3/3] 생성 (832x832, 40 steps)...")

TESTS = [
    # Scenario.com 실제 프롬프트 기반
    ("ghost_dog_stand",
     "pastel watercolor style, soft pencil outlines, dreamy storybook illustration, "
     "gentle muted colors, small fluffy white maltese ghost dog, standing on all fours "
     "facing viewer, translucent glowing body, sparkles, white background",
     NEG_NOBG),

    ("ghost_dog_leap",
     "pastel watercolor style, soft pencil outlines, dreamy storybook illustration, "
     "gentle muted colors, small fluffy white ghost dog leaping forward, "
     "front paws extended, mid-air, excited expression, sparkles, white background",
     NEG_NOBG),

    ("ghost_dog_jump",
     "pastel watercolor style, soft pencil outlines, dreamy storybook illustration, "
     "gentle muted colors, small fluffy white ghost dog jumping upward joyfully, "
     "all paws off ground, front paws reaching up, sparkle effects, white background",
     NEG_NOBG),

    ("ghost_dog_sleep",
     "pastel watercolor style, soft pencil outlines, dreamy storybook illustration, "
     "gentle muted colors, small fluffy white ghost dog sleeping on side, "
     "belly exposed, legs stretched relaxed, peaceful expression, soft glow, "
     "translucent, white background",
     NEG_NOBG),

    ("ghost_dog_sheet",
     "Character sheet of a fluffy pastel dog with translucent, glowing lavender and "
     "pink fur. The dog is shown in three poses: walking, standing, and sitting "
     "with wide round eyes. Soft lines, sparkles, gentle lighting, white background",
     NEG + ", merged, overlapping"),

    ("girl_chibi_sheet",
     "Chibi character sheet of a young girl with long dark brown hair and a gentle "
     "sleepy expression. She wears a loose cream-colored sweater with pastel pink "
     "sleeves and matching pink pants. The sheet shows both front and back views, "
     "white background",
     NEG + ", merged, overlapping"),

    ("girl_chibi_solo",
     "A young woman, chibi-style proportions, 2.5 to 3 head ratio, compact small body, "
     "casual home clothes, long dark brown hair, gentle expression, "
     "pastel watercolor style, white background",
     NEG_NOBG),

    ("ghost_cat",
     "pastel watercolor style, soft pencil outlines, dreamy storybook illustration, "
     "gentle muted colors, small ghost cat, translucent white with blue tint, "
     "sitting elegantly, tail wrapped around paws, sparkles, white background",
     NEG_NOBG),

    ("ghost_hamster",
     "pastel watercolor style, soft pencil outlines, dreamy storybook illustration, "
     "gentle muted colors, tiny ghost hamster, translucent white pink tint, "
     "standing on hind legs, tiny paws together, round fluffy, sparkles, white background",
     NEG_NOBG),

    ("ghost_golden",
     "pastel watercolor style, soft pencil outlines, dreamy storybook illustration, "
     "gentle muted colors, large ghost golden retriever, translucent white with gold tint, "
     "standing on all fours, gentle wise expression, sparkles, white background",
     NEG_NOBG),

    ("bg_bedroom",
     "pastel watercolor style, soft pencil outlines, dreamy storybook illustration, "
     "gentle muted colors, small apartment bedroom, slightly messy, curtains half open, "
     "overcast gray daylight, desk with laptop, bed with white sheets, warm tones",
     "realistic, 3D, photograph, characters, people, animals, dark, ugly, watermark, text"),

    ("bg_rainbow_bridge",
     "rainbow bridge in soft pastel clouds, ethereal heavenly path, "
     "glowing golden bridge stretching across lavender pink sky, "
     "sparkles and flower petals, pastel watercolor style",
     "realistic, 3D, photograph, characters, people, animals, dark, ugly, watermark, text"),

    ("scene_girl_dog_park",
     "pastel watercolor style, soft pencil outlines, dreamy storybook illustration, "
     "gentle muted colors, golden vignette edges, girl walking with small white dog "
     "in park, cherry blossoms, both looking happy",
     NEG),

    ("wise_old_man",
     "wise celestial old man, long white flowing beard, "
     "gentle glowing golden robes, kind wise eyes, "
     "pastel watercolor style, soft pencil outlines, white background",
     NEG_NOBG),
]

for i, (name, prompt, neg) in enumerate(TESTS):
    t0 = time.time()
    seed = 5555 + i * 31

    img = pipe(
        prompt=prompt,
        negative_prompt=neg,
        num_inference_steps=40,
        guidance_scale=8.0,
        height=832,
        width=832,
        generator=torch.Generator(device="cpu").manual_seed(seed),
    ).images[0]

    elapsed = time.time() - t0
    path = OUTPUT_DIR / f"{name}.png"
    img.save(path)
    fsize = path.stat().st_size
    status = "OK" if fsize > 5000 else "BLACK"
    print(f"  [{i+1}/{len(TESTS)}] {name} — {elapsed:.1f}s ({fsize//1024}KB) {status}")

    if fsize <= 5000:
        for rs in [seed + 100, seed + 200, seed + 444]:
            img2 = pipe(
                prompt=prompt, negative_prompt=neg,
                num_inference_steps=40, guidance_scale=8.0,
                height=832, width=832,
                generator=torch.Generator(device="cpu").manual_seed(rs),
            ).images[0]
            img2.save(path)
            if path.stat().st_size > 5000:
                print(f"    retry OK")
                break
            gc.collect(); torch.mps.empty_cache()

    gc.collect()
    torch.mps.empty_cache()

# 배경 제거
print("\n[BONUS] 배경 제거...")
try:
    from rembg import remove
    from PIL import Image
    nobg = OUTPUT_DIR / "no_background"
    nobg.mkdir(exist_ok=True)
    for name in ["ghost_dog_stand","ghost_dog_leap","ghost_dog_jump","ghost_dog_sleep",
                  "ghost_dog_sheet","girl_chibi_sheet","girl_chibi_solo",
                  "ghost_cat","ghost_hamster","ghost_golden","wise_old_man"]:
        f = OUTPUT_DIR / f"{name}.png"
        if f.exists() and f.stat().st_size > 5000:
            r = remove(Image.open(f))
            r.save(nobg / f.name)
            print(f"  {name} OK")
except Exception as e:
    print(f"  실패: {e}")

# 업스케일
from PIL import Image
up = OUTPUT_DIR / "upscaled_1024"
up.mkdir(exist_ok=True)
for f in OUTPUT_DIR.glob("*.png"):
    img = Image.open(f)
    if img.size[0] < 1024:
        img.resize((1024, 1024), Image.LANCZOS).save(up / f.name)
print(f"  업스케일: {len(list(up.glob('*.png')))}장")

print("\n" + "=" * 60)
print(f"결과: {OUTPUT_DIR}")
print("커스텀 LoRA (Scenario.com 스타일) 적용 완료")
print("=" * 60)

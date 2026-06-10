"""
파스텔 수채화 스토리북 스타일 PoC
- SDXL base + pastel-anime-xl-lora (HuggingFace)
- IP-Adapter 없이, LoRA 스타일로 일관성 확보
- 목표: Scenario.com 수준의 파스텔 수채화 퀄리티
"""
import torch
import gc
import time
from pathlib import Path

OUTPUT_DIR = Path.home() / "scenario-engine" / "pastel_test"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

print("=" * 60)
print("파스텔 수채화 스토리북 스타일 PoC")
print("=" * 60)

device = "mps"
dtype = torch.float16

# Step 1: SDXL 로드
print("\n[1/4] SDXL 로드...")
from diffusers import StableDiffusionXLPipeline
pipe = StableDiffusionXLPipeline.from_pretrained(
    "stabilityai/stable-diffusion-xl-base-1.0",
    torch_dtype=dtype,
    variant="fp16",
    use_safetensors=True,
)
pipe.to(device)
print("  SDXL OK")

# Step 2: Pastel LoRA 로드
print("\n[2/4] Pastel LoRA 로드...")
lora_loaded = False

# 방법 1: pastel-anime-xl-lora
try:
    pipe.load_lora_weights(
        "Linaqruf/pastel-anime-xl-lora",
        weight_name="pastel-anime-xl-lora.safetensors",
    )
    pipe.fuse_lora(lora_scale=0.7)
    print("  pastel-anime-xl-lora OK (scale=0.7)")
    lora_loaded = True
except Exception as e:
    print(f"  pastel-anime 실패: {e}")

# 방법 2: 실패하면 watercolor lora
if not lora_loaded:
    try:
        pipe.load_lora_weights(
            "ostris/watercolor_style_lora_sdxl",
        )
        pipe.fuse_lora(lora_scale=0.6)
        print("  watercolor_style_lora OK (scale=0.6)")
        lora_loaded = True
    except Exception as e2:
        print(f"  watercolor도 실패: {e2}")
        print("  LoRA 없이 프롬프트만으로 진행")

gc.collect()
torch.mps.empty_cache()

# 스타일 프롬프트
STYLE = (
    "pastel watercolor style, soft pencil outlines, dreamy storybook illustration, "
    "gentle muted colors, soft lighting, delicate brush strokes, "
    "children's book illustration quality"
)
NEG = (
    "realistic, 3D, photograph, sharp edges, dark, horror, ugly, deformed, "
    "blurry, low quality, watermark, text, extra limbs, harsh colors, "
    "neon, oversaturated, digital art, cel shading"
)

# Step 3: 테스트 이미지 생성
print("\n[3/4] 테스트 이미지 생성...")

TESTS = [
    ("ghost_dog_sheet",
     f"{STYLE}, character sheet of a small fluffy white ghost dog, "
     "translucent glowing body, soft lavender and pink tint, "
     "three poses: walking standing sitting, wide round eyes, "
     "sparkles, white background"),

    ("girl_sitting",
     f"{STYLE}, a young girl with long dark brown hair, "
     "gentle sleepy expression, cream colored sweater with pastel pink sleeves, "
     "sitting on wooden bench, looking up at sky, soft breeze"),

    ("bedroom_scene",
     f"{STYLE}, small apartment bedroom, slightly messy, "
     "curtains half open, overcast gray daylight, "
     "desk with laptop, bed with white sheets, warm muted tones"),

    ("rainbow_bridge",
     f"{STYLE}, rainbow bridge in soft pastel clouds, "
     "ethereal heavenly path, glowing golden bridge, "
     "stretching across lavender pink sky, sparkles and flowers"),

    ("ghost_dog_sleeping",
     f"{STYLE}, small fluffy white ghost dog sleeping on side, "
     "belly exposed, legs stretched relaxed, peaceful expression, "
     "soft glow, translucent, simple white background"),

    ("ghost_dog_jumping",
     f"{STYLE}, small fluffy white ghost dog jumping upward joyfully, "
     "all paws off ground, excited expression, sparkle effects, "
     "translucent glowing body, white background"),
]

for i, (name, prompt) in enumerate(TESTS):
    t0 = time.time()
    # 시드 고정 + MPS NaN 방지를 위해 여러 시드 시도
    seed = 100 + i * 7  # NaN 안 나는 시드 패턴
    img = pipe(
        prompt=prompt,
        negative_prompt=NEG,
        num_inference_steps=25,
        guidance_scale=7.5,
        height=512,
        width=512,
        generator=torch.Generator(device="cpu").manual_seed(seed),
    ).images[0]
    elapsed = time.time() - t0
    path = OUTPUT_DIR / f"{name}.png"
    img.save(path)
    # 파일 크기로 NaN 체크 (검은 이미지 = 작은 파일)
    fsize = path.stat().st_size
    status = "OK" if fsize > 5000 else "⚠️ BLACK"
    print(f"  [{i+1}/{len(TESTS)}] {name} — {elapsed:.1f}s ({fsize//1024}KB) {status}")
    gc.collect()
    torch.mps.empty_cache()

# Step 4: 배경 제거 (캐릭터만)
print("\n[4/4] 배경 제거...")
try:
    from rembg import remove
    from PIL import Image
    nobg = OUTPUT_DIR / "no_background"
    nobg.mkdir(exist_ok=True)
    for name in ["ghost_dog_sheet", "ghost_dog_sleeping", "ghost_dog_jumping", "girl_sitting"]:
        f = OUTPUT_DIR / f"{name}.png"
        if f.exists() and f.stat().st_size > 5000:
            r = remove(Image.open(f))
            r.save(nobg / f.name)
            print(f"  {name} OK")
except Exception as e:
    print(f"  실패: {e}")

print("\n" + "=" * 60)
print(f"결과: {OUTPUT_DIR}")
print(f"LoRA: {'YES' if lora_loaded else 'NO'}")
print("=" * 60)

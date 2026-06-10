"""
파스텔 수채화 스토리북 스타일 PoC v2 — 퀄리티 강화
- SDXL base + watercolor LoRA + pastel-anime LoRA 이중 스택
- DPM++ 2M Karras scheduler (SDXL 퀄리티 향상)
- 35 steps, 해상도 768 시도 (NaN→512 폴백)
- Scenario.com 레퍼런스 수준 타겟
"""
import torch
import gc
import time
from pathlib import Path

OUTPUT_DIR = Path.home() / "scenario-engine" / "pastel_v2"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

print("=" * 60)
print("파스텔 수채화 v2 — 퀄리티 강화 (LoRA 2중 + DPM++)")
print("=" * 60)

device = "mps"
dtype = torch.float16

# Step 1: SDXL + DPM++ scheduler
print("\n[1/5] SDXL + DPM++ 2M Karras 로드...")
from diffusers import StableDiffusionXLPipeline, DPMSolverMultistepScheduler

pipe = StableDiffusionXLPipeline.from_pretrained(
    "stabilityai/stable-diffusion-xl-base-1.0",
    torch_dtype=dtype,
    variant="fp16",
    use_safetensors=True,
)

# DPM++ 2M Karras — SDXL에서 가장 퀄리티 좋은 scheduler 중 하나
pipe.scheduler = DPMSolverMultistepScheduler.from_config(
    pipe.scheduler.config,
    algorithm_type="dpmsolver++",
    use_karras_sigmas=True,
)

pipe.to(device)
print("  SDXL + DPM++ OK")

# Step 2: LoRA 스택 (watercolor + pastel anime)
print("\n[2/5] LoRA 이중 스택...")

# 먼저 watercolor LoRA
try:
    pipe.load_lora_weights(
        "ostris/watercolor_style_lora_sdxl",
        adapter_name="watercolor",
    )
    print("  watercolor LoRA OK")
except Exception as e:
    print(f"  watercolor 실패: {e}")
    # adapter_name 미지원 시 fallback
    try:
        pipe.load_lora_weights("ostris/watercolor_style_lora_sdxl")
        pipe.fuse_lora(lora_scale=0.5)
        print("  watercolor LoRA OK (fused, scale=0.5)")
    except Exception as e2:
        print(f"  watercolor 완전 실패: {e2}")

# pastel anime LoRA — 정확한 파일명 사용
try:
    pipe.load_lora_weights(
        "Linaqruf/pastel-anime-xl-lora",
        weight_name="pastel-anime-xl-latest.safetensors",
        adapter_name="pastel",
    )
    print("  pastel-anime LoRA OK")
except Exception as e:
    print(f"  pastel-anime adapter 실패: {e}")
    # adapter_name 미지원 시 fallback — fuse 후 두번째 로드
    try:
        pipe.load_lora_weights(
            "Linaqruf/pastel-anime-xl-lora",
            weight_name="pastel-anime-xl-latest.safetensors",
        )
        pipe.fuse_lora(lora_scale=0.5)
        print("  pastel-anime LoRA OK (fused, scale=0.5)")
    except Exception as e2:
        print(f"  pastel-anime 완전 실패: {e2}")

# adapter 방식 성공 시 가중치 설정
try:
    pipe.set_adapters(["watercolor", "pastel"], adapter_weights=[0.5, 0.55])
    print("  LoRA 스택: watercolor=0.5, pastel=0.55")
except Exception:
    print("  (fused 모드로 진행)")

gc.collect()
torch.mps.empty_cache()

# Step 3: 해상도 테스트 (768 시도)
print("\n[3/5] 해상도 테스트...")

STYLE_PREFIX = (
    "masterpiece, best quality, "
    "soft pastel watercolor illustration, dreamy ethereal storybook art, "
    "delicate pencil outlines with watercolor wash, "
    "gentle muted pastel palette, warm soft lighting, "
    "whimsical children's book illustration, Studio Ghibli inspired softness, "
    "translucent layered watercolor technique, "
)

NEG = (
    "worst quality, low quality, normal quality, "
    "realistic, photorealistic, 3D render, photograph, "
    "sharp hard edges, dark shadows, horror, ugly, deformed, "
    "blurry, noise, watermark, text, signature, extra limbs, "
    "harsh colors, neon, oversaturated, high contrast, "
    "digital art, cel shading, flat colors, vector art, "
    "bad anatomy, bad hands, missing fingers"
)

# 768 테스트 — NaN 나면 512로 폴백
test_res = 768
try:
    test_img = pipe(
        prompt=f"{STYLE_PREFIX}a small fluffy white cat sitting, simple white background",
        negative_prompt=NEG,
        num_inference_steps=10,  # 빠른 테스트
        guidance_scale=7.0,
        height=test_res, width=test_res,
        generator=torch.Generator(device="cpu").manual_seed(42),
    ).images[0]
    # NaN 체크
    test_path = OUTPUT_DIR / "_test_768.png"
    test_img.save(test_path)
    if test_path.stat().st_size > 5000:
        SIZE = 768
        print(f"  768x768 OK!")
    else:
        SIZE = 512
        print(f"  768 NaN → 512로 폴백")
    test_path.unlink()
except Exception as e:
    SIZE = 512
    print(f"  768 실패({e}) → 512로 폴백")

gc.collect()
torch.mps.empty_cache()
print(f"  최종 해상도: {SIZE}x{SIZE}")

# Step 4: Scenario.com 레퍼런스 매칭 이미지 생성
print(f"\n[4/5] 이미지 생성 ({SIZE}x{SIZE}, 35 steps)...")

TESTS = [
    # 1. 유령 강아지 캐릭터 시트 — Scenario.com 레퍼런스의 핵심 캐릭터
    ("ghost_dog_sheet",
     f"{STYLE_PREFIX}"
     "character reference sheet of an adorable small fluffy white ghost puppy, "
     "translucent glowing ethereal body with soft lavender and pink luminescence, "
     "wide sparkling round eyes full of innocence, tiny floppy ears, "
     "multiple poses: sitting, walking, sleeping, playing, "
     "surrounded by tiny sparkles and star particles, "
     "pure white background, consistent character design across all poses"),

    # 2. 소녀 + 유령 강아지 — 감성 장면
    ("girl_with_ghost",
     f"{STYLE_PREFIX}"
     "a gentle young girl with long flowing dark brown hair, "
     "wearing an oversized cozy cream sweater with pastel pink accents, "
     "sitting peacefully on a wooden park bench in autumn, "
     "a small translucent glowing white ghost puppy floating beside her, "
     "soft golden hour lighting filtering through trees, "
     "falling leaves in warm amber tones, dreamy bokeh background"),

    # 3. 무지개다리 — 레퍼런스에 있던 핵심 장면
    ("rainbow_bridge",
     f"{STYLE_PREFIX}"
     "a magnificent ethereal rainbow bridge stretching across a dreamy pastel sky, "
     "bridge made of soft glowing golden light with translucent rainbow colors, "
     "fluffy pastel pink and lavender clouds surrounding the bridge, "
     "tiny sparkles and flower petals floating in the air, "
     "a small white ghost puppy walking across the bridge towards the light, "
     "heavenly warm atmosphere, deeply emotional and serene"),

    # 4. 방 인테리어 — 감성 배경
    ("cozy_bedroom",
     f"{STYLE_PREFIX}"
     "a small cozy apartment bedroom bathed in soft overcast daylight, "
     "slightly messy but charming, sheer white curtains half-drawn, "
     "a desk with an open laptop and scattered papers, "
     "unmade bed with fluffy white comforter and pastel pillows, "
     "warm wooden floor, potted plants on windowsill, "
     "a small translucent ghost puppy sleeping on the bed, "
     "intimate personal atmosphere, lived-in warmth"),

    # 5. 유령 강아지 클로즈업 — 디테일 체크
    ("ghost_closeup",
     f"{STYLE_PREFIX}"
     "close-up portrait of an adorable small fluffy white ghost puppy, "
     "translucent ethereal glowing body with soft inner light, "
     "huge sparkling doe eyes reflecting starlight, "
     "tiny pink nose, soft fluffy fur with luminescent edges, "
     "surrounded by floating sparkles and tiny stars, "
     "gentle lavender and pink color aura, "
     "pure white background, incredibly detailed and cute"),

    # 6. 감성 장면 — 비 오는 창가
    ("rainy_window",
     f"{STYLE_PREFIX}"
     "a girl sitting by a rain-streaked window in the evening, "
     "warm indoor lighting against blue-gray rainy sky outside, "
     "she holds a warm cup of tea, looking contemplative, "
     "a small glowing ghost puppy curled up in her lap, "
     "raindrops creating soft patterns on the glass, "
     "cozy knitted blanket, scattered books nearby, "
     "melancholic yet warm atmosphere, bittersweet beauty"),

    # 7. 벚꽃 길 — 밝은 장면
    ("cherry_blossom",
     f"{STYLE_PREFIX}"
     "a dreamy cherry blossom tree-lined path in full bloom, "
     "soft pink petals gently falling through the air, "
     "a girl walking with a small glowing ghost puppy floating beside her, "
     "dappled sunlight filtering through pink canopy, "
     "path covered in fallen petals, "
     "distant mountains in soft lavender haze, "
     "spring breeze, joyful and peaceful mood"),

    # 8. 밤하늘 — 판타지 장면
    ("starry_night",
     f"{STYLE_PREFIX}"
     "a girl lying on a grassy hillside under a vast starry night sky, "
     "shooting stars streaking across deep indigo blue, "
     "a small glowing ghost puppy floating among the stars above her, "
     "wildflowers dotting the grass around her, "
     "soft moonlight illuminating the scene, "
     "magical constellation patterns, fireflies glowing, "
     "sense of wonder and infinite possibility"),
]

for i, (name, prompt) in enumerate(TESTS):
    t0 = time.time()
    # MPS NaN 방지 — 안전한 시드 사용
    seed = 2024 + i * 13

    img = pipe(
        prompt=prompt,
        negative_prompt=NEG,
        num_inference_steps=35,
        guidance_scale=8.0,
        height=SIZE,
        width=SIZE,
        generator=torch.Generator(device="cpu").manual_seed(seed),
    ).images[0]

    elapsed = time.time() - t0
    path = OUTPUT_DIR / f"{name}.png"
    img.save(path)
    fsize = path.stat().st_size
    status = "OK" if fsize > 5000 else "⚠️ BLACK"
    print(f"  [{i+1}/{len(TESTS)}] {name} — {elapsed:.1f}s ({fsize//1024}KB) {status}")

    # NaN 발생 시 다른 시드로 재시도
    if fsize <= 5000:
        print(f"    → 시드 변경 재시도...")
        for retry_seed in [seed + 100, seed + 200, seed + 333]:
            img2 = pipe(
                prompt=prompt,
                negative_prompt=NEG,
                num_inference_steps=35,
                guidance_scale=8.0,
                height=SIZE,
                width=SIZE,
                generator=torch.Generator(device="cpu").manual_seed(retry_seed),
            ).images[0]
            img2.save(path)
            if path.stat().st_size > 5000:
                print(f"    → seed={retry_seed} OK ({path.stat().st_size//1024}KB)")
                break
            gc.collect()
            torch.mps.empty_cache()

    gc.collect()
    torch.mps.empty_cache()

# Step 5: 배경 제거 (캐릭터 이미지)
print("\n[5/5] 배경 제거...")
try:
    from rembg import remove
    from PIL import Image
    nobg = OUTPUT_DIR / "no_background"
    nobg.mkdir(exist_ok=True)
    for name in ["ghost_dog_sheet", "ghost_closeup", "girl_with_ghost"]:
        f = OUTPUT_DIR / f"{name}.png"
        if f.exists() and f.stat().st_size > 5000:
            r = remove(Image.open(f))
            r.save(nobg / f.name)
            print(f"  {name} OK")
except Exception as e:
    print(f"  실패: {e}")

# 512 → 1024 업스케일 (Lanczos)
print("\n[BONUS] 1024 업스케일...")
from PIL import Image
upscaled = OUTPUT_DIR / "upscaled_1024"
upscaled.mkdir(exist_ok=True)
for f in OUTPUT_DIR.glob("*.png"):
    if f.name.startswith("_"):
        continue
    img = Image.open(f)
    if img.size[0] < 1024:
        img_up = img.resize((1024, 1024), Image.LANCZOS)
        img_up.save(upscaled / f.name)
up_count = len(list(upscaled.glob("*.png")))
print(f"  {up_count}장 업스케일 완료")

print("\n" + "=" * 60)
print(f"결과: {OUTPUT_DIR}")
print(f"해상도: {SIZE}x{SIZE} (원본) + 1024x1024 (업스케일)")
print("=" * 60)

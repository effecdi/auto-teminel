"""
IP-Adapter + SDXL PoC v3 — 메모리 최적화 버전
M4 16GB에서 안전하게 돌아가도록 최적화
"""
import torch
import gc
import time
from pathlib import Path

OUTPUT_DIR = Path.home() / "scenario-engine" / "ip_adapter_test"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

print("=" * 60)
print("IP-Adapter + SDXL PoC v3 (메모리 최적화)")
print("=" * 60)

device = "mps"
dtype = torch.float16
print(f"Device: {device}")

# Step 1: 파이프라인
print("\n[1/5] SDXL 로드...")
from diffusers import AutoPipelineForText2Image
pipe = AutoPipelineForText2Image.from_pretrained(
    "stabilityai/stable-diffusion-xl-base-1.0",
    torch_dtype=dtype,
    variant="fp16",
    use_safetensors=True,
)
pipe.to(device)
pipe.enable_attention_slicing("max")
pipe.enable_vae_slicing()
print("  SDXL OK")

# Step 2: IP-Adapter (image_encoder_folder=None으로 메모리 절약)
print("\n[2/5] IP-Adapter 로드...")
USE_IP = False
try:
    pipe.load_ip_adapter(
        "h94/IP-Adapter",
        subfolder="sdxl_models",
        weight_name="ip-adapter_sdxl.bin",
        image_encoder_folder=None,
    )
    pipe.set_ip_adapter_scale(0.6)
    print("  IP-Adapter OK (encoder=None, scale=0.6)")
    USE_IP = True
except Exception as e:
    print(f"  실패: {e}")
    print("  프롬프트만으로 진행")

gc.collect()
torch.mps.empty_cache()

# 프롬프트
CHAR = (
    "1girl, red hair, long ponytail, green eyes, silver knight armor, "
    "anime illustration style, full body, white background, "
    "high quality, game sprite asset, clean lines"
)
NEG = "low quality, worst quality, blurry, deformed, bad anatomy, extra fingers, watermark, text, photo, realistic"

# Step 3: 레퍼런스
print("\n[3/5] 레퍼런스 생성...")
t0 = time.time()
ref = pipe(
    prompt=CHAR + ", standing idle, front view",
    negative_prompt=NEG,
    num_inference_steps=20,
    guidance_scale=7.0,
    height=512, width=512,
    generator=torch.Generator(device="cpu").manual_seed(42),
).images[0]
print(f"  {time.time()-t0:.1f}초")
ref.save(OUTPUT_DIR / "00_reference.png")

# Step 4: 8포즈
print("\n[4/5] 8포즈 생성...")
POSES = [
    ("01_idle",   "standing idle, front view, arms at sides"),
    ("02_walk1",  "walking left foot forward, side view"),
    ("03_walk2",  "walking right foot forward, side view"),
    ("04_walk3",  "walking mid stride, side view"),
    ("05_walk4",  "walking feet together, side view"),
    ("06_run1",   "running dynamic, leaning forward, side view"),
    ("07_run2",   "running legs spread, side view"),
    ("08_attack", "sword attack swing, action pose, side view"),
]

for i, (name, pose) in enumerate(POSES):
    t0 = time.time()
    kw = dict(
        prompt=CHAR + f", {pose}",
        negative_prompt=NEG,
        num_inference_steps=20,
        guidance_scale=7.0,
        height=512, width=512,
        generator=torch.Generator(device="cpu").manual_seed(42 + i),
    )
    if USE_IP:
        kw["ip_adapter_image"] = ref

    img = pipe(**kw).images[0]
    img.save(OUTPUT_DIR / f"{name}.png")
    elapsed = time.time() - t0
    print(f"  [{i+1}/8] {name} — {elapsed:.1f}s")
    # 매 생성 후 캐시 정리
    gc.collect()
    torch.mps.empty_cache()

# 파이프라인 해제
del pipe
gc.collect()
torch.mps.empty_cache()

# Step 5: 배경 제거
print("\n[5/5] 배경 제거...")
BG = False
try:
    from rembg import remove
    from PIL import Image
    nobg = OUTPUT_DIR / "no_background"
    nobg.mkdir(exist_ok=True)
    for f in sorted(OUTPUT_DIR.glob("[0]*.png")):
        r = remove(Image.open(f))
        r.save(nobg / f.name)
        print(f"  {f.name} OK")
    BG = True
except Exception as e:
    print(f"  실패: {e}")

# 스프라이트 시트
print("\n[BONUS] 스프라이트 시트...")
from PIL import Image
src = OUTPUT_DIR / "no_background" if BG else OUTPUT_DIR
files = sorted(src.glob("[0]*.png"))[:9]  # ref + 8포즈
sheet = Image.new("RGBA", (512*3, 512*3), (0, 0, 0, 0))
for idx, f in enumerate(files):
    img = Image.open(f).convert("RGBA")
    sheet.paste(img, ((idx % 3) * 512, (idx // 3) * 512))
sheet.save(OUTPUT_DIR / "sprite_sheet.png")
print(f"  sprite_sheet.png OK")

print("\n" + "=" * 60)
print(f"결과: {OUTPUT_DIR}")
print(f"IP-Adapter: {'YES' if USE_IP else 'NO'}")
print("=" * 60)

"""
Scenario.com 파스텔 수채화 스타일 LoRA 학습
- Animagine XL 3.1 베이스
- 레퍼런스 28장에서 스타일 학습
- M4 16GB 최적화: fp16, batch 1, grad checkpoint, rank 8
"""
import os
import gc
import re
import math
import torch
import torch.nn.functional as F
from pathlib import Path
from PIL import Image
from torch.utils.data import Dataset, DataLoader
from tqdm import tqdm

# === 설정 ===
BASE_MODEL = "cagliostrolab/animagine-xl-3.1"
TRAIN_DIR = Path.home() / "scenario-engine" / "lora_train" / "images"
OUTPUT_DIR = Path.home() / "scenario-engine" / "lora_output"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

RESOLUTION = 512
BATCH_SIZE = 1
GRAD_ACCUM = 4
LEARNING_RATE = 1e-4
LORA_RANK = 8
LORA_ALPHA = 16
MAX_TRAIN_STEPS = 800  # 28장 × ~28 epochs
SAVE_EVERY = 200
SEED = 42

device = "mps"
dtype = torch.float16

print("=" * 60)
print("스타일 LoRA 학습 — Scenario.com 파스텔 수채화")
print("=" * 60)
print(f"Base: {BASE_MODEL}")
print(f"Images: {TRAIN_DIR}")
print(f"Resolution: {RESOLUTION}")
print(f"LoRA rank: {LORA_RANK}, alpha: {LORA_ALPHA}")
print(f"Steps: {MAX_TRAIN_STEPS}, LR: {LEARNING_RATE}")
print(f"Batch: {BATCH_SIZE} × grad_accum {GRAD_ACCUM}")

# === Step 1: 캡션 생성 (파일명에서 추출) ===
print("\n[1/5] 캡션 추출...")

def extract_caption(filename):
    """파일명에서 Scenario.com 프롬프트 추출"""
    # asset_XXXXX_프롬프트.png 형식
    name = Path(filename).stem
    # asset ID 제거
    parts = name.split("_", 2)
    if len(parts) >= 3:
        caption = parts[2]
    else:
        caption = name
    # 파일명 특수문자 정리
    caption = caption.replace("_", " ").replace("  ", " ").strip()
    # 너무 길면 자르기 (CLIP 77토큰 제한)
    words = caption.split()
    if len(words) > 60:
        caption = " ".join(words[:60])
    return caption

image_files = sorted(TRAIN_DIR.glob("*.*"))
image_files = [f for f in image_files if f.suffix.lower() in ('.png', '.jpg', '.jpeg')]
print(f"  {len(image_files)}장 발견")

# 캡션 파일 저장
for f in image_files:
    caption = extract_caption(f.name)
    caption_file = f.with_suffix(".txt")
    caption_file.write_text(caption)

print(f"  캡션 {len(image_files)}개 생성")

# === Step 2: 모델 로드 ===
print("\n[2/5] 모델 로드...")
from diffusers import StableDiffusionXLPipeline, DDPMScheduler
from transformers import CLIPTextModel, CLIPTextModelWithProjection, CLIPTokenizer
from diffusers import AutoencoderKL, UNet2DConditionModel

# 개별 컴포넌트 로드 (메모리 절약)
tokenizer = CLIPTokenizer.from_pretrained(BASE_MODEL, subfolder="tokenizer")
tokenizer_2 = CLIPTokenizer.from_pretrained(BASE_MODEL, subfolder="tokenizer_2")
text_encoder = CLIPTextModel.from_pretrained(BASE_MODEL, subfolder="text_encoder", torch_dtype=dtype)
text_encoder_2 = CLIPTextModelWithProjection.from_pretrained(BASE_MODEL, subfolder="text_encoder_2", torch_dtype=dtype)
vae = AutoencoderKL.from_pretrained(BASE_MODEL, subfolder="vae", torch_dtype=dtype)
unet = UNet2DConditionModel.from_pretrained(BASE_MODEL, subfolder="unet", torch_dtype=dtype)
noise_scheduler = DDPMScheduler.from_pretrained(BASE_MODEL, subfolder="scheduler")

text_encoder.to(device)
text_encoder_2.to(device)
vae.to(device)
unet.to(device)

# Freeze everything except LoRA
text_encoder.requires_grad_(False)
text_encoder_2.requires_grad_(False)
vae.requires_grad_(False)
unet.requires_grad_(False)

print("  모델 로드 OK")

# === Step 3: LoRA 적용 ===
print("\n[3/5] LoRA 적용...")
from peft import LoraConfig, get_peft_model

# UNet에만 LoRA 적용
unet_lora_config = LoraConfig(
    r=LORA_RANK,
    lora_alpha=LORA_ALPHA,
    init_lora_weights="gaussian",
    target_modules=[
        "to_k", "to_q", "to_v", "to_out.0",
        "proj_in", "proj_out",
        "ff.net.0.proj", "ff.net.2",
    ],
)

unet = get_peft_model(unet, unet_lora_config)
unet.print_trainable_parameters()

# gradient checkpointing
unet.enable_gradient_checkpointing()
print("  LoRA + gradient checkpointing OK")

# === Step 4: 데이터셋 ===
class StyleDataset(Dataset):
    def __init__(self, image_dir, resolution):
        self.files = sorted(Path(image_dir).glob("*.*"))
        self.files = [f for f in self.files if f.suffix.lower() in ('.png', '.jpg', '.jpeg')]
        self.resolution = resolution
        from torchvision import transforms
        self.transform = transforms.Compose([
            transforms.Resize(resolution, interpolation=transforms.InterpolationMode.LANCZOS),
            transforms.CenterCrop(resolution),
            transforms.ToTensor(),
            transforms.Normalize([0.5], [0.5]),
        ])

    def __len__(self):
        return len(self.files)

    def __getitem__(self, idx):
        img_path = self.files[idx]
        image = Image.open(img_path).convert("RGB")
        pixel_values = self.transform(image)

        # 캡션 로드
        caption_path = img_path.with_suffix(".txt")
        if caption_path.exists():
            caption = caption_path.read_text().strip()
        else:
            caption = "pastel watercolor style illustration"

        return {"pixel_values": pixel_values, "caption": caption}

dataset = StyleDataset(TRAIN_DIR, RESOLUTION)
dataloader = DataLoader(dataset, batch_size=BATCH_SIZE, shuffle=True, num_workers=0)
print(f"  데이터셋: {len(dataset)}장")

# === Step 5: 학습 ===
print("\n[4/5] 학습 시작...")

# Optimizer
trainable_params = [p for p in unet.parameters() if p.requires_grad]
optimizer = torch.optim.AdamW(trainable_params, lr=LEARNING_RATE, weight_decay=1e-2)

# LR scheduler
lr_scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=MAX_TRAIN_STEPS)

def encode_prompt(prompt, tokenizer_1, tokenizer_2, text_enc_1, text_enc_2):
    """SDXL 이중 텍스트 인코딩"""
    with torch.no_grad():
        tokens_1 = tokenizer_1(prompt, padding="max_length", max_length=77, truncation=True, return_tensors="pt")
        tokens_2 = tokenizer_2(prompt, padding="max_length", max_length=77, truncation=True, return_tensors="pt")

        enc_1 = text_enc_1(tokens_1.input_ids.to(device), output_hidden_states=True)
        enc_2 = text_enc_2(tokens_2.input_ids.to(device), output_hidden_states=True)

        prompt_embeds = torch.concat([enc_1.hidden_states[-2], enc_2.hidden_states[-2]], dim=-1)
        pooled = enc_2.text_embeds
    return prompt_embeds, pooled

torch.manual_seed(SEED)
global_step = 0
losses = []

unet.train()

while global_step < MAX_TRAIN_STEPS:
    for batch in dataloader:
        if global_step >= MAX_TRAIN_STEPS:
            break

        pixel_values = batch["pixel_values"].to(device, dtype=dtype)
        caption = batch["caption"][0]  # batch_size=1

        # VAE encode
        with torch.no_grad():
            latents = vae.encode(pixel_values).latent_dist.sample()
            latents = latents * vae.config.scaling_factor

        # Noise
        noise = torch.randn_like(latents)
        timesteps = torch.randint(0, noise_scheduler.config.num_train_timesteps, (BATCH_SIZE,), device=device).long()
        noisy_latents = noise_scheduler.add_noise(latents, noise, timesteps)

        # Text encode
        prompt_embeds, pooled = encode_prompt(caption, tokenizer, tokenizer_2, text_encoder, text_encoder_2)

        # SDXL time_ids
        add_time_ids = torch.tensor([[RESOLUTION, RESOLUTION, 0, 0, RESOLUTION, RESOLUTION]], dtype=dtype, device=device)
        added_cond_kwargs = {"text_embeds": pooled, "time_ids": add_time_ids}

        # Predict noise
        model_pred = unet(
            noisy_latents.to(dtype),
            timesteps,
            encoder_hidden_states=prompt_embeds.to(dtype),
            added_cond_kwargs=added_cond_kwargs,
        ).sample

        # Loss
        loss = F.mse_loss(model_pred.float(), noise.float(), reduction="mean")
        loss = loss / GRAD_ACCUM
        loss.backward()

        if (global_step + 1) % GRAD_ACCUM == 0:
            torch.nn.utils.clip_grad_norm_(trainable_params, 1.0)
            optimizer.step()
            lr_scheduler.step()
            optimizer.zero_grad()

        current_loss = loss.item() * GRAD_ACCUM
        losses.append(current_loss)
        global_step += 1

        if global_step % 10 == 0:
            avg_loss = sum(losses[-50:]) / min(len(losses), 50)
            print(f"  step {global_step}/{MAX_TRAIN_STEPS} — loss: {current_loss:.4f} (avg: {avg_loss:.4f})")

        # 체크포인트 저장
        if global_step % SAVE_EVERY == 0:
            save_path = OUTPUT_DIR / f"checkpoint-{global_step}"
            save_path.mkdir(exist_ok=True)
            unet.save_pretrained(save_path)
            print(f"  💾 체크포인트 저장: {save_path}")

        # 메모리 정리
        if global_step % 50 == 0:
            gc.collect()
            torch.mps.empty_cache()

# 최종 저장
print("\n[5/5] 최종 LoRA 저장...")
final_path = OUTPUT_DIR / "final"
final_path.mkdir(exist_ok=True)
unet.save_pretrained(final_path)

# loss 기록
with open(OUTPUT_DIR / "training_log.txt", "w") as f:
    for i, l in enumerate(losses):
        f.write(f"step {i+1}: {l:.6f}\n")

print(f"\n{'='*60}")
print(f"학습 완료!")
print(f"LoRA 저장: {final_path}")
print(f"최종 loss: {losses[-1]:.4f}")
print(f"평균 loss (last 50): {sum(losses[-50:])/min(len(losses),50):.4f}")
print(f"{'='*60}")
